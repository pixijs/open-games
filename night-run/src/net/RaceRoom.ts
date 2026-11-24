/**
 * The party's Colyseus room, run by the host's tab (and by a quick race's, over a loopback). It
 * owns the race flow and everything players share:
 *
 * - who's in the party: up to four racers, players and the host's bots, each with a unique truck
 *   colour, and spectators beyond them. A player arriving mid-race spectates until the lobby,
 *   where a waiting player takes a free seat, or a bot's, and in the lobby takes any seat that
 *   opens;
 * - the flow, lobby → countdown → racing → results → lobby. The host sets the laps, adds and
 *   removes bots, kicks, and starts once every player is ready (or forces it). The countdown ends
 *   at `goAt`, a room time every peer's synced clock agrees on. The race closes when every racer
 *   still connected, or whose seat is held for them, has finished, or {@link FINISH_GRACE_MS}
 *   after the first finish; the results go back to the lobby when the host calls a rematch, or
 *   after {@link RESULTS_MS}. The host can also close a race early, into the results with the
 *   places as they stand. Whoever is still running then gets a time projected from their pace;
 * - each truck's pose, as its owner reports it about 20 times a second (the host reports its
 *   bots'), and the laps and progress each racer reports, which the room ranks: finishers by
 *   time, then everyone else by how far round the race they are. Reports arrive at different
 *   moments, so each racer's distance is carried on to the room's clock at its reported speed
 *   before they're compared, and a pass only counts once it clears {@link PASS_MARGIN} or holds
 *   for {@link PASS_HOLD_MS}: two trucks side by side don't swap places on every report;
 * - the boost, wall-hit and bump moments, passed on to every other screen;
 * - the track raced, as its share code: the host's at the start, and the host can change it in the lobby. Every
 *   screen builds it from the code; the room keeps its own route of it for lap limits and distances. Only a guest
 *   that speaks the room's {@link PROTOCOL} is let in, since an older page would race the wrong track.
 *
 * A quick race (code '') is the same room with one player: its results wait for the player
 * rather than going back on their own, and the player can pause it, which stops the room's clock.
 *
 * A player who drops has {@link RECONNECT_SECONDS} to come back; a reloaded page takes its seat
 * back with its reconnection token. Nothing a player sends is trusted as it arrives: every field
 * is checked by hand. Messages are in `messages.ts`, the state in `schema.ts`.
 */

import { Room, ServerError } from '@colyseus/core';
import type { Client, Deferred } from '@colyseus/core';

import { BASE_ROUTE, Route } from '../race/route';
import { BASE_TRACK, cleanTrackName, decodeTrack, isTrackError, UNSHOWN_CHARACTERS } from '../track/code';
import type { TrackDef, TrackError } from '../track/code';
import {
  COUNTDOWN_MS,
  DEFAULT_LAPS,
  FINISH_GRACE_MS,
  HOST_LEFT,
  KICKED,
  LAP_CHOICES,
  MAX_PEOPLE,
  MAX_RACERS,
  minLapMs,
  minProgress,
  NAME_LENGTH,
  PROTOCOL,
  RECONNECT_SECONDS,
  RESULTS_MS,
  WRONG_PROTOCOL,
} from './messages';
import type { Broadcasts, FxKind, Intents, NoticeCode, PoseMessage } from './messages';
import { RaceState, Result, Seat } from './schema';
import type { Phase } from './schema';
import type { JoinOptions } from './wire';

/** Options the session creates the room with */
export interface RaceRoomOptions {
  /** The party's code, or '' for a quick race */
  code: string;
  laps?: number;
  /** The track's share code, '' (or anything that isn't a track) for Night Run, and its name */
  track?: string;
  trackName?: string;
}

type RaceClient = Client<{ messages: Broadcasts }>;

const TICK_MS = 50;
/** Patches go out 30 times a second, so a pose waits at most 33 ms in the room */
const PATCH_MS = 1000 / 30;
const BOT_IDS = ['bot1', 'bot2', 'bot3'] as const;
const BOT_NAMES = ['Viper', 'Nova', 'Blaze', 'Rook', 'Jinx', 'Comet'] as const;
const FX_KINDS: readonly FxKind[] = ['boost', 'wall', 'bump'];
/** How far past the room's clock a report's time may be, for a peer's clock estimate that runs a little ahead */
const FUTURE_SLACK_MS = 250;
/** One fx per racer per this many milliseconds; a truck grinding along a wall doesn't flood the party */
const FX_GAP_MS = 80;
/** Positions beyond this many metres from the origin are malformed */
const WORLD_LIMIT = 10000;
/** How far past its last report a racer's distance is carried on at its reported speed, at most */
const PROJECT_MAX_MS = 250;
/** A guest whose link came up this long ago without taking a seat isn't counted as joining any more */
const JOINING_MS = 8000;
/** A racer passes the one ahead once it leads by this many metres, or has led for this long */
const PASS_MARGIN = 0.5;
const PASS_HOLD_MS = 300;
/** A racer still running as the race closes gets a time projected from their pace once they're this share of a lap round */
const PROJECT_FROM = 1 / 4;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const isCar = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) < 4;
const wrapAngle = (angle: number): number => angle - Math.PI * 2 * Math.round(angle / (Math.PI * 2));

/** A player's name, cleaned of control and bidi characters and runs of spaces, and capped */
function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';

  return value.replace(UNSHOWN_CHARACTERS, '').replace(/\s+/g, ' ').trim().slice(0, NAME_LENGTH);
}

/** Finishers by time, ahead of everyone still racing; 0 when neither has finished */
function byFinish(a: Seat, b: Seat): number {
  if (a.finishTime === 0 && b.finishTime === 0) return 0;
  if (a.finishTime === 0) return 1;
  if (b.finishTime === 0) return -1;

  return a.finishTime - b.finishTime;
}

export class RaceRoom extends Room<{ state: RaceState; client: RaceClient }> {
  public maxClients = MAX_PEOPLE;
  public patchRate = PATCH_MS;
  public state = new RaceState();

  public messages = {
    setName: (client: RaceClient, msg: Intents['setName']) => this._setName(client.sessionId, msg?.name),
    setCar: (client: RaceClient, msg: Intents['setCar']) => this._setCar(client, msg?.car),
    setReady: (client: RaceClient, msg: Intents['setReady']) => {
      const racer = this.state.racers.get(client.sessionId);

      if (racer && !racer.spectator && this.state.phase === 'lobby') racer.ready = msg?.ready === true;
    },
    pose: (client: RaceClient, msg: Intents['pose']) => this._pose(this.state.racers.get(client.sessionId), msg),
    lap: (client: RaceClient, msg: Intents['lap']) =>
      this._lap(client.sessionId, this.state.racers.get(client.sessionId), msg?.lap, msg?.at),
    fx: (client: RaceClient, msg: Intents['fx']) =>
      this._fx(client.sessionId, this.state.racers.get(client.sessionId), msg, client),
    ping: (client: RaceClient, msg: Intents['ping']) => {
      if (finite(msg?.c)) client.send('pong', { c: msg.c, s: this._now() });
    },
    setLaps: (client: RaceClient, msg: Intents['setLaps']) => {
      if (this._hostIn(client, 'lobby') && LAP_CHOICES.includes(msg?.laps)) this.state.laps = msg.laps;
    },
    setTrack: (client: RaceClient, msg: Intents['setTrack']) => this._setTrack(client, msg?.code, msg?.name),
    trackFailed: (client: RaceClient, msg: Intents['trackFailed']) => this._trackFailed(client, msg?.code),
    addBot: (client: RaceClient, msg: Intents['addBot']) => {
      if (this._hostIn(client, 'lobby') && !this._addBot(msg?.car))
        this._notice(client, 'full', 'Every seat is taken.');
    },
    removeBot: (client: RaceClient, msg: Intents['removeBot']) => {
      if (this._hostIn(client, 'lobby') && this._removeBot(typeof msg?.id === 'string' ? msg.id : '')) {
        this._seatWaiting();
        this._closeGaps();
      }
    },
    kick: (client: RaceClient, msg: Intents['kick']) => {
      if (this._hostIn(client) && typeof msg?.id === 'string') this._kick(msg.id);
    },
    start: (client: RaceClient, msg: Intents['start']) => {
      if (this._hostIn(client, 'lobby')) this._start(client, msg?.force === true);
    },
    rematch: (client: RaceClient) => {
      if (this._hostIn(client) && this.state.phase !== 'lobby') this._toLobby();
    },
    endRace: (client: RaceClient) => {
      if (this._hostIn(client, 'racing')) this._closeRace(this._now());
    },
    pause: (client: RaceClient, msg: Intents['pause']) => {
      if (this.state.code === '' && this._hostIn(client)) this._pause(msg?.on === true);
    },
    botPose: (client: RaceClient, msg: Intents['botPose']) => {
      if (this._hostIn(client)) this._pose(this._bot(msg?.id), msg);
    },
    botLap: (client: RaceClient, msg: Intents['botLap']) => {
      if (this._hostIn(client)) this._lap(msg?.id, this._bot(msg?.id), msg?.lap, msg?.at);
    },
    botFx: (client: RaceClient, msg: Intents['botFx']) => {
      if (this._hostIn(client)) this._fx(msg?.id, this._bot(msg?.id), msg, client);
    },
  };

  /** The room's own route of the track raced, for its limits and the race's distances */
  private _route: Route = BASE_ROUTE;
  /** The track code each guest last said it couldn't build, so it tells the host once per track */
  private readonly _failedTrack = new Map<string, string>();
  /** `performance.now()` when the room opened: room time counts from it */
  private readonly _epoch = performance.now();
  /** Milliseconds the room's clock has been stopped for, and `performance.now()` it stopped at while paused */
  private _pausedMs = 0;
  private _pausedAt = 0;
  /** Room time each racer last crossed the line this race, keyed as `state.racers` */
  private readonly _crossedAt = new Map<string, number>();
  /** `performance.now()` of each racer's last fx, for {@link FX_GAP_MS} */
  private readonly _fxAt = new Map<string, number>();
  /** Dropped players' seats waiting for them, so a kick can end the wait */
  private readonly _waiting = new Map<string, Deferred>();
  /** Players being kicked, whose drop gives them no time to come back */
  private readonly _kicked = new Set<string>();
  private _closing = false;
  /** Racer ids in place order, refilled by {@link RaceRoom._rank} */
  private readonly _order: string[] = [];
  /** Racer ids in raw order by {@link RaceRoom._distance}, and each one's distance this tick */
  private readonly _raw: string[] = [];
  private readonly _distances = new Map<string, number>();
  /** Guests linked to the host who haven't taken a seat yet, by peer id, with the room time each linked at */
  private readonly _linking = new Map<string, number>();
  /** Room time each racer started running ahead of the place it holds, while it does */
  private readonly _passingSince = new Map<string, number>();
  private readonly _byDistance = (a: string, b: string): number =>
    byFinish(this._seat(a), this._seat(b)) ||
    (this._distances.get(b) ?? 0) - (this._distances.get(a) ?? 0) ||
    this._seat(a).grid - this._seat(b).grid;
  private readonly _byRank = (a: string, b: string): number =>
    (this._seat(a).rank || MAX_RACERS + 1) - (this._seat(b).rank || MAX_RACERS + 1) ||
    this._raw.indexOf(a) - this._raw.indexOf(b);

  public onCreate(options: RaceRoomOptions): void {
    this.state.code = typeof options.code === 'string' ? options.code : '';
    this.state.laps = LAP_CHOICES.includes(options.laps ?? NaN) ? (options.laps as number) : DEFAULT_LAPS;
    const def = this._decode(options.track, options.trackName);

    this._useTrack(isTrackError(def) ? BASE_TRACK : def);
    this.setTimestep(() => this._tick(), TICK_MS);
  }

  /**
   * Lets in the host's own player, and a guest that speaks this room's protocol. Another version's guest is turned
   * away with {@link WRONG_PROTOCOL}, so its page can say why, and the host is told.
   */
  public onAuth(_client: RaceClient, options: JoinOptions): boolean {
    if (options?.host === true || options?.proto === PROTOCOL) return true;

    const host = this.clients.find((client) => client.sessionId === this.state.hostId);
    const name = cleanName(options?.name) || 'A player';

    if (host) this._notice(host, 'protocol', `${name} couldn't join: their Night Run is another version.`);

    throw new ServerError(WRONG_PROTOCOL, 'another protocol');
  }

  public onJoin(client: RaceClient, options: JoinOptions): void {
    const racer = new Seat();

    if (options?.host === true && !this.state.hostId) this.state.hostId = client.sessionId;
    racer.name = this._uniqueName(cleanName(options?.name) || `Driver ${this.state.racers.size + 1}`, '');
    racer.spectator = !(this.state.phase === 'lobby' && this._freeSeat());
    racer.car = racer.spectator ? (isCar(options?.car) ? options.car : 0) : this._freeCar(options?.car, '');
    if (!racer.spectator) racer.grid = this._freeGrid();
    this.state.racers.set(client.sessionId, racer);
    this._arrived();
  }

  public onDrop(client: RaceClient): void {
    const racer = this.state.racers.get(client.sessionId);

    // Closing the party, or a kick, drops a player with nothing left to come back to.
    if (this._closing || this._kicked.delete(client.sessionId)) return;
    this._waiting.set(client.sessionId, this.allowReconnection(client, RECONNECT_SECONDS));
    if (racer) racer.connected = false;
  }

  public onReconnect(client: RaceClient): void {
    const racer = this.state.racers.get(client.sessionId);

    this._arrived();
    this._waiting.delete(client.sessionId);
    if (racer) racer.connected = true;
  }

  public onLeave(client: RaceClient): void {
    this._forget(client.sessionId);
    this._seatWaiting();
    this._closeGaps();
  }

  public onDispose(): void {
    this._kicked.clear();
    this._crossedAt.clear();
    this._fxAt.clear();
    this._waiting.clear();
    this._passingSince.clear();
    this._distances.clear();
    this._linking.clear();
    this._failedTrack.clear();
    this._order.length = 0;
    this._raw.length = 0;
  }

  /**
   * A guest's link to the host came up, or went down: the lobby shows a seat being connected to while one is up and
   * hasn't joined. The host's own transport calls these; no player can.
   * @param peerId - The guest's peer.
   * @param up - Whether the link is up.
   */
  public setLink(peerId: string, up: boolean): void {
    if (up) this._linking.set(peerId, this._now());
    else this._linking.delete(peerId);
    this.state.joining = this._linking.size;
  }

  /** Ends the party for everyone: the host is leaving */
  public close(): Promise<unknown> {
    this._closing = true;

    return this.disconnect(HOST_LEFT);
  }

  /** Room time: milliseconds since the room opened, less any time a quick race spent paused */
  private _now(): number {
    const at = this.state.paused ? this._pausedAt : performance.now();

    return Math.round(at - this._epoch - this._pausedMs);
  }

  private _pause(on: boolean): void {
    const state = this.state;

    if (on === state.paused) return;
    if (on) this._pausedAt = performance.now();
    else this._pausedMs += performance.now() - this._pausedAt;
    state.paused = on;
  }

  /** Whether `client` is the host and the race is in `phase`, when one is given; says why not otherwise */
  private _hostIn(client: RaceClient, phase?: Phase): boolean {
    if (client.sessionId !== this.state.hostId) {
      this._notice(client, 'notHost', 'Only the host can do that.');

      return false;
    }
    if (phase === undefined || this.state.phase === phase) return true;
    this._notice(client, 'wrongPhase', `That can only be done in the ${phase}.`);

    return false;
  }

  private _bot(id: unknown): Seat | undefined {
    const racer = typeof id === 'string' ? this.state.racers.get(id) : undefined;

    return racer?.isBot ? racer : undefined;
  }

  private _notice(client: RaceClient, code: NoticeCode, text: string): void {
    client.send('notice', { code, text });
  }

  private _racerCount(): number {
    let count = 0;

    for (const racer of this.state.racers.values()) if (!racer.spectator) count++;

    return count;
  }

  /** Whether a player can take a seat now, giving them the last bot's when every seat is taken */
  private _freeSeat(): boolean {
    if (this._racerCount() < MAX_RACERS) return true;

    return this._removeBot('');
  }

  /** The lowest seat no racer sits in */
  private _freeGrid(): number {
    for (let seat = 0; seat < MAX_RACERS; seat++) {
      let taken = false;

      for (const racer of this.state.racers.values()) if (!racer.spectator && racer.grid === seat) taken = true;
      if (!taken) return seat;
    }

    return 0;
  }

  /** `wanted` when no other racer drives it, or the next colour round from it that's free */
  private _freeCar(wanted: unknown, self: string): number {
    const start = isCar(wanted) ? wanted : 0;

    for (let i = 0; i < 4; i++) {
      const car = (start + i) % 4;

      if (!this._driverOf(car, self)) return car;
    }

    return start;
  }

  private _driverOf(car: number, self: string): Seat | undefined {
    for (const [id, racer] of this.state.racers) if (id !== self && !racer.spectator && racer.car === car) return racer;

    return undefined;
  }

  /** `name`, with a number after it when another racer already has it */
  private _uniqueName(name: string, self: string): string {
    const taken = (candidate: string): boolean => {
      for (const [id, racer] of this.state.racers) if (id !== self && racer.name === candidate) return true;

      return false;
    };
    let candidate = name;

    for (let n = 2; taken(candidate); n++) candidate = `${name.slice(0, NAME_LENGTH - 2)} ${n}`;

    return candidate;
  }

  private _setName(id: string, value: unknown): void {
    const racer = this.state.racers.get(id);
    const name = cleanName(value);

    if (racer && name) racer.name = this._uniqueName(name, id);
  }

  /** A clash with a bot swaps colours with it; a clash with a player is refused */
  private _setCar(client: RaceClient, car: unknown): void {
    const racer = this.state.racers.get(client.sessionId);

    if (!racer || !isCar(car) || car === racer.car) return;
    if (racer.spectator) {
      racer.car = car;

      return;
    }
    if (this.state.phase !== 'lobby') return;
    const driver = this._driverOf(car, client.sessionId);

    if (driver && !driver.isBot) {
      this._notice(client, 'carTaken', `${driver.name} drives that truck.`);

      return;
    }
    if (driver) driver.car = racer.car;
    racer.car = car;
  }

  /** A track from what a player sent, checked by the validator every screen uses */
  private _decode(code: unknown, name: unknown): TrackDef | TrackError {
    return typeof code === 'string' ? decodeTrack(code, cleanTrackName(name)) : 'characters';
  }

  private _useTrack(def: TrackDef): void {
    this.state.track = def.code;
    this.state.trackName = def.name;
    this._route = def.builtIn ? BASE_ROUTE : new Route(def.cells);
  }

  /** The host picks the track in the lobby; readiness stands, so the host can start straight away */
  private _setTrack(client: RaceClient, code: unknown, name: unknown): void {
    if (!this._hostIn(client)) return;
    if (this.state.phase !== 'lobby') {
      this._notice(client, 'badTrack', 'The track can only be changed in the lobby.');

      return;
    }
    const def = this._decode(code, name);

    if (isTrackError(def)) this._notice(client, 'badTrack', "That track can't be raced.");
    else if (def.code !== this.state.track) this._useTrack(def);
  }

  /** A guest couldn't build the party's track: the host hears it once per guest and track */
  private _trackFailed(client: RaceClient, code: unknown): void {
    const id = client.sessionId;

    if (typeof code !== 'string' || id === this.state.hostId || code !== this.state.track) return;
    if (this._failedTrack.get(id) === code) return;
    this._failedTrack.set(id, code);
    const racer = this.state.racers.get(id);
    const host = this.clients.get(this.state.hostId);

    if (racer && host) this._notice(host, 'guestTrack', `${racer.name} can't load this track.`);
  }

  private _addBot(car: unknown): boolean {
    const id = BOT_IDS.find((key) => !this.state.racers.has(key));

    if (!id || this._racerCount() >= MAX_RACERS) return false;
    const bot = new Seat();
    const names = new Set([...this.state.racers.values()].map((racer) => racer.name));

    bot.name = BOT_NAMES.find((name) => !names.has(name)) ?? id;
    bot.isBot = true;
    bot.ready = true;
    bot.car = this._freeCar(car, '');
    bot.grid = this._freeGrid();
    this.state.racers.set(id, bot);

    return true;
  }

  /** Removes bot `id`, or the last bot added when `id` is ''; false when there's no such bot */
  private _removeBot(id: string): boolean {
    let target = id;

    if (!target) for (const [key, racer] of this.state.racers) if (racer.isBot) target = key;
    if (!this._bot(target)) return false;
    this._forget(target);

    return true;
  }

  private _kick(id: string): void {
    if (id === this.state.hostId) return;
    if (this._bot(id)) {
      if (this.state.phase === 'lobby' && this._removeBot(id)) {
        this._seatWaiting();
        this._closeGaps();
      }

      return;
    }
    const client = this.clients.get(id);

    if (client) {
      this._kicked.add(id);
      client.leave(KICKED);
    } else {
      this._waiting.get(id)?.reject(false);
    }
  }

  private _forget(id: string): void {
    this.state.racers.delete(id);
    this._failedTrack.delete(id);
    this._crossedAt.delete(id);
    this._fxAt.delete(id);
    this._waiting.delete(id);
    this._passingSince.delete(id);
    this._distances.delete(id);
  }

  /** A player took a seat, or came back to one: the link that came up first is theirs */
  private _arrived(): void {
    const first = this._linking.keys().next();

    if (!first.done) this.setLink(first.value, false);
  }

  /** A seat in the racers map that is known to be there */
  private _seat(id: string): Seat {
    return this.state.racers.get(id) as Seat;
  }

  private _start(client: RaceClient, force: boolean): void {
    const waiting: string[] = [];

    for (const [id, racer] of this.state.racers) {
      if (!racer.spectator && !racer.isBot && !racer.ready && id !== this.state.hostId) waiting.push(racer.name);
    }
    if (waiting.length > 0 && !force) {
      this._notice(client, 'notReady', `Waiting for ${waiting.join(', ')}.`);

      return;
    }
    if (this._racerCount() === 0) return;
    const state = this.state;
    // The last race's finishers line up in their finishing order, everyone else behind in seat order.
    const finished = state.results.map((result) => result.id);
    const lineup = [...state.racers.entries()]
      .filter(([, racer]) => !racer.spectator)
      .sort(([a], [b]) => (finished.indexOf(a) + 1 || 99) - (finished.indexOf(b) + 1 || 99));

    lineup.forEach(([, racer], slot) => {
      racer.grid = slot;
      racer.rank = slot + 1;
      racer.lap = 0;
      racer.progress = 0;
      racer.bestLap = 0;
      racer.lastLap = 0;
      racer.finishTime = 0;
    });
    this._crossedAt.clear();
    this._passingSince.clear();
    state.results.clear();
    state.race++;
    state.goAt = this._now() + COUNTDOWN_MS;
    state.endAt = 0;
    state.lobbyAt = 0;
    state.phase = 'countdown';
  }

  private _pose(racer: Seat | undefined, msg: PoseMessage | undefined): void {
    if (!racer || racer.spectator || !msg) return;
    const { x, y, z } = msg;

    if (!finite(msg.t) || !finite(x) || !finite(y) || !finite(z) || !finite(msg.yaw)) return;
    if (Math.abs(x) > WORLD_LIMIT || Math.abs(y) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) return;
    const t = Math.round(clamp(msg.t, 0, this._now() + FUTURE_SLACK_MS));
    const pose = racer.pose;

    // Reports arrive in order; one stamped no later than the last came from a clock that stepped back.
    if (t <= pose.t) return;
    pose.t = t;
    pose.x = x;
    pose.y = y;
    pose.z = z;
    pose.yaw = wrapAngle(msg.yaw);
    pose.pitch = finite(msg.pitch) ? clamp(msg.pitch, -Math.PI, Math.PI) : 0;
    pose.roll = finite(msg.roll) ? clamp(msg.roll, -Math.PI, Math.PI) : 0;
    pose.speed = finite(msg.speed) ? clamp(msg.speed, -200, 200) : 0;
    pose.steer = finite(msg.steer) ? clamp(msg.steer, -1, 1) : 0;
    pose.drift = finite(msg.drift) ? clamp(msg.drift, 0, 1) : 0;
    pose.charge = finite(msg.charge) ? clamp(Math.round(msg.charge), 0, 3) : 0;
    pose.boosting = msg.boosting === true;
    if ((this.state.phase === 'racing' || this.state.phase === 'countdown') && racer.finishTime === 0) {
      racer.progress = finite(msg.progress)
        ? clamp(msg.progress, minProgress(this._route.lapLength), 1)
        : racer.progress;
    }
  }

  private _lap(id: unknown, racer: Seat | undefined, lap: unknown, at: unknown): void {
    const state = this.state;

    if (typeof id !== 'string' || !racer || racer.spectator || state.phase !== 'racing' || racer.finishTime > 0) return;
    if (!Number.isInteger(lap) || !finite(at)) return;
    // A report lost while a guest's link was down leaves a gap; the next one catches up, if it took long enough.
    const done = Math.min(lap as number, state.laps);
    const laps = done - racer.lap;

    if (laps < 1) return;
    const crossedAt = Math.round(Math.min(at, this._now()));
    const elapsed = crossedAt - (this._crossedAt.get(id) ?? state.goAt);

    if (crossedAt < state.goAt || elapsed < minLapMs(this._route.lapLength) * laps) return;
    const lapTime = Math.round(elapsed / laps);

    this._crossedAt.set(id, crossedAt);
    racer.lap = done;
    // The racer is on the line: the progress its last pose reported belongs to the lap before, and would put it a lap
    // ahead until the next pose arrives.
    racer.progress = 0;
    racer.lastLap = lapTime;
    // Only a lap timed on its own counts as a best; a caught-up one is an average.
    if (laps === 1) racer.bestLap = racer.bestLap > 0 ? Math.min(racer.bestLap, lapTime) : lapTime;
    if (done < state.laps) return;
    const results = state.results;
    const behind = results.length > 0 ? results[results.length - 1].time : 0;

    // Places go in the order the room hears each finish. A report that comes in late (a dropped link, or a slower
    // one in a close finish) with a crossing before the last finisher's takes the time the room heard it instead, so
    // no time in the results beats one placed above it.
    racer.finishTime = Math.max(1, crossedAt - state.goAt);
    if (racer.finishTime < behind) racer.finishTime = Math.round(this._now() - state.goAt);
    racer.progress = 1;
    state.results.push(this._result(id, racer));
    if (state.endAt === 0) state.endAt = this._now() + FINISH_GRACE_MS;
  }

  private _result(id: string, racer: Seat): Result {
    const result = new Result();

    result.id = id;
    result.name = racer.name;
    result.car = racer.car;
    result.isBot = racer.isBot;
    result.time = racer.finishTime;
    result.bestLap = racer.bestLap;

    return result;
  }

  private _fx(id: unknown, racer: Seat | undefined, msg: Intents['fx'] | undefined, from: RaceClient): void {
    const kind = msg?.kind;

    if (typeof id !== 'string' || !racer || racer.spectator || !FX_KINDS.includes(kind as FxKind)) return;
    // A bump names another racer in the race, or it's nothing.
    const target = kind === 'bump' && typeof msg?.target === 'string' ? msg.target : '';
    const hit = target ? this.state.racers.get(target) : undefined;

    if (kind === 'bump' && (!hit || hit.spectator || target === id)) return;
    const now = performance.now();

    if (now - (this._fxAt.get(id) ?? -Infinity) < FX_GAP_MS) return;
    this._fxAt.set(id, now);
    this.broadcast(
      'fx',
      { id, kind: kind as FxKind, power: finite(msg?.power) ? clamp(msg.power, 0, 1) : 1, target },
      { except: from },
    );
  }

  private _tick(): void {
    const state = this.state;
    const now = this._now();

    if (state.paused) return;
    for (const [peer, at] of this._linking) if (now - at > JOINING_MS) this.setLink(peer, false);
    if (state.phase === 'countdown' && now >= state.goAt) state.phase = 'racing';
    if (state.phase === 'countdown' || state.phase === 'racing') this._rank();
    if (state.phase === 'racing') {
      if (this._racerCount() === 0) this._toLobby();
      else if (this._everyoneFinished() || (state.endAt > 0 && now >= state.endAt)) this._closeRace(now);
    } else if (state.phase === 'results' && state.lobbyAt > 0 && now >= state.lobbyAt) {
      this._toLobby();
    }
  }

  /**
   * Places everyone racing: finishers by time, then by distance round the race. A racer takes the place ahead only
   * once it leads that racer by {@link PASS_MARGIN}, or has run ahead of its place for {@link PASS_HOLD_MS}.
   */
  private _rank(): void {
    const now = this._now();
    const order = this._order;
    const raw = this._raw;

    order.length = 0;
    raw.length = 0;
    for (const [id, racer] of this.state.racers) {
      if (racer.spectator) {
        racer.rank = 0;
        continue;
      }
      this._distances.set(id, this._distance(racer, now));
      raw.push(id);
    }
    raw.sort(this._byDistance);
    order.push(...raw);
    order.sort(this._byRank);
    for (let i = 0; i < order.length; i++) {
      const id = order[i];

      if (raw.indexOf(id) < i) {
        if (!this._passingSince.has(id)) this._passingSince.set(id, now);
      } else {
        this._passingSince.delete(id);
      }
    }
    // Bubble passes: at most one place per pair per pass, and four racers settle in three.
    for (let pass = 1; pass < order.length; pass++) {
      for (let i = order.length - 1; i > 0; i--) {
        const back = order[i];
        const front = order[i - 1];

        if (raw.indexOf(back) > raw.indexOf(front) || !this._passes(back, front, now)) continue;
        order[i] = front;
        order[i - 1] = back;
      }
    }
    for (let i = 0; i < order.length; i++) this._seat(order[i]).rank = i + 1;
  }

  /** Whether `back`, ahead of `front` on distance, takes its place now */
  private _passes(back: string, front: string, now: number): boolean {
    const a = this._seat(back);
    const b = this._seat(front);

    if (a.finishTime > 0 || b.finishTime > 0) return true;
    const lead = (this._distances.get(back) ?? 0) - (this._distances.get(front) ?? 0);

    return lead > PASS_MARGIN || now - (this._passingSince.get(back) ?? now) >= PASS_HOLD_MS;
  }

  /**
   * Metres round the race, carried on from the racer's last report to room time `now` at the speed it reported; on
   * the grid, before GO, just where it stands
   */
  private _distance(racer: Seat, now: number): number {
    const pose = racer.pose;
    const moving = this.state.phase === 'racing' && racer.finishTime === 0 && pose.t > 0;
    const ahead = moving ? clamp(now - pose.t, 0, PROJECT_MAX_MS) / 1000 : 0;

    return (racer.lap + racer.progress) * this._route.lapLength + Math.max(0, pose.speed) * ahead;
  }

  /**
   * Every racer still in the race has finished: bots, players who are connected, and players whose seat is held while
   * their link is down, so a short drop near the end doesn't cost them the race
   */
  private _everyoneFinished(): boolean {
    for (const [id, racer] of this.state.racers) {
      if (racer.spectator || racer.finishTime > 0) continue;
      if (racer.isBot || racer.connected || this._waiting.has(id)) return false;
    }

    return true;
  }

  /**
   * The race is over: whoever hasn't finished is placed behind the finishers, in the order they stand, with a time
   * projected from their pace so far, or none when they'd barely started
   */
  private _closeRace(now: number): void {
    const state = this.state;
    const elapsed = now - state.goAt;
    const lap = this._route.lapLength;
    const total = state.laps * lap;
    let last = 0;

    this._rank();
    for (const id of this._order) {
      const racer = this._seat(id);

      if (racer.finishTime > 0) continue;
      const result = this._result(id, racer);
      const distance = Math.min(total, this._distance(racer, now));

      if (distance >= lap * PROJECT_FROM && elapsed > 0) {
        last = Math.max(last, Math.round((elapsed * total) / distance));
        result.time = last;
        result.projected = true;
      }
      state.results.push(result);
    }
    state.lobbyAt = state.code === '' ? 0 : now + RESULTS_MS;
    state.phase = 'results';
  }

  /** Back to the lobby: players are no longer ready, and spectators take free seats, or bots' */
  private _toLobby(): void {
    const state = this.state;

    this._pause(false);
    state.phase = 'lobby';
    state.endAt = 0;
    state.lobbyAt = 0;
    this._crossedAt.clear();
    for (const racer of state.racers.values()) if (!racer.isBot) racer.ready = false;
    this._seatWaiting();
    this._closeGaps();
  }

  /**
   * In the lobby, the racers close up toward the front of the grid in the order they sit, so nobody waits behind an
   * open seat after someone leaves
   */
  private _closeGaps(): void {
    if (this.state.phase !== 'lobby') return;
    const seated: Seat[] = [];

    for (const racer of this.state.racers.values()) if (!racer.spectator) seated.push(racer);
    seated.sort((a, b) => a.grid - b.grid);
    for (let slot = 0; slot < seated.length; slot++) if (seated[slot].grid !== slot) seated[slot].grid = slot;
  }

  /** In the lobby, spectators take any seat that's free, or a bot's, in the order they arrived */
  private _seatWaiting(): void {
    const state = this.state;

    if (state.phase !== 'lobby') return;
    const waiting: string[] = [];

    for (const [id, racer] of state.racers) if (racer.spectator && racer.connected) waiting.push(id);
    for (const id of waiting) {
      const racer = state.racers.get(id);

      if (!racer || !this._freeSeat()) break;
      racer.car = this._freeCar(racer.car, id);
      racer.grid = this._freeGrid();
      racer.ready = false;
      racer.spectator = false;
    }
  }
}
