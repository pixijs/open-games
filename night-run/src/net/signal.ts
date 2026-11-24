/**
 * How players find each other before WebRTC links them directly: a Trystero room named by the
 * party's code, with each player's encrypted connection offer passed through a signalling service.
 * The game's own traffic never goes through it.
 *
 * - Built for a site, the game signals through NIGHT RUN's own Cloudflare Worker (`signal/`) at
 *   {@link DEPLOYED_SIGNAL_URL}, or `VITE_NIGHTRUN_SIGNAL_URL` when the build sets it. Players find
 *   their public address through Cloudflare's STUN server; there's no TURN relay, so a player whose
 *   network blocks direct links can't join.
 * - On the dev server it signals through public Nostr relays, so a party can be tested without
 *   running the Worker. `?signal=worker` uses the Worker there too: `VITE_NIGHTRUN_SIGNAL_URL`,
 *   or `wrangler dev` at http://localhost:8787 without one. Production builds leave the Nostr code
 *   out entirely.
 * - `?signal=local` finds the other tabs of this browser over a BroadcastChannel instead
 *   (`localParty.ts`): no WebRTC and no network, for development and tests. Add `&unreachable`
 *   and every peer this tab meets fails to link, as a network that blocks WebRTC would.
 */

import type { PartyRoom } from './wire';

const APP_ID = 'nightrun-racing';
/** Why Host and Join fail on a built site without a Worker to signal through */
export const NOT_SET_UP = "Online races aren't set up on this site.";
/**
 * Public Nostr relays for the dev server. Each echoed Trystero's ephemeral events in under 300 ms
 * when probed (October 2026); dead, paid, AUTH-gated and web-of-trust relays from its defaults are left out.
 * Every peer uses the whole list, so host and guests always share a relay
 */
const NOSTR_RELAYS = [
  'wss://nostr-pub.wellorder.net',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://nostr.mom',
  'wss://relay.nostr.net',
  'wss://nostr.oxtr.dev',
];
/**
 * Where the signalling Worker in `signal/` is deployed, such as `https://nightrun-signal.<account>.workers.dev`,
 * with no trailing slash. While it's empty a built site has no online races: Host and Join say so, and quick races
 * still work.
 */
const DEPLOYED_SIGNAL_URL = '';
const WORKER_URL: string =
  import.meta.env.VITE_NIGHTRUN_SIGNAL_URL || (import.meta.env.DEV ? 'http://localhost:8787' : DEPLOYED_SIGNAL_URL);
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

let relaySockets: () => Record<string, WebSocket> = () => ({});
let local = false;

/**
 * Joins the party room for a code. Rejects only when the build has no Worker to signal through.
 * `onLinkFailed` hears of a peer that answered but couldn't be linked to over WebRTC
 */
export async function joinParty(code: string, onLinkFailed: (() => void) | null = null): Promise<PartyRoom> {
  const params = new URLSearchParams(location.search);
  const signal = params.get('signal');
  const callbacks = { onJoinError: () => onLinkFailed?.() };

  if (signal === 'local') {
    const { joinLocalParty } = await import('./localParty');

    local = true;

    return joinLocalParty(APP_ID, code, params.has('unreachable') ? callbacks.onJoinError : null);
  }
  if (import.meta.env.DEV && signal !== 'worker') {
    const nostr = await import('trystero');

    relaySockets = nostr.getRelaySockets as () => Record<string, WebSocket>;

    return nostr.joinRoom({ appId: APP_ID, relayConfig: { urls: NOSTR_RELAYS } }, code, callbacks);
  }
  if (!WORKER_URL) throw new Error(NOT_SET_UP);
  const relay = await import('@trystero-p2p/ws-relay');

  relaySockets = relay.getRelaySockets as () => Record<string, WebSocket>;

  return relay.joinRoom(
    {
      appId: APP_ID,
      relayConfig: { urls: [`${WORKER_URL.replace(/^http/, 'ws')}/signal`] },
      rtcConfig: { iceServers: ICE_SERVERS },
    },
    code,
    callbacks,
  );
}

/** Whether this tab has an open socket to its signalling service, so its own network is up */
export function signalOnline(): boolean {
  return local || Object.values(relaySockets()).some((socket) => socket.readyState === WebSocket.OPEN);
}
