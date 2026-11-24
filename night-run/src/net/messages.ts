/**
 * The messages between players and the host's room, and the race's fixed numbers. Players send
 * intents; the room checks every field by hand and ignores, or answers with a `notice`, what it
 * can't allow. The room sends back what state alone can't say: a remote truck's boost, wall hit
 * or bump, and the clock's pongs.
 */

import { BASE_LAP_LENGTH } from '../race/route';

export { MAX_CODE_LENGTH, TRACK_NAME_LENGTH } from '../track/code';

/**
 * The version of these messages and the state a page speaks, which a guest sends as `JoinOptions.proto`. The room
 * turns away a guest that speaks another: an older cached page would race Night Run among players on a custom track
 */
export const PROTOCOL = 2;

export const MAX_RACERS = 4;
/** Racers and spectators together */
export const MAX_PEOPLE = 8;
/** Lap counts the host can pick, and the one a party starts with */
export const LAP_CHOICES: readonly number[] = [1, 2, 3, 5];
export const DEFAULT_LAPS = 3;
/** From the host pressing start to GO, in milliseconds: a second and a half on the grid, then 3, 2, 1 */
export const COUNTDOWN_MS = 4500;
/** How long the race stays open for the others after the first racer finishes */
export const FINISH_GRACE_MS = 30000;
/** How long the results show before the room goes back to the lobby on its own */
export const RESULTS_MS = 20000;
/** How long a dropped player's seat waits for them */
export const RECONNECT_SECONDS = 20;
/** The longest name a player can show */
export const NAME_LENGTH = 16;
/**
 * Lap progress a truck on the grid may report, behind the line: the back row is 3.6 m back, 0.05 of Night Run's 110 m
 * lap, and the same 5.5 m on any track
 */
export function minProgress(lap: number): number {
  return -0.05 * (BASE_LAP_LENGTH / lap);
}

/** The shortest lap the room believes, in milliseconds; a faster report is a double count. 3 s on Night Run */
export function minLapMs(lap: number): number {
  return 3000 * (lap / BASE_LAP_LENGTH);
}

/** A remote truck's moment worth a sound or an effect; a bump names the truck it hit as the fx's `target` */
export type FxKind = 'boost' | 'wall' | 'bump';

/** A truck's pose, as its owner sends it; the room stores it in `Seat.pose` and `Seat.progress` */
export interface PoseMessage {
  /** Room time the pose was sampled at */
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  speed: number;
  steer: number;
  drift: number;
  charge: number;
  boosting: boolean;
  /** How far round the current lap, 0 to 1, or down to {@link minProgress} on the grid behind the line */
  progress: number;
}

/** What players send, by message type. Bot messages and everything below `start` are the host's only */
export interface Intents {
  setName: { name: string };
  setCar: { car: number };
  setReady: { ready: boolean };
  /** A guest that can't build the room's track `code` says so before it leaves; the room tells the host */
  trackFailed: { code: string };
  /** Sent about 20 times a second by `Session.sendPose` */
  pose: PoseMessage;
  /** Lap `lap` (laps completed, from 1) was done at room time `at`; the last one finishes the race */
  lap: { lap: number; at: number };
  /** Played on the sender's screen; the room passes it to everyone else */
  fx: { kind: FxKind; power: number; target?: string };
  /** The clock sync's question: the sender's `performance.now()` */
  ping: { c: number };
  setLaps: { laps: number };
  /** In the lobby: race track `code`, a share code ('' for Night Run), called `name` */
  setTrack: { code: string; name: string };
  addBot: { car: number };
  /** Removes bot `id`, or the last one added when it's '' */
  removeBot: { id: string };
  kick: { id: string };
  /** Starts the countdown; `force` starts it even when not everyone is ready */
  start: { force: boolean };
  /** Back to the lobby: from the results, or calling off a race */
  rematch: Record<string, never>;
  /** Closes the race now: everyone goes to the results with the places as they stand */
  endRace: Record<string, never>;
  /** A quick race only: stops the room's clock, or starts it again */
  pause: { on: boolean };
  botPose: PoseMessage & { id: string };
  botLap: { id: string; lap: number; at: number };
  botFx: { id: string; kind: FxKind; power: number; target?: string };
}

/**
 * Why the room turned an intent down; `guestTrack` tells the host a guest couldn't build the party's track, and
 * `protocol` that one on another version of the game couldn't join
 */
export type NoticeCode =
  'carTaken' | 'notReady' | 'full' | 'notHost' | 'wrongPhase' | 'badTrack' | 'guestTrack' | 'protocol';

/** What the room sends, by message type */
export interface Broadcasts {
  /** Racer `id`'s boost, wall hit, or bump into racer `target`, to everyone but the racer's own screen */
  fx: { id: string; kind: FxKind; power: number; target: string };
  /** The clock sync's answer: the ping's `c`, and room time `s` when the room read it */
  pong: { c: number; s: number };
  /** A short line for one player, such as why an intent was refused */
  notice: { code: NoticeCode; text: string };
}

/** Where a guest's page keeps its seat's reconnection token, in sessionStorage, so a reload takes the seat back */
export const seatKey = (code: string): string => `nightrun:seat:${code}`;

/** The close code every player gets when the host ends the party */
export const HOST_LEFT = 4011;
/** The close code a player gets when the host removes them */
export const KICKED = 4012;
/** The error code a guest's join fails with when its page speaks another {@link PROTOCOL} than the room */
export const WRONG_PROTOCOL = 4013;
