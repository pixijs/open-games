/**
 * NIGHT RUN's way online: a quick race, hosting a party, or joining one, each as a {@link Session}.
 *
 * Every mode runs the same Colyseus room (`RaceRoom.ts`). A quick race and the host run it in
 * their own tab and talk to it over an in-memory loopback; a guest finds the host through a
 * Trystero room named by the party's code (`signal.ts` says how), and talks to it over a WebRTC
 * data channel. Nobody runs a game server. The game sees none of that: it reads synced state and
 * sends intents.
 *
 * Load it lazily, when the player picks a mode, so the title appears before the network code has
 * downloaded:
 *
 * ```ts
 * const net = await import('./net/session');
 * const session = await net.host({ name: 'Sean', car: 0 }); // or net.startSolo(), or net.join('KXBRT')
 *
 * session.code;                                     // 'KXBRT' to share; '' in a quick race
 * net.inviteLink(session.code, 'Sean');              // ?join=KXBRT&from=Sean on this page
 * session.callbacks.listen('phase', (phase) => ...); // Colyseus state callbacks
 * session.setReady(true);
 * session.sendPose(myTruck);                        // every frame; sent at 20 Hz
 * session.sample(id, out);                          // a remote truck 100 ms behind, interpolated
 * session.serverNow() >= session.state.goAt;        // GO, at the same moment on every screen
 * session.on('fx', ({ id, kind }) => ...);          // a remote boost, wall hit or bump
 * session.onClosed((reason) => backToTitle(reason));
 * await session.leave();
 * ```
 *
 * The first import is `shims/globals.ts`, which has to run before any Colyseus module; keep it first.
 */

import './shims/globals';
import { LocalDriver, LocalPresence, matchMaker } from '@colyseus/core';
import { Callbacks, Client } from '@colyseus/sdk';
import type { Room, SeatReservation } from '@colyseus/sdk';

import { netSwitches } from './hooks';
import { HOST_LEFT, KICKED, PROTOCOL, RECONNECT_SECONDS, seatKey, WRONG_PROTOCOL } from './messages';
import type { Broadcasts, FxKind, Intents, PoseMessage } from './messages';
import { PoseTrack } from './PoseTrack';
import type { TruckPose } from './PoseTrack';
import { RaceRoom } from './RaceRoom';
import type { RaceRoomOptions } from './RaceRoom';
import type { Phase, RaceState, Seat } from './schema';
import { joinParty, signalOnline } from './signal';
import { attachWire, detachWire, reserveSeat, setHostCtlHandler, setWireUp } from './socket';
import { serveWire } from './transport';
import { PeerLinks, loopback } from './wire';
import type { PartyRoom, PeerLink } from './wire';

export type Mode = 'solo' | 'host' | 'guest';
/**
 * Why {@link join} failed, as its Error's message: the code isn't five letters, nobody hosts it, the party
 * is full, the host answered but the WebRTC link between the two couldn't be made, or the host's page is another
 * version of the game
 */
export type JoinFailure = 'notFound' | 'full' | 'malformed' | 'unreachable' | 'version';
/** The SDK's room, typed by the server room's messages and state */
export type Connection = Room<RaceRoom, RaceState>;
/** Why a session ended: this player left, the host ended the party or removed this player, or the connection was lost for good */
export type CloseReason = 'left' | 'hostLeft' | 'kicked' | 'lost';
export type ConnectionStatus = 'online' | 'reconnecting';

/** What {@link Session.sendPose} takes: the pose, and how far round the current lap the truck is, 0 to 1 */
export interface PoseReport extends TruckPose {
  progress: number;
}

const ROOM_NAME = 'nightrun';
/** Letters only, and no O or I, so a code read aloud or off a phone can't be mistaken for 0 or 1 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 5;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
const SELF_HOST = 'self.nightrun';
const PARTY_HOST = 'host.nightrun';
/** Poses go out 20 times a second */
const POSE_INTERVAL_MS = 50;
/** How far behind remote trucks are drawn, so there's almost always a newer pose to move towards */
const INTERPOLATION_DELAY_MS = 100;
/** The clock sync: a ping every 2 s, five quick ones on joining and after a reconnection */
const PING_TICK_MS = 125;
const PING_EVERY = 16;
const PING_BURST = 5;
/** The sync keeps the last pings and trusts the one with the shortest round trip */
const SYNC_WINDOW = 8;
/** An estimate further off than this is taken at once, as the first one is */
const CLOCK_SNAP_MS = 40;
/**
 * A smaller change slews in at this many ms per ms, so room time never steps: every remote truck is drawn at room time,
 * and a step would jump them all at once
 */
const CLOCK_SLEW = 0.05;
/** How long a guest that seems to have lost its own connection keeps trying: as long as the host holds its seat */
const HOST_GRACE_MS = RECONNECT_SECONDS * 1000;
/** How often the host says it's still there, and how long a guest waits without hearing it */
const BEAT_MS = 2000;
const BEAT_TIMEOUT_MS = 6000;
/** How long a guest looks for a party's host before saying there's no such party */
const FIND_HOST_MS = 10000;
/** How long a guest waits for the room's first state once seated */
const FIRST_STATE_MS = 8000;
/** How long a guest keeps trying after the host answered but WebRTC failed, in case another attempt gets through */
const UNREACHABLE_GRACE_MS = 6000;
/** The page's own switches, which an invite link leaves out */
const GAME_PARAMS = [
  'join',
  'from',
  'solo',
  'race',
  'host',
  'name',
  'car',
  'autoready',
  'autostart',
  'autodrive',
  'bots',
  'laps',
  'debug',
  'track',
  'tn',
  'r',
  'editor',
  'treeSeed',
  'botline',
  'lineWorkers',
];

/** Storage can be off (a private window, blocked site data), and then a reload just joins afresh */
function readSeat(code: string): string {
  try {
    return sessionStorage.getItem(seatKey(code)) ?? '';
  } catch {
    return '';
  }
}

function writeSeat(code: string, token: string): void {
  try {
    if (token) sessionStorage.setItem(seatKey(code), token);
    else sessionStorage.removeItem(seatKey(code));
  } catch {
    // Without storage a reload joins as a new player, which still works.
  }
}

function poseMessage(): PoseMessage {
  return {
    t: 0,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    speed: 0,
    steer: 0,
    drift: 0,
    charge: 0,
    boosting: false,
    progress: 0,
  };
}

function fillPose(message: PoseMessage, pose: PoseReport, t: number): void {
  message.t = t;
  message.x = pose.x;
  message.y = pose.y;
  message.z = pose.z;
  message.yaw = pose.yaw;
  message.pitch = pose.pitch;
  message.roll = pose.roll;
  message.speed = pose.speed;
  message.steer = pose.steer;
  message.drift = pose.drift;
  message.charge = pose.charge;
  message.boosting = pose.boosting;
  message.progress = pose.progress;
}

export class Session {
  /** Colyseus's state callbacks for {@link state}: `onAdd`, `onRemove`, `onChange`, `listen` */
  public readonly callbacks: ReturnType<typeof Callbacks.get<RaceState>>;
  private readonly _tracks = new Map<string, PoseTrack>();
  private readonly _unbindTracks = new Map<string, () => void>();
  private readonly _closedHandlers = new Set<(reason: CloseReason) => void>();
  private readonly _connectionHandlers = new Set<(status: ConnectionStatus) => void>();
  private _closed = false;
  private _online = true;
  /** Room time minus `performance.now()` now, slewing toward the clock sync's latest estimate */
  private _offset = 0;
  private _offsetTarget = 0;
  /** `performance.now()` the offset last slewed at */
  private _slewAt = 0;
  private _synced = false;
  private readonly _pingRtt = new Float64Array(SYNC_WINDOW).fill(Infinity);
  private readonly _pingOffset = new Float64Array(SYNC_WINDOW);
  private _pings = 0;
  private _rtt = 0;
  private _pingTicks = 0;
  private _burst = PING_BURST;
  /** `performance.now()` a paused quick race stopped at, or -1 while it runs */
  private _frozenAt = -1;
  private readonly _pingTimer: ReturnType<typeof setInterval>;
  /** `performance.now()` of the next pose send this session's player, and each bot, is due */
  private _poseDue = 0;
  private readonly _botPoseDue = new Map<string, number>();
  private readonly _poseMessage = poseMessage();
  private readonly _botPoseMessage: PoseMessage & { id: string } = { ...poseMessage(), id: '' };

  constructor(
    public readonly mode: Mode,
    public readonly code: string,
    public readonly room: Connection,
    private readonly _teardown: (reason: CloseReason) => Promise<void>,
    private readonly _drop: ((ms: number) => void) | null = null,
  ) {
    const callbacks = Callbacks.get(room);

    this.callbacks = callbacks;
    callbacks.onAdd('racers', (racer: Seat, id: string) => {
      const track = new PoseTrack();

      track.push(racer.pose);
      this._tracks.set(id, track);
      this._unbindTracks.get(id)?.();
      this._unbindTracks.set(
        id,
        callbacks.onChange(racer.pose, () => track.push(racer.pose)),
      );
    });
    callbacks.listen(
      'race',
      () => {
        for (const track of this._tracks.values()) track.reset();
      },
      false,
    );
    callbacks.onRemove('racers', (_racer: Seat, id: string) => {
      this._unbindTracks.get(id)?.();
      this._unbindTracks.delete(id);
      this._tracks.delete(id);
    });
    room.onMessage('pong', ({ c, s }) => this._pong(c, s));
    room.onDrop(() => {
      // The SDK reports each failed retry as another drop.
      if (!this._online) return;
      this._online = false;
      this._connectionHandlers.forEach((handler) => handler('reconnecting'));
    });
    room.onReconnect(() => {
      this._online = true;
      // The route to the host may have changed: measure the clock afresh.
      this._pingRtt.fill(Infinity);
      this._burst = PING_BURST;
      this._connectionHandlers.forEach((handler) => handler('online'));
    });
    room.onLeave((code) => this.end(code === HOST_LEFT ? 'hostLeft' : code === KICKED ? 'kicked' : 'lost'));
    this._pingTimer = setInterval(() => this._pingTick(), PING_TICK_MS);
    this._pingTick();
  }

  public get sessionId(): string {
    return this.room.sessionId;
  }

  public get state(): RaceState {
    return this.room.state;
  }

  public get phase(): Phase {
    return this.state.phase as Phase;
  }

  /** This player's seat, or undefined in the moment before the first state arrives */
  public get me(): Seat | undefined {
    return this.state.racers.get(this.room.sessionId);
  }

  public get isHost(): boolean {
    return this.state.hostId === this.room.sessionId;
  }

  /** The best round trip to the host lately, in milliseconds; about 0 for the host itself */
  public get rtt(): number {
    return this._rtt;
  }

  /** Whether the clock has heard back from the room at least once */
  public get clockSynced(): boolean {
    return this._synced;
  }

  /** Room time now, in milliseconds: the host's clock, as every peer sees it within a few ms. It stands still while a quick race is paused */
  public serverNow(): number {
    if (this._frozenAt >= 0) return this._frozenAt + this._offset;

    const now = performance.now();

    if (this._offset !== this._offsetTarget) {
      const step = (now - this._slewAt) * CLOCK_SLEW;
      const left = this._offsetTarget - this._offset;

      this._offset += Math.max(-step, Math.min(step, left));
    }

    this._slewAt = now;

    return now + this._offset;
  }

  /** Whether a quick race is paused */
  public get paused(): boolean {
    return this._frozenAt >= 0;
  }

  /** Milliseconds since GO of the current race; negative during the countdown */
  public raceTime(): number {
    return this.serverNow() - this.state.goAt;
  }

  /**
   * Where racer `id`'s truck was 100 ms before room time `now`, interpolated between its reports,
   * or carried on for up to 150 ms past the newest one when they stall. Fills `out` and returns
   * true, or returns false for a racer with no pose yet. Pass the room time of the frame being
   * drawn as `now`, so trucks move by the display's own clock rather than by when the code ran
   */
  public sample(id: string, out: TruckPose, now: number = this.serverNow()): boolean {
    return this._tracks.get(id)?.sample(now - INTERPOLATION_DELAY_MS, out) ?? false;
  }

  public send<K extends keyof Intents>(type: K, payload: Intents[K]): void {
    if (!this._closed) this.room.send(type, payload as never);
  }

  public setName(name: string): void {
    this.send('setName', { name });
  }

  /** Asks for truck colour `car`, 0 to 3; refused with a `notice` while another player drives it, swapped with a bot that does */
  public setCar(car: number): void {
    this.send('setCar', { car });
  }

  public setReady(ready: boolean): void {
    this.send('setReady', { ready });
  }

  /** Call it every frame with this player's truck; it goes out 20 times a second */
  public sendPose(pose: PoseReport): void {
    const now = performance.now();

    if (now < this._poseDue || !this._online) return;
    this._poseDue = Math.max(this._poseDue + POSE_INTERVAL_MS, now - POSE_INTERVAL_MS);
    fillPose(this._poseMessage, pose, this.serverNow());
    this.send('pose', this._poseMessage);
  }

  /** This player has completed `lap` laps (1 for the first), crossing the line at room time `at`; the last lap finishes */
  public reportLap(lap: number, at: number = this.serverNow()): void {
    this.send('lap', { lap, at });
  }

  /**
   * Plays on everyone else's screen: a boost fired, a wall hit of strength `power`, 0 to 1, or a bump into racer
   * `target`'s truck, which that racer's screen feels as a shove
   */
  public fx(kind: FxKind, power = 1, target = ''): void {
    this.send('fx', { kind, power, target });
  }

  /** The host only: laps per race, 1, 2, 3 or 5 */
  public setLaps(laps: number): void {
    this.send('setLaps', { laps });
  }

  /**
   * The host only, in the lobby: race track `code` ('' for Night Run), called `name`; refused with a `notice` for a
   * code that isn't a track. Every screen builds it when the state says so, this one included
   */
  public setTrack(code: string, name: string): void {
    this.send('setTrack', { code, name });
  }

  /** This screen can't build the room's track `code`: the room tells the host. Send it before leaving */
  public trackFailed(code: string): void {
    this.send('trackFailed', { code });
  }

  /** The host only: fills a seat with a bot, in colour `car` when it's free */
  public addBot(car = 0): void {
    this.send('addBot', { car });
  }

  /** The host only: removes bot `id`, or the last one added */
  public removeBot(id = ''): void {
    this.send('removeBot', { id });
  }

  /** The host only: removes player `id` from the party, or bot `id` from the lobby */
  public kick(id: string): void {
    this.send('kick', { id });
  }

  /** The host only: starts the countdown once every player is ready, or at once with `force` */
  public start(force = false): void {
    this.send('start', { force });
  }

  /** The host only: back to the lobby, from the results or in the middle of a race */
  public rematch(): void {
    this.send('rematch', {});
  }

  /** The host only: closes the race now, into the results with the places as they stand */
  public endRace(): void {
    this.send('endRace', {});
  }

  /** A quick race only: stops the race clock here and in the room, or starts both again */
  public pause(on: boolean): void {
    if (this.mode !== 'solo' || on === this.paused) return;
    if (on) {
      this._frozenAt = performance.now();
    } else {
      const paused = performance.now() - this._frozenAt;

      this._offset -= paused;
      this._offsetTarget -= paused;
      this._slewAt = performance.now();
      this._frozenAt = -1;
      this._pingRtt.fill(Infinity);
      this._burst = PING_BURST;
    }
    this.send('pause', { on });
  }

  /** The host only: bot `id`'s pose, every frame; each bot's goes out 20 times a second */
  public sendBotPose(id: string, pose: PoseReport): void {
    const now = performance.now();
    const due = this._botPoseDue.get(id) ?? 0;

    if (now < due) return;
    this._botPoseDue.set(id, Math.max(due + POSE_INTERVAL_MS, now - POSE_INTERVAL_MS));
    fillPose(this._botPoseMessage, pose, this.serverNow());
    this._botPoseMessage.id = id;
    this.send('botPose', this._botPoseMessage);
  }

  /** The host only: bot `id` has completed `lap` laps at room time `at` */
  public reportBotLap(id: string, lap: number, at: number = this.serverNow()): void {
    this.send('botLap', { id, lap, at });
  }

  /** The host only: bot `id`'s boost, wall hit or bump into racer `target`, for everyone else's screen */
  public botFx(id: string, kind: FxKind, power = 1, target = ''): void {
    this.send('botFx', { id, kind, power, target });
  }

  /** Listens for one of the room's messages (`Broadcasts` in messages.ts); returns the unsubscribe */
  public on<K extends keyof Broadcasts>(type: K, handler: (message: Broadcasts[K]) => void): () => void {
    return this.room.onMessage(type as never, handler as never);
  }

  public onClosed(handler: (reason: CloseReason) => void): () => void {
    this._closedHandlers.add(handler);

    return () => this._closedHandlers.delete(handler);
  }

  public onConnection(handler: (status: ConnectionStatus) => void): () => void {
    this._connectionHandlers.add(handler);

    return () => this._connectionHandlers.delete(handler);
  }

  /** A guest only: cuts the connection for `ms` milliseconds, then lets it come back. For tests */
  public simulateDrop(ms: number): void {
    this._drop?.(ms);
  }

  /** Leaves the party; for the host, ends it for everyone */
  public async leave(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    await this._teardown('left');
    this._ended('left');
  }

  /** The transport saw the session end, for `reason`; the same as {@link leave} for a player who chose to go */
  public end(reason: CloseReason): void {
    if (this._closed) return;
    this._closed = true;
    this.room.reconnection.enabled = false;
    void this._teardown(reason);
    this._ended(reason);
  }

  private _ended(reason: CloseReason): void {
    clearInterval(this._pingTimer);
    for (const handler of this._closedHandlers) handler(reason);
    this._closedHandlers.clear();
    this._connectionHandlers.clear();
    for (const unbind of this._unbindTracks.values()) unbind();
    this._unbindTracks.clear();
    this._tracks.clear();
    this._botPoseDue.clear();
  }

  private _pingTick(): void {
    if (!this._online || this._closed || this._frozenAt >= 0) return;
    if (this._burst > 0) this._burst--;
    else if (++this._pingTicks % PING_EVERY !== 0) return;
    this.send('ping', { c: performance.now() });
  }

  private _pong(sentAt: number, roomTime: number): void {
    const now = performance.now();
    const rtt = now - sentAt;

    if (!(rtt >= 0) || !Number.isFinite(roomTime) || this._frozenAt >= 0) return;
    const slot = this._pings++ % SYNC_WINDOW;

    this._pingRtt[slot] = rtt;
    this._pingOffset[slot] = roomTime + rtt / 2 - now;
    let best = slot;

    for (let i = 0; i < SYNC_WINDOW; i++) if (this._pingRtt[i] < this._pingRtt[best]) best = i;
    const target = this._pingOffset[best];

    this._rtt = this._pingRtt[best];
    if (!this._synced || Math.abs(target - this._offset) > CLOCK_SNAP_MS) this._offset = target;
    this._offsetTarget = target;
    this._slewAt = now;
    this._synced = true;
  }
}

export interface StartOptions {
  /** The player's name, shown to the party */
  name?: string;
  /** The truck colour the player would like, 0 to 3 */
  car?: number;
  /** Laps per race to start with; the host and a quick race only */
  laps?: number;
  /** The track to start on, as a share code ('' for Night Run), and its name; the host and a quick race only */
  track?: string;
  trackName?: string;
}

/** A party code: five letters, never O or I */
export function makeCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));

  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** The code as typed, cleaned up, or null when it can't be a party code */
export function parseCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[^A-Z]/g, '');

  return CODE_PATTERN.test(code) ? code : null;
}

/**
 * The link that brings a friend to this page's invite landing: `?join=CODE&from=Name`, keeping the
 * page's other parameters (the signalling switch among them) and dropping the game's own
 */
export function inviteLink(code: string, from: string, page: string = location.href): string {
  const url = new URL(page);

  url.hash = '';
  for (const name of GAME_PARAMS) url.searchParams.delete(name);
  url.searchParams.set('join', code);
  if (from) url.searchParams.set('from', from);

  return url.toString();
}

const failure = (reason: JoinFailure): Error => new Error(reason);

/**
 * Takes a seat with the SDK, and waits for the first full state so the session never sees it empty; a host that
 * seats the player but never sends it is unreachable
 */
async function seat(hostname: string, reservation: SeatReservation): Promise<Connection> {
  const room: Connection = await new Client(`http://${hostname}`).consumeSeatReservation<RaceState>(reservation);

  if (room.state.racers) return room;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      room.onStateChange.once(() => resolve());
      timer = setTimeout(() => reject(failure('unreachable')), FIRST_STATE_MS);
    });
  } catch (error) {
    await room.leave(true).catch(() => 0);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  return room;
}

let matchmakerReady: Promise<void> | null = null;

function startMatchmaker(): Promise<void> {
  matchmakerReady ??= (async () => {
    await matchMaker.setup(new LocalPresence(), new LocalDriver());
    // Standalone: no inter-process health checks, so no Node timer `unref()` calls either.
    await matchMaker.accept(true);
    matchMaker.defineRoomType(ROOM_NAME, RaceRoom);
  })();

  return matchmakerReady;
}

/** Creates the party's room in this tab and seats this player in it over a loopback */
async function openRoom(
  code: string,
  options: StartOptions,
): Promise<{ room: Connection; raceRoom: RaceRoom; close: () => void }> {
  await startMatchmaker();
  const roomOptions: RaceRoomOptions = {
    code,
    laps: options.laps,
    track: options.track,
    trackName: options.trackName,
  };
  const listing = await matchMaker.createRoom(ROOM_NAME, roomOptions);
  const raceRoom = matchMaker.getLocalRoomById(listing.roomId) as RaceRoom;
  const [server, client] = loopback();
  const close = serveWire(server, listing.roomId, true);

  attachWire(SELF_HOST, client);
  const reservation = await reserveSeat(client, { name: options.name ?? '', car: options.car, proto: PROTOCOL });
  const room = await seat(SELF_HOST, reservation);

  return { room, raceRoom, close };
}

/** A race against bots, with the same room and rules as a party, and no network at all */
export async function startSolo(options: StartOptions = {}): Promise<Session> {
  const { room, raceRoom, close } = await openRoom('', options);

  return new Session('solo', '', room, async () => {
    await raceRoom.close();
    close();
    detachWire(SELF_HOST);
  });
}

/** Hosts a party: the room runs in this tab, and friends join with `session.code` */
export async function host(options: StartOptions = {}): Promise<Session> {
  const code = makeCode();
  // Nobody knows the code yet, so no guest can arrive before the room is open.
  const party = await joinParty(code);
  const { room, raceRoom, close } = await openRoom(code, options);
  const links = new PeerLinks(party);
  const drops = new Map<string, () => void>();

  links.onPeerJoin = (link) => {
    drops.get(link.peerId)?.();
    drops.set(link.peerId, serveWire(link.wire, room.roomId, false));
    link.wire.sendCtl({ t: 'hello', code });
    raceRoom.setLink(link.peerId, true);
  };
  links.onPeerLeave = (link) => {
    drops.get(link.peerId)?.();
    drops.delete(link.peerId);
    raceRoom.setLink(link.peerId, false);
  };
  const sayGoodbye = (): void => links.broadcast({ t: 'bye' });
  const beat = setInterval(() => links.broadcast({ t: 'beat' }), BEAT_MS);

  // beforeunload comes early enough for the goodbye to leave before the data channels close.
  addEventListener('beforeunload', sayGoodbye);
  addEventListener('pagehide', sayGoodbye);

  return new Session('host', code, room, async () => {
    removeEventListener('beforeunload', sayGoodbye);
    removeEventListener('pagehide', sayGoodbye);
    clearInterval(beat);
    sayGoodbye();
    await raceRoom.close();
    for (const drop of drops.values()) drop();
    drops.clear();
    close();
    detachWire(SELF_HOST);
    await party.leave();
  });
}

/** Joins a friend's party by its code. Rejects with an Error whose message is a {@link JoinFailure} */
export async function join(input: string, options: StartOptions = {}): Promise<Session> {
  const code = parseCode(input);

  if (!code) throw failure('malformed');
  let party: PartyRoom | null = null;
  let hostPeer = '';
  let session: Session | null = null;
  let heardAt = performance.now();
  let hostGone: ReturnType<typeof setTimeout> | undefined;
  let found: (link: PeerLink) => void = () => {};
  let unreachable: () => void = () => {};
  const hostFound = new Promise<PeerLink>((resolve, reject) => {
    found = resolve;
    unreachable = () => reject(failure('unreachable'));
  });
  let linkFailed: ReturnType<typeof setTimeout> | undefined;
  /** A peer answered but WebRTC couldn't link to it; it may have been another guest, so give the host a moment */
  const onJoinError = (): void => {
    linkFailed ??= setTimeout(unreachable, UNREACHABLE_GRACE_MS);
  };

  /** The host's link is down: drop its sockets so the SDK starts retrying, and give up after a grace period */
  const lost = (reason: CloseReason): void => {
    setWireUp(PARTY_HOST, false);
    hostGone ??= setTimeout(() => session?.end(reason), HOST_GRACE_MS);
  };
  /** The party room in use; a dropped one's late callbacks are ignored */
  let current: PeerLinks | null = null;
  /** Set once this join is over, so a reconnection still pending from before never takes the host's wire back */
  let stopped = false;
  const connect = async (): Promise<void> => {
    if (stopped) return;
    const joined = await joinParty(code, onJoinError);

    if (stopped) {
      await joined.leave();

      return;
    }
    party = joined;
    const links = new PeerLinks(party);

    current = links;

    links.onPeerJoin = (link) => {
      if (hostPeer && link.peerId !== hostPeer) return;
      link.wire.onCtl = (msg) => {
        if (msg.t !== 'hello') return;
        hostPeer = link.peerId;
        heardAt = performance.now();
        clearTimeout(hostGone);
        hostGone = undefined;
        attachWire(PARTY_HOST, link.wire);
        setWireUp(PARTY_HOST, true);
        found(link);
      };
    };
    links.onPeerLeave = (link) => {
      if (links !== current || link.peerId !== hostPeer) return;
      // Trystero gives up on a peer only after seconds of silence. If this tab still reaches a
      // relay or another player, its own network is fine, so the host has gone.
      if (links.upCount() > 0 || signalOnline()) session?.end('hostLeft');
      else lost('hostLeft');
    };
  };

  setHostCtlHandler((msg) => {
    heardAt = performance.now();
    if (msg.t === 'bye') session?.end('hostLeft');
  });
  // Trystero can take a while to notice a peer that vanished, so the host's heartbeat decides sooner.
  const watchdog = setInterval(() => {
    if (hostPeer && hostGone === undefined && performance.now() - heardAt > BEAT_TIMEOUT_MS) lost('lost');
  }, 1000);
  const leaveParty = async (): Promise<void> => {
    await party?.leave();
  };
  const stop = async (): Promise<void> => {
    stopped = true;
    clearInterval(watchdog);
    clearTimeout(hostGone);
    setHostCtlHandler(null);
    detachWire(PARTY_HOST);
    await leaveParty();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await connect();
    const link = await Promise.race([
      hostFound,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(failure(linkFailed ? 'unreachable' : 'notFound')), FIND_HOST_MS);
      }),
    ]);

    clearTimeout(timer);
    clearTimeout(linkFailed);
    const joinOptions = {
      name: options.name ?? '',
      car: options.car,
      proto: netSwitches.dropProto ? undefined : PROTOCOL,
    };

    netSwitches.dropProto = false;
    // A page that reloaded takes its old seat back while the host still holds it for them.
    const held = readSeat(code).split(':')[1] ?? '';
    const back = held
      ? await reserveSeat(link.wire, { ...joinOptions, rejoin: held })
          .then((reservation) => seat(PARTY_HOST, reservation))
          .catch(() => null)
      : null;
    const room =
      back ??
      (await seat(
        PARTY_HOST,
        await reserveSeat(link.wire, joinOptions).catch((error: Error) => {
          throw /locked|full/i.test(error.message) ? failure('full') : error;
        }),
      ).catch((error: Error & { code?: number }) => {
        throw error.code === WRONG_PROTOCOL ? failure('version') : error;
      }));
    const remember = (): void => writeSeat(code, room.reconnectionToken ?? '');

    remember();
    // A reconnection hands out a new token after its event fires, and the page leaving is when the token matters most.
    room.onReconnect(() => setTimeout(remember, 0));
    addEventListener('pagehide', remember);

    // Retries are cheap over a wire that's down, so try often: the host holds the seat for 20 s.
    room.reconnection.minUptime = 1000;
    room.reconnection.maxDelay = 1500;
    session = new Session(
      'guest',
      code,
      room,
      async (reason) => {
        removeEventListener('pagehide', remember);

        // A connection lost for good keeps the token, so Rejoin takes the seat back if the host still holds it.
        if (reason === 'lost') {
          await stop();

          return;
        }

        // A player who leaves gives the seat up, so a later visit joins afresh.
        writeSeat(code, '');
        // Say goodbye so the host frees the seat at once, but don't wait on a host who's gone.
        await Promise.race([room.leave(true).catch(() => 0), new Promise((resolve) => setTimeout(resolve, 600))]);
        await stop();
      },
      (ms) => {
        // Leaving the party room closes the data channel for real, so the host sees the drop too.
        current = null;
        lost('lost');
        void leaveParty().then(() => setTimeout(() => void connect(), ms));
      },
    );

    return session;
  } catch (error) {
    clearTimeout(timer);
    clearTimeout(linkFailed);
    await stop();
    throw error;
  }
}
