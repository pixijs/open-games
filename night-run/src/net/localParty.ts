/**
 * A {@link PartyRoom} over a BroadcastChannel, for `?signal=local`: tabs of one browser find each
 * other with no WebRTC and no network, so a party can be played and tested in several tabs, or by
 * several pages of one Playwright context.
 *
 * It behaves as Trystero does where the links care: every tab in the party's channel meets every
 * other one, a peer keeps its id for the page's lifetime (so a guest that drops and comes back is
 * the same peer), and a peer that goes quiet is reported gone after a few seconds, as a closed
 * tab would be.
 *
 * Given `failLinks`, it plays a network that blocks WebRTC: peers find each other but never link,
 * and each one met is reported through it, as Trystero's `onJoinError` would.
 */

import type { PartyAction, PartyRoom } from './wire';

type Packet =
  /** A peer arrived; everyone already there answers with `here` */
  | { k: 'hi'; from: string }
  | { k: 'here'; from: string; to: string }
  /** Sent every second, so a tab that vanished without `bye` is noticed */
  | { k: 'beat'; from: string }
  | { k: 'bye'; from: string }
  | { k: 'data'; from: string; to: string; ns: string; data: Uint8Array };

/** This page's peer id, kept across leaving and rejoining as Trystero's `selfId` is */
const SELF_ID = crypto.randomUUID();
const BEAT_MS = 1000;
const SILENT_MS = 3500;

class LocalParty implements PartyRoom {
  public onPeerJoin: ((peerId: string) => void) | null = null;
  public onPeerLeave: ((peerId: string) => void) | null = null;
  private readonly _channel: BroadcastChannel;
  /** When each peer was last heard from, in `performance.now()` milliseconds */
  private readonly _heard = new Map<string, number>();
  private readonly _actions = new Map<string, PartyAction>();
  private readonly _beat: ReturnType<typeof setInterval>;
  private _left = false;
  private readonly _failLinks: (() => void) | null;

  constructor(name: string, failLinks: (() => void) | null) {
    this._failLinks = failLinks;
    this._channel = new BroadcastChannel(name);
    this._channel.onmessage = (event: MessageEvent<Packet>) => this._receive(event.data);
    this._post({ k: 'hi', from: SELF_ID });
    this._beat = setInterval(() => {
      this._post({ k: 'beat', from: SELF_ID });
      const now = performance.now();

      for (const [peerId, at] of this._heard) if (now - at > SILENT_MS) this._gone(peerId);
    }, BEAT_MS);
    addEventListener('pagehide', this._sayBye);
  }

  public makeAction(namespace: string): PartyAction {
    const action: PartyAction = {
      send: (data, { target }) => {
        if (this._heard.has(target)) this._post({ k: 'data', from: SELF_ID, to: target, ns: namespace, data });

        return Promise.resolve();
      },
      onMessage: null,
    };

    this._actions.set(namespace, action);

    return action;
  }

  public leave(): Promise<void> {
    if (this._left) return Promise.resolve();
    this._sayBye();
    this._left = true;
    removeEventListener('pagehide', this._sayBye);
    clearInterval(this._beat);
    this._channel.onmessage = null;
    this._channel.close();
    this._heard.clear();
    this._actions.clear();

    return Promise.resolve();
  }

  private readonly _sayBye = (): void => this._post({ k: 'bye', from: SELF_ID });

  private _post(packet: Packet): void {
    if (!this._left) this._channel.postMessage(packet);
  }

  private _receive(packet: Packet): void {
    if (packet.from === SELF_ID) return;
    if (this._failLinks) {
      if (packet.k === 'hi' || packet.k === 'here') this._failLinks();

      return;
    }
    if (packet.k === 'bye') {
      this._gone(packet.from);

      return;
    }
    if ((packet.k === 'here' || packet.k === 'data') && packet.to !== SELF_ID) return;
    // A peer saying hi again rejoined before its goodbye arrived: it left in between.
    if (packet.k === 'hi') this._gone(packet.from);
    const known = this._heard.has(packet.from);

    this._heard.set(packet.from, performance.now());
    if (!known) {
      // A peer heard for the first time, or again after going quiet, has just arrived.
      if (packet.k !== 'here') this._post({ k: 'here', from: SELF_ID, to: packet.from });
      this.onPeerJoin?.(packet.from);
    }
    if (packet.k === 'data') this._actions.get(packet.ns)?.onMessage?.(packet.data, { peerId: packet.from });
  }

  private _gone(peerId: string): void {
    if (!this._heard.delete(peerId)) return;
    this.onPeerLeave?.(peerId);
  }
}

/** Joins the party `code` among this browser's tabs; `failLinks` makes every link fail */
export function joinLocalParty(appId: string, code: string, failLinks: (() => void) | null = null): PartyRoom {
  return new LocalParty(`${appId}:${code}`, failLinks);
}
