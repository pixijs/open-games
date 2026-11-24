/**
 * The race's shared state, as Colyseus synchronises it from the host's {@link RaceRoom} to every
 * player. Only the room writes it; players read it and send intents (`messages.ts`).
 *
 * Times are room time: milliseconds since the room opened, on the host's clock.
 * `Session.serverNow()` reads the same clock on every peer, so `goAt` is the same moment
 * everywhere.
 *
 * Every primitive has a default, because a field the room never set is never sent, and would read
 * as undefined on a client.
 */

import { schema, t } from '@colyseus/schema';
import type { SchemaType } from '@colyseus/schema';

/**
 * Where a truck is and what it's doing, as its owner last reported it (about 20 times a second):
 * enough to draw it, its body roll and its effects on another screen
 */
export const Pose = schema(
  {
    /** Room time the owner sampled this pose at; `Session.sample` interpolates on it */
    t: t.uint32().default(0),
    x: t.float32().default(0),
    y: t.float32().default(0),
    z: t.float32().default(0),
    /** Heading in radians, round the up axis */
    yaw: t.float32().default(0),
    /** The body's pitch and roll on its suspension, in radians */
    pitch: t.float32().default(0),
    roll: t.float32().default(0),
    /** Forward speed in metres a second, negative in reverse */
    speed: t.float32().default(0),
    /** Front wheels' steer, -1 (left) to 1 (right) */
    steer: t.float32().default(0),
    /** How hard it's drifting, 0 to 1 */
    drift: t.float32().default(0),
    /** The drift boost's charge level, 0 (none) to 3 */
    charge: t.uint8().default(0),
    boosting: t.boolean().default(false),
  },
  'Pose',
);
export type Pose = SchemaType<typeof Pose>;

/** A seat in the party: a player, or a bot the host drives, keyed by session id or `bot1`..`bot3`; a spectator holds one too */
export const Seat = schema(
  {
    name: t.string().default(''),
    /** Truck colour: 0 yellow, 1 green, 2 purple, 3 red; unique among the racers */
    car: t.uint8().default(0),
    /** Ready to race, in the lobby; bots are always ready */
    ready: t.boolean().default(false),
    isBot: t.boolean().default(false),
    /** False while a dropped player has 20 s to come back */
    connected: t.boolean().default(true),
    /** Watching rather than racing: joined while a race was on, or with every seat taken */
    spectator: t.boolean().default(false),
    /** Seat in the lobby and slot on the grid, 0 (pole) to 3; unique among the racers. A start lines the last race's finishers up first */
    grid: t.uint8().default(0),
    /** Laps completed this race */
    lap: t.uint8().default(0),
    /** How far round the current lap, 0 to 1, as the racer reports it; a little below 0 on the grid */
    progress: t.float32().default(0),
    /** Lap times this race, in milliseconds; 0 until a lap is done */
    bestLap: t.uint32().default(0),
    lastLap: t.uint32().default(0),
    /** Race time at the finish, in milliseconds from `goAt`; 0 until finished */
    finishTime: t.uint32().default(0),
    /** Place in the race, 1 first; 0 for spectators */
    rank: t.uint8().default(0),
    pose: Pose,
  },
  'Seat',
);
export type Seat = SchemaType<typeof Seat>;

/** One line of a race's results, copied so it outlasts a racer who leaves */
export const Result = schema(
  {
    /** The racer's key in `RaceState.racers` */
    id: t.string().default(''),
    name: t.string().default(''),
    car: t.uint8().default(0),
    isBot: t.boolean().default(false),
    /** Race time in milliseconds, or 0 for a racer who didn't finish */
    time: t.uint32().default(0),
    bestLap: t.uint32().default(0),
    /** The racer was still running when the race closed, and `time` is projected from their pace and distance */
    projected: t.boolean().default(false),
  },
  'Result',
);
export type Result = SchemaType<typeof Result>;

export type Phase = 'lobby' | 'countdown' | 'racing' | 'results';

export const RaceState = schema(
  {
    /** The party's code, five letters; '' in solo */
    code: t.string().default(''),
    /** A {@link Phase}: lobby, then countdown, racing and results, then the lobby again */
    phase: t.string().default('lobby'),
    /** Laps a race runs: 1, 2, 3 or 5, the host's pick */
    laps: t.uint8().default(3),
    /**
     * The track raced: its share code, '' for Night Run. Every screen validates it with `decodeTrack` and builds it;
     * an older host's state has no such field, which `roomTrackCode` reads as Night Run
     */
    track: t.string().default(''),
    /** The track's name, cleaned and capped as `cleanTrackName` does */
    trackName: t.string().default(''),
    /** Session id of the host's player */
    hostId: t.string().default(''),
    /** Counts races started, so a client can tell a new race from the last one */
    race: t.uint16().default(0),
    /** Room time of GO for the current race; the countdown runs up to it */
    goAt: t.uint32().default(0),
    /** Room time the race closes for whoever hasn't finished; 0 until the first racer finishes */
    endAt: t.uint32().default(0),
    /** Room time the results go back to the lobby on their own; 0 in a quick race, which waits for the player */
    lobbyAt: t.uint32().default(0),
    /** A quick race the player paused: the room's clock is stopped */
    paused: t.boolean().default(false),
    /** Guests whose link to the host is up who haven't taken their seat yet */
    joining: t.uint8().default(0),
    racers: t.map(Seat),
    /** Finishers in order as they cross the line, then, when the race closes, the rest by place */
    results: t.array(Result),
  },
  'RaceState',
);
export type RaceState = SchemaType<typeof RaceState>;
