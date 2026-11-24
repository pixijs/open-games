/**
 * NIGHT RUN's signalling service, a Cloudflare Worker. Players use it only to find each other.
 * Trystero, in the game, posts each player's encrypted connection offer to topics here; once two
 * browsers have each other's offer, WebRTC links them directly and the game's traffic never comes
 * back through Cloudflare.
 *
 * `GET /signal` opens a WebSocket on {@link SignalHub}, which speaks Trystero's ws-relay protocol.
 * The client sends `{ type: 'subscribe' | 'unsubscribe', topic }` or `{ type: 'publish', topic, payload }`,
 * and every subscriber of a topic receives `{ topic, payload }`.
 *
 * It holds no secrets and hands out no credentials. Only pages from `ALLOWED_ORIGINS` may call it, each network
 * gets a few calls a minute and a few open sockets, so no one caller can spend the free tier's daily requests or
 * take every socket. `README.md` covers setup and deploying.
 */

import { DurableObject } from 'cloudflare:workers';

interface Env {
  HUB: DurableObjectNamespace<SignalHub>;
  CONNECT_LIMIT: RateLimit;
  /** Comma-separated origins of the pages allowed to call the Worker */
  ALLOWED_ORIGINS: string;
}

type ClientMessage =
  { type: 'subscribe' | 'unsubscribe'; topic: string } | { type: 'publish'; topic: string; payload: unknown };

/** Headroom for many parties forming at once; four players each hold one socket */
const MAX_SOCKETS = 2000;
/** A household, office or school shares one address, and each tab holds one socket */
const MAX_SOCKETS_PER_NETWORK = 16;
/** Trystero subscribes a player to two topics a party: the party's own and the player's own */
const MAX_TOPICS = 8;
const MAX_TOPIC_LENGTH = 256;
/** An encrypted SDP offer is a few thousand characters */
const MAX_MESSAGE_LENGTH = 32 * 1024;
/** Joining sends a burst of announcements, offers and answers, then one announcement a minute */
const MESSAGE_LIMIT = 120;
const MESSAGE_WINDOW_MS = 60_000;

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const origin = request.headers.get('Origin') ?? '';

    const allowed = env.ALLOWED_ORIGINS.split(',').map((entry) => entry.trim());

    if (!origin || !allowed.includes(origin)) {
      return new Response('Forbidden', { status: 403 });
    }
    const headers = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    const { success } = await env.CONNECT_LIMIT.limit({ key: networkOf(request) });

    if (!success) return new Response('Too many requests', { status: 429, headers });
    if (pathname === '/signal' && request.headers.get('Upgrade') === 'websocket') {
      return env.HUB.getByName('hub').fetch(request);
    }

    return new Response('Not found', { status: 404, headers });
  },
} satisfies ExportedHandler<Env>;

/**
 * Who a limit counts against: the caller's IPv4 address, or the /64 of its IPv6 address, since one household or
 * phone is handed a whole /64 and could otherwise pass as millions of callers
 */
function networkOf(request: Request): string {
  const ip = (request.headers.get('CF-Connecting-IP') ?? '').toLowerCase();

  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];

  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** The topics a socket subscribes to, kept in its attachment so they survive hibernation */
function topicsOf(socket: WebSocket): string[] {
  return (socket.deserializeAttachment() as string[] | null) ?? [];
}

function parse(data: string): ClientMessage | null {
  try {
    const message = JSON.parse(data) as Partial<Record<'type' | 'topic' | 'payload', unknown>>;
    const { type, topic, payload } = message;

    if (typeof topic !== 'string') return null;
    if (type === 'subscribe' || type === 'unsubscribe') return { type, topic };
    if (type === 'publish' && payload !== undefined) return { type, topic, payload };
  } catch {
    // Not JSON: ignored, as Trystero's own relay does.
  }

  return null;
}

/**
 * Passes Trystero's signalling messages between the players subscribed to each topic. A topic is
 * a hash of the party's code, or of one player's id, so parties never see each other's messages.
 *
 * One object serves every party: a handshake is a handful of small messages, and Trystero keeps
 * one socket per signalling URL for the tab's lifetime, which rules out an object per party code.
 * Sockets are accepted through the Hibernation API, so the object sleeps, and costs nothing,
 * between messages. The constructor rebuilds the topic lookup when it wakes.
 */
export class SignalHub extends DurableObject<Env> {
  private readonly _subscribers = new Map<string, Set<WebSocket>>();
  /** Messages each socket sent this window; forgetting them while the object sleeps is fine, since it only sleeps when nobody sends */
  private readonly _rates = new Map<WebSocket, { count: number; start: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const socket of ctx.getWebSockets()) {
      for (const topic of topicsOf(socket)) this._add(topic, socket);
    }
  }

  public override fetch(request: Request): Response {
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response('Busy', { status: 503 });
    const network = networkOf(request);

    if (this.ctx.getWebSockets(network).length >= MAX_SOCKETS_PER_NETWORK) {
      return new Response('Too many connections', { status: 429 });
    }
    const { 0: client, 1: server } = new WebSocketPair();

    // Tagged with its network, so the count above finds a network's sockets, even after hibernation.
    this.ctx.acceptWebSocket(server, [network]);
    server.serializeAttachment([]);

    return new Response(null, { status: 101, webSocket: client });
  }

  public override webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): void {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE_LENGTH || !this._allow(socket)) {
      this._refuse(socket, 'message refused');

      return;
    }
    const message = parse(data);

    if (!message) return;
    const { topic } = message;

    if (topic.length > MAX_TOPIC_LENGTH) {
      this._refuse(socket, 'topic too long');
    } else if (message.type === 'publish') {
      const text = JSON.stringify({ topic, payload: message.payload });

      for (const subscriber of this._subscribers.get(topic) ?? []) {
        // A socket closing right now throws on send, before its close event has removed it.
        try {
          subscriber.send(text);
        } catch {
          this._forget(subscriber);
        }
      }
    } else if (message.type === 'subscribe') {
      const topics = topicsOf(socket);

      if (topics.includes(topic)) return;
      if (topics.length >= MAX_TOPICS) {
        this._refuse(socket, 'too many topics');

        return;
      }
      socket.serializeAttachment([...topics, topic]);
      this._add(topic, socket);
    } else {
      socket.serializeAttachment(topicsOf(socket).filter((subscribed) => subscribed !== topic));
      this._remove(topic, socket);
    }
  }

  public override webSocketClose(socket: WebSocket): void {
    this._forget(socket);
  }

  public override webSocketError(socket: WebSocket): void {
    this._forget(socket);
  }

  private _add(topic: string, socket: WebSocket): void {
    let sockets = this._subscribers.get(topic);

    if (!sockets) this._subscribers.set(topic, (sockets = new Set()));
    sockets.add(socket);
  }

  private _remove(topic: string, socket: WebSocket): void {
    const sockets = this._subscribers.get(topic);

    sockets?.delete(socket);
    if (sockets?.size === 0) this._subscribers.delete(topic);
  }

  private _forget(socket: WebSocket): void {
    for (const topic of topicsOf(socket)) this._remove(topic, socket);
    this._rates.delete(socket);
  }

  private _refuse(socket: WebSocket, reason: string): void {
    this._forget(socket);
    socket.close(1008, reason);
  }

  /** Counts a message against the socket's allowance for the current window */
  private _allow(socket: WebSocket): boolean {
    const now = Date.now();
    const rate = this._rates.get(socket);

    if (!rate || now - rate.start >= MESSAGE_WINDOW_MS) {
      this._rates.set(socket, { count: 1, start: now });

      return true;
    }

    return ++rate.count <= MESSAGE_LIMIT;
  }
}
