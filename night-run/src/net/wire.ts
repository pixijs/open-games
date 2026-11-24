/**
 * Wires: the links between a player's Colyseus client and the host's Colyseus server, which both
 * run in browser tabs.
 *
 * A wire carries two kinds of message: small JSON control messages (finding the host, reserving a
 * seat, opening and closing a socket) and binary frames of a socket's traffic, tagged with the
 * socket's id. The client side (`socket.ts`) and the server side (`transport.ts`) only see this
 * interface, so the same code runs over either kind of wire:
 *
 * - {@link loopback}: two ends in one tab, for the host's own player and for solo;
 * - {@link PeerLinks}: one wire per remote peer, over a {@link PartyRoom}: a Trystero (WebRTC)
 *   data channel, or the BroadcastChannel stand-in of `localParty.ts`. Every message is one action
 *   frame with a three-byte header: the kind, then the socket id. Trystero sends a frame under its
 *   16 KB limit synchronously and in order, but streams a larger one behind a handshake that later
 *   frames can overtake, so a big payload is cut into pieces here and joined again on the other
 *   side.
 */

import type { SeatReservation } from '@colyseus/sdk';

/** What a player tells the host's matchmaker when it asks for a seat */
export interface JoinOptions {
  /** Shown to the other players; trimmed and capped by the host */
  name: string;
  /** The truck colour the player would like, 0 to 3; the room gives the nearest free one */
  car?: number;
  /** Set by the host's own transport for its own player; a remote peer's claim is ignored */
  host?: boolean;
  /**
   * The reconnection token of a seat this player held in the party before their page reloaded:
   * the host hands that seat back, truck and all, while it still waits for them
   */
  rejoin?: string;
  /** The protocol this page speaks (`PROTOCOL` in messages.ts); the room turns away a guest without the host's own */
  proto?: number;
}

export type Ctl =
  /** Host to peer: this peer is the host, and the party's code */
  | { t: 'hello'; code: string }
  /** Host to peer: the host is closing the party */
  | { t: 'bye' }
  /** Host to peer, every two seconds: the host is still there */
  | { t: 'beat' }
  /** Peer to host: reserve a seat in the party's room */
  | { t: 'seat'; id: number; options: JoinOptions }
  | { t: 'seated'; id: number; reservation?: SeatReservation; error?: { code: number; message: string } }
  | { t: 'open'; sid: number; url: string }
  | { t: 'close'; sid: number; code: number; reason: string };

/** One named channel of a {@link PartyRoom}: binary frames to one peer, and frames from any */
export interface PartyAction {
  send(data: Uint8Array, options: { target: string }): Promise<void>;
  /** Trystero hands binary frames over as either type */
  onMessage: ((data: Uint8Array | ArrayBuffer, context: { peerId: string }) => void) | null;
}

/**
 * The part of a Trystero room the links use: peers arriving and leaving, and one action to talk
 * over. `signal.ts` hands out a real Trystero room or, with `?signal=local`, `localParty.ts`'s
 */
export interface PartyRoom {
  makeAction(namespace: string): PartyAction;
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
  leave(): Promise<void>;
}

export interface Wire {
  sendCtl(msg: Ctl): void;
  sendBin(sid: number, data: Uint8Array): void;
  onCtl: ((msg: Ctl) => void) | null;
  onBin: ((sid: number, data: Uint8Array) => void) | null;
}

function emptyWire(): Wire {
  return { sendCtl() {}, sendBin() {}, onCtl: null, onBin: null };
}

/**
 * Two in-memory wire ends. Delivery waits a microtask, as a network would, so a send never runs
 * the other side's handler inside the sender's call stack; binary frames are copied because
 * Colyseus reuses its encode buffer
 */
export function loopback(): [Wire, Wire] {
  const a = emptyWire();
  const b = emptyWire();
  const link = (from: Wire, to: Wire): void => {
    from.sendCtl = (msg) => {
      const copy = JSON.parse(JSON.stringify(msg)) as Ctl;

      queueMicrotask(() => to.onCtl?.(copy));
    };
    from.sendBin = (sid, data) => {
      const copy = data.slice();

      queueMicrotask(() => to.onBin?.(sid, copy));
    };
  };

  link(a, b);
  link(b, a);

  return [a, b];
}

const KIND_CTL = 0;
const KIND_LAST = 1;
const KIND_MORE = 2;
const HEADER = 3;
/** Comfortably under Trystero's 16 KB inline frame, with room for its own header */
const PIECE = 15000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(kind: number, sid: number, payload: Uint8Array, start: number, end: number): Uint8Array {
  const out = new Uint8Array(HEADER + end - start);

  out[0] = kind;
  out[1] = sid & 0xff;
  out[2] = sid >>> 8;
  out.set(payload.subarray(start, end), HEADER);

  return out;
}

/** A remote peer's wire, live while its data channel is */
export interface PeerLink {
  readonly peerId: string;
  readonly wire: Wire;
  /** False once the peer has left; a wire that's down drops what it's sent */
  up: boolean;
}

/**
 * One {@link Wire} per peer in a Trystero room, multiplexed over a single action. Links outlive a
 * dropped data channel: when the same peer comes back, its old link goes up again, so a client's
 * reconnection finds the wire it used before
 */
export class PeerLinks {
  public onPeerJoin: ((link: PeerLink) => void) | null = null;
  public onPeerLeave: ((link: PeerLink) => void) | null = null;
  private readonly _links = new Map<string, PeerLink & { pieces: Map<number, Uint8Array[]> }>();
  private readonly _send: (data: Uint8Array, peerId: string) => void;

  constructor(room: PartyRoom) {
    const action = room.makeAction('nr');

    this._send = (data, peerId) => void action.send(data, { target: peerId }).catch(() => {});
    action.onMessage = (data, { peerId }) => this._receive(peerId, data);
    room.onPeerJoin = (peerId) => {
      const link = this._link(peerId);

      link.up = true;
      this.onPeerJoin?.(link);
    };
    room.onPeerLeave = (peerId) => {
      const link = this._links.get(peerId);

      if (!link?.up) return;
      link.up = false;
      link.pieces.clear();
      this.onPeerLeave?.(link);
    };
  }

  /** How many peers are connected */
  public upCount(): number {
    let count = 0;

    for (const link of this._links.values()) if (link.up) count++;

    return count;
  }

  /** Sends a control message to every peer whose link is up */
  public broadcast(msg: Ctl): void {
    for (const link of this._links.values()) if (link.up) link.wire.sendCtl(msg);
  }

  private _link(peerId: string): PeerLink & { pieces: Map<number, Uint8Array[]> } {
    let link = this._links.get(peerId);

    if (link) return link;
    const wire = emptyWire();
    const created = { peerId, wire, up: false, pieces: new Map<number, Uint8Array[]>() };

    wire.sendCtl = (msg) => {
      if (!created.up) return;
      const bytes = encoder.encode(JSON.stringify(msg));

      this._send(frame(KIND_CTL, 0, bytes, 0, bytes.length), peerId);
    };
    wire.sendBin = (sid, data) => {
      if (!created.up) return;
      for (let start = 0; ; start += PIECE) {
        const end = Math.min(start + PIECE, data.length);
        const last = end === data.length;

        this._send(frame(last ? KIND_LAST : KIND_MORE, sid, data, start, end), peerId);
        if (last) break;
      }
    };
    link = created;
    this._links.set(peerId, link);

    return link;
  }

  private _receive(peerId: string, data: Uint8Array | ArrayBuffer): void {
    const link = this._links.get(peerId);

    if (!link?.up) return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

    if (bytes.length < HEADER) return;
    const kind = bytes[0];
    const sid = bytes[1] | (bytes[2] << 8);
    const body = bytes.subarray(HEADER);

    if (kind === KIND_CTL) {
      link.wire.onCtl?.(JSON.parse(decoder.decode(body)) as Ctl);

      return;
    }
    const held = link.pieces.get(sid);

    if (kind === KIND_MORE) {
      if (held) held.push(body);
      else link.pieces.set(sid, [body]);

      return;
    }
    if (!held) {
      link.wire.onBin?.(sid, body);

      return;
    }
    held.push(body);
    link.pieces.delete(sid);
    const whole = new Uint8Array(held.reduce((sum, piece) => sum + piece.length, 0));
    let offset = 0;

    for (const piece of held) {
      whole.set(piece, offset);
      offset += piece.length;
    }
    link.wire.onBin?.(sid, whole);
  }
}
