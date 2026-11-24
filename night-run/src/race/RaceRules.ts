/**
 * The rules of a race, with no renderer and no physics: where each truck is along the route, laps counted through
 * checkpoints, progress, ranking, wrong-way and stuck detection, lap and finish times, the start grid and where to put a
 * truck back on the track. Feed it every truck's position each frame with {@link RaceRules.observe}, then call
 * {@link RaceRules.update}.
 */

import type { CourseView } from './course';
import type { Route, RouteSpot } from './route';
import { ROAD_HALF_WIDTH, ROAD_Y } from './route';

/** Gates per lap, the finish line included; a lap only counts once a truck has passed every one in order. */
const CHECKPOINTS = 4;
/** Most route distance one observation may add; a bigger jump is a teleport or a cut and counts for nothing. */
const MAX_STEP = 4;
/** Ground speed, world units per second, below which a racing truck counts as stuck. */
const STUCK_SPEED = 0.9;
/** Seconds below {@link STUCK_SPEED} before a truck is reported stuck. */
const STUCK_TIME = 2.5;
/** Ground speed above which a truck going against the route counts as going the wrong way. */
const WRONG_WAY_SPEED = 1.5;
/** Seconds of driving against the route before it is reported. */
const WRONG_WAY_TIME = 0.8;
/** How far past the asphalt's edge a truck may stray before it is off the track. */
const OFF_TRACK_MARGIN = 0.9;
/** How far below the road a truck has to fall to be off the track. */
const FALL_DEPTH = 1.5;

/**
 * The start grid, two by two behind the line: route distance and lateral offset per slot, pole first. Every track's
 * start is the same straight, so the grid is too.
 */
const GRID: readonly (readonly [number, number])[] = [
  [-1.5, 1.15],
  [-1.5, -1.15],
  [-3.6, 1.15],
  [-3.6, -1.15],
];

/** A place on the track and the way to face, written by {@link gridSpot} and {@link RaceRules.respawnSpot}. */
export interface TrackSpot {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * A free spot to write into.
 * @returns New spot at the origin.
 */
export function createTrackSpot(): TrackSpot {
  return { x: 0, y: 0, z: 0, yaw: 0 };
}

/**
 * Where a grid slot is.
 * @param route - The track's route.
 * @param slot - 0 for pole, up to 3; higher slots wrap round.
 * @param out - Receives the spot.
 * @returns `out`.
 */
export function gridSpot(route: Route, slot: number, out: TrackSpot): TrackSpot {
  const [s, lateral] = GRID[((slot % GRID.length) + GRID.length) % GRID.length];

  out.yaw = route.point(s, lateral, out);

  return out;
}

/** Route distance of a grid slot; negative, since the grid is behind the line. */
export function gridDistance(slot: number): number {
  return GRID[((slot % GRID.length) + GRID.length) % GRID.length][0];
}

/** One racer's standing in the race. */
export interface RacerProgress {
  readonly id: string;
  /** Grid slot, which also breaks ties before the start. */
  slot: number;
  /** Route distance since the start line; negative on the grid, the lap's length times the laps at the flag. */
  distance: number;
  /** Where on the lap, 0 to the lap's length. */
  lapS: number;
  /** Offset to the driver's right of the centreline. */
  lateral: number;
  /** Heading of the route here, as a yaw. */
  routeHeading: number;
  /** Laps completed. */
  lap: number;
  /** The next checkpoint to pass on this lap, 1 to {@link CHECKPOINTS}; the last is the line. */
  checkpoint: number;
  /** 0 on the grid to 1 at the flag. */
  progress: number;
  /** Place in the race, 1 first. */
  rank: number;
  /** Driving against the route. */
  wrongWay: boolean;
  /** Too slow for too long while racing. */
  stuck: boolean;
  /** Off the asphalt or fallen off the world. */
  offTrack: boolean;
  /** Took the flag. */
  finished: boolean;
  /** Race time at the flag, or -1. */
  finishTime: number;
  /** 1 for the winner, or 0 until it finishes. */
  finishPlace: number;
  /** Race time this lap started. */
  lapStart: number;
  /** The last completed lap's time, or -1. */
  lastLap: number;
  /** Fastest completed lap, or -1. */
  bestLap: number;
  /** Ground speed at the last observation, world units per second. */
  speed: number;
  /** Seconds spent below the stuck speed, and driving the wrong way. */
  slowTime: number;
  wrongTime: number;
  /** Last observed position, for speed and direction of travel. */
  lastX: number;
  lastZ: number;
  observed: boolean;
}

const _spot: RouteSpot = { s: 0, lateral: 0, heading: 0 };

function byStanding(a: RacerProgress, b: RacerProgress): number {
  if (a.finished !== b.finished) return a.finished ? -1 : 1;
  if (a.finished) return a.finishPlace - b.finishPlace;
  if (a.distance !== b.distance) return b.distance - a.distance;

  return a.slot - b.slot;
}

/** A race: entries, its clock and its standings. */
export class RaceRules {
  /** Laps to win. */
  public laps: number;
  /** Seconds since the green light; 0 until {@link RaceRules.start}. */
  public time = 0;
  /** Whether the clock runs: from the green light until {@link RaceRules.reset}. */
  public running = false;
  /** Every racer, in the order added. */
  public readonly entries: RacerProgress[] = [];
  /** Every racer, first place first; refreshed by {@link RaceRules.update}. */
  public readonly standings: RacerProgress[] = [];
  /** How many have taken the flag. */
  public finishedCount = 0;

  /** Called when a racer completes a lap that isn't its last, with that lap's time. */
  public onLap: ((entry: RacerProgress, lapTime: number) => void) | null = null;
  /** Called when a racer takes the flag. */
  public onFinish: ((entry: RacerProgress) => void) | null = null;

  private readonly _course: CourseView;

  /**
   * @param course - The track raced, read as each call needs it.
   * @param laps - Laps to win.
   */
  constructor(course: CourseView, laps = 3) {
    this._course = course;
    this.laps = laps;
  }

  /** Total route distance of the race. */
  public get length(): number {
    return this.laps * this._course.route.lapLength;
  }

  /**
   * Enter a racer, on a grid slot, at the back of the standings.
   * @param id - Racer id.
   * @param slot - Grid slot.
   * @returns Its progress.
   */
  public add(id: string, slot: number): RacerProgress {
    const entry: RacerProgress = {
      id,
      slot,
      distance: 0,
      lapS: 0,
      lateral: 0,
      routeHeading: 0,
      lap: 0,
      checkpoint: 1,
      progress: 0,
      rank: this.entries.length + 1,
      wrongWay: false,
      stuck: false,
      offTrack: false,
      finished: false,
      finishTime: -1,
      finishPlace: 0,
      lapStart: 0,
      lastLap: -1,
      bestLap: -1,
      speed: 0,
      slowTime: 0,
      wrongTime: 0,
      lastX: 0,
      lastZ: 0,
      observed: false,
    };

    this._resetEntry(entry);
    this.entries.push(entry);
    this.standings.push(entry);

    return entry;
  }

  /**
   * Take a racer out of the race.
   * @param id - Racer id.
   */
  public remove(id: string): void {
    const entry = this.get(id);

    if (!entry) return;

    this.entries.splice(this.entries.indexOf(entry), 1);
    this.standings.splice(this.standings.indexOf(entry), 1);

    if (entry.finished) this.finishedCount--;

    this._rank();
  }

  /**
   * A racer's progress.
   * @param id - Racer id.
   * @returns Its progress, or undefined.
   */
  public get(id: string): RacerProgress | undefined {
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i].id === id) return this.entries[i];
    }

    return undefined;
  }

  /**
   * Back to the grid for a new race: clocks, laps and times cleared, each racer on its slot.
   * @param laps - Laps to win.
   */
  public reset(laps = this.laps): void {
    this.laps = laps;
    this.time = 0;
    this.running = false;
    this.finishedCount = 0;

    for (let i = 0; i < this.entries.length; i++) this._resetEntry(this.entries[i]);

    this._rank();
  }

  /** The green light: the clock starts at 0 and every lap timer with it. */
  public start(): void {
    this.time = 0;
    this.running = true;

    for (let i = 0; i < this.entries.length; i++) this.entries[i].lapStart = 0;
  }

  /**
   * Where a truck is this frame. Call once a frame per truck, before {@link RaceRules.update}.
   * @param id - Racer id.
   * @param x - Root position, x.
   * @param y - Root position, y.
   * @param z - Root position, z.
   * @param dt - Seconds since its last observation.
   */
  public observe(id: string, x: number, y: number, z: number, dt: number): void {
    const entry = this.get(id);

    if (!entry) return;

    const route = this._course.route;

    route.project(x, z, _spot);

    const delta = wrapDelta(_spot.s - entry.lapS, route.lapLength);

    if (entry.observed && dt > 0) {
      const mx = x - entry.lastX;
      const mz = z - entry.lastZ;
      const speed = Math.hypot(mx, mz) / dt;
      const along = speed > 0 ? (mx * Math.sin(_spot.heading) + mz * Math.cos(_spot.heading)) / (speed * dt) : 0;

      entry.speed = speed;
      entry.wrongTime =
        speed > WRONG_WAY_SPEED && along < -0.3 ? entry.wrongTime + dt : Math.max(0, entry.wrongTime - dt * 2);
      entry.slowTime = this.running && !entry.finished && speed < STUCK_SPEED ? entry.slowTime + dt : 0;
    }

    entry.wrongWay = entry.wrongTime > WRONG_WAY_TIME;
    entry.stuck = entry.slowTime > STUCK_TIME;
    entry.offTrack = Math.abs(_spot.lateral) > ROAD_HALF_WIDTH + OFF_TRACK_MARGIN || y < ROAD_Y - FALL_DEPTH;
    entry.lastX = x;
    entry.lastZ = z;
    entry.observed = true;
    entry.lapS = _spot.s;
    entry.lateral = _spot.lateral;
    entry.routeHeading = _spot.heading;

    if (Math.abs(delta) > MAX_STEP || entry.finished) return;

    // Before the green light a truck can only shuffle on the grid; nothing it does there counts.
    if (!this.running) {
      entry.distance = Math.min(entry.distance + delta, 0);

      return;
    }

    entry.distance += delta;
    this._checkpoints(entry, delta, dt, route.lapLength);
  }

  /**
   * Pick a racer's race up where it left off, as a page reloaded mid-race does: its distance and laps, worked out from
   * positions again from here on, with this lap timed from now.
   * @param id - Racer id.
   * @param distance - Route distance since the start line.
   * @param lap - Laps completed.
   */
  public restore(id: string, distance: number, lap: number): void {
    const entry = this.get(id);

    if (!entry) return;

    const route = this._course.route;
    const length = route.lapLength;
    const gate = length / CHECKPOINTS;

    entry.distance = distance;
    entry.lap = lap;
    entry.lapS = route.wrap(distance);
    entry.checkpoint = Math.max(1, Math.min(CHECKPOINTS, Math.floor((distance - lap * length) / gate) + 1));
    entry.lapStart = this.time;
    entry.observed = false;
  }

  /**
   * Advance the clock and re-rank. Call once a frame after observing every truck.
   * @param dt - Seconds since the last update.
   */
  public update(dt: number): void {
    if (this.running) this.time += dt;

    const length = this.length;

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];

      entry.progress = entry.finished ? 1 : Math.min(1, Math.max(0, entry.distance / length));
    }

    this._rank();
  }

  /**
   * Where to put a truck back on the track: on the route where it is, near the middle of the road, facing the way
   * the race goes. Forgets that it was stuck.
   * @param id - Racer id.
   * @param out - Receives the spot.
   * @returns `out`, or null for an unknown racer.
   */
  public respawnSpot(id: string, out: TrackSpot): TrackSpot | null {
    const entry = this.get(id);

    if (!entry) return null;

    const lateral = Math.max(-1.4, Math.min(1.4, entry.lateral));

    out.yaw = this._course.route.point(entry.lapS, lateral, out);
    entry.lateral = lateral;
    entry.slowTime = 0;
    entry.wrongTime = 0;
    entry.stuck = false;
    entry.wrongWay = false;
    entry.offTrack = false;
    entry.lastX = out.x;
    entry.lastZ = out.z;

    return out;
  }

  /**
   * Forget the trucks' last positions, so a truck moved by hand (to the grid, or respawned) isn't seen as driving there.
   * @param id - Racer id, or omit for everyone.
   */
  public forgetMotion(id?: string): void {
    for (let i = 0; i < this.entries.length; i++) {
      if (id === undefined || this.entries[i].id === id) this.entries[i].observed = false;
    }
  }

  private _resetEntry(entry: RacerProgress): void {
    entry.distance = gridDistance(entry.slot);
    entry.lapS = this._course.route.wrap(entry.distance);
    entry.lateral = 0;
    entry.lap = 0;
    entry.checkpoint = 1;
    entry.progress = 0;
    entry.wrongWay = false;
    entry.stuck = false;
    entry.offTrack = false;
    entry.finished = false;
    entry.finishTime = -1;
    entry.finishPlace = 0;
    entry.lapStart = 0;
    entry.lastLap = -1;
    entry.bestLap = -1;
    entry.speed = 0;
    entry.slowTime = 0;
    entry.wrongTime = 0;
    entry.observed = false;
  }

  /** Pass checkpoints in order; the line completes a lap only after all of them. */
  private _checkpoints(entry: RacerProgress, delta: number, dt: number, length: number): void {
    const gate = length / CHECKPOINTS;

    while (entry.checkpoint < CHECKPOINTS && entry.distance >= entry.lap * length + entry.checkpoint * gate) {
      entry.checkpoint++;
    }

    const line = (entry.lap + 1) * length;

    if (entry.checkpoint < CHECKPOINTS || entry.distance < line) return;

    // When in this step the nose crossed the line, so lap times don't snap to frames.
    const over = delta > 0 ? Math.min(1, (entry.distance - line) / delta) : 0;
    const at = this.time - over * dt;
    const lapTime = at - entry.lapStart;

    entry.lap++;
    entry.checkpoint = 1;
    entry.lastLap = lapTime;
    entry.bestLap = entry.bestLap < 0 ? lapTime : Math.min(entry.bestLap, lapTime);
    entry.lapStart = at;

    if (entry.lap >= this.laps) this._finish(entry, at);
    else this.onLap?.(entry, lapTime);
  }

  private _finish(entry: RacerProgress, at: number): void {
    entry.finished = true;
    entry.finishTime = at;
    entry.finishPlace = ++this.finishedCount;
    entry.distance = Math.max(entry.distance, this.length);
    entry.progress = 1;
    this.onFinish?.(entry);
  }

  private _rank(): void {
    const standings = this.standings;

    standings.sort(byStanding);

    for (let i = 0; i < standings.length; i++) standings[i].rank = i + 1;
  }
}

/** A change in lap position, the short way round a lap of length `lap`. */
function wrapDelta(d: number, lap: number): number {
  const half = lap / 2;

  if (d > half) return d - lap;
  if (d < -half) return d + lap;

  return d;
}
