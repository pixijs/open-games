/**
 * The track being raced, as one object every part of the game holds and reads when it needs it: the track, its route
 * and the bots' racing line. Switching tracks swaps all three in one place, so nothing keeps a stale route.
 */

import type { TrackDef } from '../track/code';
import type { RacingLine } from './line/RacingLine';
import type { Route } from './route';

/** What pure code needs of the course: a headless race passes `{ route, line }`. */
export type CourseView = { readonly route: Route; readonly line: RacingLine };

/** The track being raced. */
export class Course {
  public def: TrackDef;
  public route: Route;
  /** The bots' line; each bot takes it at the start of a race and keeps it to the end. */
  public line: RacingLine;

  constructor(def: TrackDef, route: Route, line: RacingLine) {
    this.def = def;
    this.route = route;
    this.line = line;
  }

  /**
   * Swap the track. Only a venue build calls it, before any occluder is added, since occluders keep only what's near
   * the route.
   * @param def - The track.
   * @param route - Its route.
   * @param line - Its racing line.
   */
  public set(def: TrackDef, route: Route, line: RacingLine): void {
    this.def = def;
    this.route = route;
    this.line = line;
  }
}
