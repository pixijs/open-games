/**
 * The client half of the in-tab network: it lets the official `@colyseus/sdk` talk to a room over
 * a {@link Wire} without knowing it.
 *
 * Each server the SDK can reach is given a made-up hostname (`self.nightrun`, `host.nightrun`),
 * and `WebSocket` is wrapped so a socket to one of those hostnames opens over that server's wire
 * instead of the network. Any other URL gets the browser's own WebSocket, untouched. The SDK keeps
 * the `WebSocket` it finds when its module evaluates, so `shims/globals.ts` imports this file
 * before any Colyseus code loads.
 *
 * Matchmaking skips HTTP too: {@link reserveSeat} asks the host over the wire, and the SDK's
 * `consumeSeatReservation()` takes it from there, reconnection included.
 */

import type { SeatReservation } from '@colyseus/sdk';

import type { Ctl, JoinOptions, Wire } from './wire';

const ABNORMAL = 1006;

/** Each wire's open sockets, by socket id */
const routes = new Map<string, { wire: Wire; sockets: Map<number, WireWebSocket> }>();
const pending = new Map<number, { resolve: (reservation: SeatReservation) => void; reject: (error: Error) => void }>();
let nextSid = 1;
let nextRequest = 1;
/** Where control messages from a host go when they aren't the socket layer's own */
let onHostCtl: ((msg: Ctl) => void) | null = null;

interface CloseEventLike {
  code: number;
  reason: string;
  wasClean: boolean;
}

/** A WebSocket over a wire, with just the surface the SDK's WebSocket transport uses */
class WireWebSocket {
  public readyState = 0;
  public binaryType = 'arraybuffer';
  public onopen: ((event: object) => void) | null = null;
  public onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  public onclose: ((event: CloseEventLike) => void) | null = null;
  public onerror: ((event: object) => void) | null = null;
  private readonly _sid = nextSid++;

  constructor(
    private readonly _route: { wire: Wire; sockets: Map<number, WireWebSocket> },
    public readonly url: string,
    up: boolean,
  ) {
    _route.sockets.set(this._sid, this);
    if (up) _route.wire.sendCtl({ t: 'open', sid: this._sid, url });
    // A real socket never opens or fails inside its constructor; the SDK sets its handlers after.
    queueMicrotask(() => {
      if (!up) this._closed(ABNORMAL, 'no connection to the host');
      else if (this.readyState === 0) {
        this.readyState = 1;
        this.onopen?.({});
      }
    });
  }

  public send(data: ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 1) return;
    this._route.wire.sendBin(this._sid, data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  public close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this._route.wire.sendCtl({ t: 'close', sid: this._sid, code, reason });
    this._closed(code, reason);
  }

  public _receive(data: Uint8Array): void {
    if (this.readyState !== 1) return;
    const buffer =
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer;

    this.onmessage?.({ data: buffer as ArrayBuffer });
  }

  public _closed(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._route.sockets.delete(this._sid);
    this.onclose?.({ code, reason, wasClean: code !== ABNORMAL });
  }
}

const NativeWebSocket = globalThis.WebSocket;
/** Hostnames whose wire is currently down: sockets to them fail at once so the SDK retries */
const down = new Set<string>();

globalThis.WebSocket = new Proxy(NativeWebSocket, {
  construct(target, args: [string | URL, unknown?]) {
    const url = String(args[0]);
    const route = routes.get(new URL(url).hostname);

    if (route) return new WireWebSocket(route, url, !down.has(new URL(url).hostname));

    // The SDK first tries Node's `(url, { headers })` form; the browser's own socket throws on it.
    return Reflect.construct(target, args);
  },
});

/**
 * Routes the SDK's sockets for `hostname` over `wire`, and the host's seat replies to
 * {@link reserveSeat}. Call it again with a new wire when a link is rebuilt
 */
export function attachWire(hostname: string, wire: Wire): void {
  const previous = routes.get(hostname);
  const route = { wire, sockets: previous?.sockets ?? new Map<number, WireWebSocket>() };

  routes.set(hostname, route);
  wire.onCtl = (msg: Ctl) => {
    if (msg.t === 'seated') {
      const request = pending.get(msg.id);

      pending.delete(msg.id);
      if (msg.reservation) request?.resolve(msg.reservation);
      else request?.reject(Object.assign(new Error(msg.error?.message ?? 'no seat'), { code: msg.error?.code ?? 0 }));
    } else if (msg.t === 'close') {
      route.sockets.get(msg.sid)?._closed(msg.code, msg.reason);
    } else {
      onHostCtl?.(msg);
    }
  };
  wire.onBin = (sid, data) => route.sockets.get(sid)?._receive(data);
}

/**
 * Marks a hostname's wire as down or up. Going down closes its sockets as a cut network would,
 * which starts the SDK's reconnection; while it's down, new sockets fail straight away
 */
export function setWireUp(hostname: string, up: boolean): void {
  if (up) {
    down.delete(hostname);

    return;
  }
  down.add(hostname);
  const route = routes.get(hostname);

  if (route) for (const socket of route.sockets.values()) socket._closed(ABNORMAL, 'connection lost');
}

/** Forgets a hostname, closing anything still open on it */
export function detachWire(hostname: string): void {
  setWireUp(hostname, false);
  down.delete(hostname);
  routes.delete(hostname);
}

/** Hands the host's `hello`, `beat` and `bye` messages to `handler` */
export function setHostCtlHandler(handler: ((msg: Ctl) => void) | null): void {
  onHostCtl = handler;
}

/** Asks the host at the other end of `wire` for a seat in the party's room */
export function reserveSeat(wire: Wire, options: JoinOptions, timeoutMs = 10000): Promise<SeatReservation> {
  const id = nextRequest++;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The host did not answer'));
    }, timeoutMs);

    pending.set(id, {
      resolve: (reservation) => {
        clearTimeout(timer);
        resolve(reservation);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    wire.sendCtl({ t: 'seat', id, options });
  });
}
