/**
 * The server half of the in-tab network: it hands players arriving over a {@link Wire} to the
 * host's Colyseus room, the way `@colyseus/ws-transport` hands it players arriving over WebSockets.
 *
 * A player first asks for a seat with a `seat` control message, which the host's matchmaker
 * answers with a seat reservation in the one room the party plays in. The player's SDK then opens
 * a socket over the same wire (`open`), and from there each socket's binary frames go straight to
 * and from Colyseus. When a wire goes down, every socket on it closes as abnormally as a cut
 * network would, so the room's `onDrop` and reconnection run as they do on a real server.
 */

import { CloseCode, connectClientToRoom, createAuthContext, matchMaker } from '@colyseus/core';

import type { JoinOptions, Wire } from './wire';
import { WireClient } from './WireClient';
import { WireSocket } from './WireSocket';

/** The close code a cut connection reports */
const ABNORMAL = 1006;
/** The longest name a player can show */
const NAME_LENGTH = 16;

/**
 * Serves one player's wire: seat requests for the room `roomId`, and that player's sockets.
 * Returns a function that drops every socket on the wire, for when the wire itself goes down
 * @param wire - The player's wire
 * @param roomId - The party's room; the only one a player can join
 * @param trusted - Whether this is the host's own player, the only one allowed to say so
 */
export function serveWire(wire: Wire, roomId: string, trusted: boolean): () => void {
  const sockets = new Map<number, WireSocket>();

  wire.onCtl = async (msg) => {
    if (msg.t === 'seat') {
      const options: JoinOptions = {
        name: String(msg.options?.name ?? '')
          .trim()
          .slice(0, NAME_LENGTH),
        car: msg.options?.car,
        host: trusted,
        proto: msg.options?.proto,
      };

      try {
        const rejoin = typeof msg.options?.rejoin === 'string' ? msg.options.rejoin : '';
        const reservation = rejoin
          ? { ...(await matchMaker.reconnect(roomId, { reconnectionToken: rejoin })), reconnectionToken: rejoin }
          : await matchMaker.joinById(roomId, options);

        wire.sendCtl({ t: 'seated', id: msg.id, reservation });
      } catch (e) {
        const err = e as { code?: number; message?: string };

        wire.sendCtl({ t: 'seated', id: msg.id, error: { code: err.code ?? 0, message: err.message ?? String(e) } });
      }
    } else if (msg.t === 'open') {
      const url = new URL(msg.url);
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const socket = new WireSocket(wire, msg.sid);
      const client = new WireClient(sessionId, socket);

      sockets.set(msg.sid, socket);
      socket.once('close', () => sockets.delete(msg.sid));
      try {
        await connectClientToRoom(
          matchMaker.getLocalRoomById(roomId),
          client as unknown as Parameters<typeof connectClientToRoom>[1],
          createAuthContext({ headers: {}, token: url.searchParams.get('_authToken') ?? undefined }),
          {
            reconnectionToken: url.searchParams.get('reconnectionToken') ?? undefined,
            skipHandshake: url.searchParams.has('skipHandshake'),
          },
        );
      } catch (e) {
        const err = e as { code?: number; message?: string };

        client.error(err.code ?? 0, err.message ?? String(e));
        socket.close(CloseCode.WITH_ERROR);
      }
    } else if (msg.t === 'close') {
      sockets.get(msg.sid)?.closed(msg.code, msg.reason);
    }
  };
  wire.onBin = (sid, data) => sockets.get(sid)?.emit('message', data);

  return () => {
    for (const socket of sockets.values()) socket.closed(ABNORMAL, '');
    sockets.clear();
  };
}
