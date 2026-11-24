/**
 * A circuit as a route: one centreline loop from the finish line, and the maths to go from route distance to a world
 * point and back. Pure and renderer-free, so the race rules, the bots and the netcode can all run it.
 *
 * Route distance `s` counts along the centreline from the finish line, in world units. Lateral offset is to the
 * driver's right of the centreline. Every track puts its finish cell at grid (0, 0) heading +z, so the finish line,
 * the arch and everything staged round them are the same on every track.
 */

import type { Cell } from '../track/code';
import { BASE_TRACK } from '../track/code';

/** One track cell, in world units. */
export const CELL = 7.4925;

/** Height of a truck's root when its wheels are on the asphalt. */
export const ROAD_Y = -0.115;

/** Half the drivable width; the walls stand a little outside it. */
export const ROAD_HALF_WIDTH = 3.3;

const HALF = CELL / 2;
const ARC = (Math.PI / 2) * HALF;
const QUARTER = Math.PI / 2;

/** One cell's stretch of centreline; the finish cell is split in two at the line. */
export interface RouteSegment {
  /** Route distance where the segment starts. */
  readonly s: number;
  readonly length: number;
  /** Start point, x and z. */
  readonly x: number;
  readonly z: number;
  /** Travel direction at the start, as a grid step. */
  readonly inX: number;
  readonly inZ: number;
  /** Travel direction at the end; equal to `in` on a straight. */
  readonly outX: number;
  readonly outZ: number;
  /** 1 for a right-hander, -1 for a left-hander, 0 on a straight. */
  readonly turn: -1 | 0 | 1;
}

/** Anything with x, y and z to write a point into; a pixi `Vector3` works. */
export interface PointOut {
  x: number;
  y: number;
  z: number;
}

/** Where a world point lies on the route, written by {@link Route.project}. */
export interface RouteSpot {
  /** Route distance of the nearest centreline point, 0 to the lap's length. */
  s: number;
  /** Offset to the driver's right of the centreline. */
  lateral: number;
  /** Heading of the centreline there, as a yaw. */
  heading: number;
}

/** A track's centreline, from its cells. Built once per track; every query is allocation-free. */
export class Route {
  /** Grid cells in driving order, starting at the finish cell. */
  public readonly cells: readonly Cell[];
  /** Centreline from the finish line, one segment per cell, with the finish cell split at the line. */
  public readonly segments: readonly RouteSegment[];
  /** Centreline length of one lap. */
  public readonly lapLength: number;
  /** The road cells' bounding box, in grid cells. */
  public readonly box: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number };

  /** @param cells - A validated track's cells, finish cell first at [0, 0] and the next at [0, 1]. */
  constructor(cells: readonly Cell[]) {
    this.cells = cells;
    this.segments = buildSegments(cells);

    const last = this.segments[this.segments.length - 1];

    this.lapLength = last.s + last.length;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (const [x, z] of cells) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }

    this.box = { minX, maxX, minZ, maxZ };
  }

  /**
   * Route distance wrapped into one lap.
   * @param s - Any route distance.
   * @returns The same place on the lap, 0 to {@link Route.lapLength}.
   */
  public wrap(s: number): number {
    const lap = this.lapLength;

    return ((s % lap) + lap) % lap;
  }

  /**
   * A point on the track. `s` is route distance along the centreline from the finish line (any value; it wraps
   * every lap); `lateral` is the offset to the driver's right. Writes x and z, and y = {@link ROAD_Y}.
   * @param s - Route distance.
   * @param lateral - Offset to the driver's right, in world units.
   * @param out - Receives the point.
   * @returns Heading at `s`, as a yaw: forward is `(sin yaw, 0, cos yaw)`.
   */
  public point(s: number, lateral: number, out: PointOut): number {
    const local = this.wrap(s);
    const seg = this._segmentAt(local);
    const d = local - seg.s;
    let x: number;
    let z: number;
    let fx: number;
    let fz: number;

    if (seg.turn === 0) {
      x = seg.x + seg.inX * d;
      z = seg.z + seg.inZ * d;
      fx = seg.inX;
      fz = seg.inZ;
    } else {
      // Quarter arc round the cell corner shared by the entry and exit edges; radius vector turns from -out to in.
      const a = (d / seg.length) * QUARTER;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const pivotX = seg.x + seg.outX * HALF;
      const pivotZ = seg.z + seg.outZ * HALF;

      x = pivotX + HALF * (-c * seg.outX + sn * seg.inX);
      z = pivotZ + HALF * (-c * seg.outZ + sn * seg.inZ);
      fx = sn * seg.outX + c * seg.inX;
      fz = sn * seg.outZ + c * seg.inZ;
    }

    // The driver's right of forward (fx, fz) is (-fz, fx).
    out.x = x - fz * lateral;
    out.y = ROAD_Y;
    out.z = z + fx * lateral;

    return Math.atan2(fx, fz);
  }

  /**
   * Which way the track bends at `s`.
   * @param s - Route distance.
   * @returns 1 for a right-hander, -1 for a left-hander, 0 on a straight.
   */
  public turn(s: number): -1 | 0 | 1 {
    return this._segmentAt(this.wrap(s)).turn;
  }

  /**
   * Route distance from `s` to the start of the next corner, 0 inside one.
   * @param s - Route distance.
   * @param limit - Furthest to look.
   * @returns Distance to the corner, or `limit` when none starts that close.
   */
  public distanceToTurn(s: number, limit: number): number {
    const segments = this.segments;
    const local = this.wrap(s);
    let seg = this._segmentAt(local);

    if (seg.turn !== 0) return 0;

    let ahead = seg.s + seg.length - local;
    let index = segments.indexOf(seg);

    while (ahead < limit) {
      index = (index + 1) % segments.length;
      seg = segments[index];

      if (seg.turn !== 0) return ahead;

      ahead += seg.length;
    }

    return limit;
  }

  /**
   * The nearest point on the centreline to a world point: its route distance, the point's offset from it and the
   * route's heading there.
   * @param x - World x.
   * @param z - World z.
   * @param out - Receives the spot.
   * @returns `out`.
   */
  public project(x: number, z: number, out: RouteSpot): RouteSpot {
    const segments = this.segments;
    let best = Infinity;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      let cx: number;
      let cz: number;
      let fx: number;
      let fz: number;
      let d: number;

      if (seg.turn === 0) {
        d = Math.min(seg.length, Math.max(0, (x - seg.x) * seg.inX + (z - seg.z) * seg.inZ));
        cx = seg.x + seg.inX * d;
        cz = seg.z + seg.inZ * d;
        fx = seg.inX;
        fz = seg.inZ;
      } else {
        const pivotX = seg.x + seg.outX * HALF;
        const pivotZ = seg.z + seg.outZ * HALF;
        const vx = x - pivotX;
        const vz = z - pivotZ;
        const a = Math.min(
          QUARTER,
          Math.max(0, Math.atan2(vx * seg.inX + vz * seg.inZ, -(vx * seg.outX + vz * seg.outZ))),
        );
        const c = Math.cos(a);
        const sn = Math.sin(a);

        cx = pivotX + HALF * (-c * seg.outX + sn * seg.inX);
        cz = pivotZ + HALF * (-c * seg.outZ + sn * seg.inZ);
        fx = sn * seg.outX + c * seg.inX;
        fz = sn * seg.outZ + c * seg.inZ;
        d = (a / QUARTER) * seg.length;
      }

      const ox = x - cx;
      const oz = z - cz;
      const distance = ox * ox + oz * oz;

      if (distance < best) {
        best = distance;
        out.s = this.wrap(seg.s + d);
        out.lateral = -fz * ox + fx * oz;
        out.heading = Math.atan2(fx, fz);
      }
    }

    return out;
  }

  /** A linear scan: a track has at most 128 segments. */
  private _segmentAt(s: number): RouteSegment {
    const segments = this.segments;

    for (let i = segments.length - 1; i > 0; i--) {
      if (s >= segments[i].s) return segments[i];
    }

    return segments[0];
  }
}

function buildSegments(cells: readonly Cell[]): RouteSegment[] {
  const n = cells.length;
  const segments: RouteSegment[] = [];
  let s = 0;

  const push = (x: number, z: number, length: number, inX: number, inZ: number, outX: number, outZ: number) => {
    const cross = inX * outZ - inZ * outX;

    // A right turn takes forward toward the driver's right, (-fz, fx), which makes the cross product positive.
    segments.push({ s, length, x, z, inX, inZ, outX, outZ, turn: cross === 0 ? 0 : cross > 0 ? 1 : -1 });
    s += length;
  };

  // The finish cell is straight; the line is at its centre.
  const fx = cells[1][0] - cells[0][0];
  const fz = cells[1][1] - cells[0][1];
  const cx0 = (cells[0][0] + 0.5) * CELL;
  const cz0 = (cells[0][1] + 0.5) * CELL;

  push(cx0, cz0, HALF, fx, fz, fx, fz);

  for (let i = 1; i < n; i++) {
    const [gx, gz] = cells[i];
    const [px, pz] = cells[i - 1];
    const [nx, nz] = cells[(i + 1) % n];
    const inX = gx - px;
    const inZ = gz - pz;
    const outX = nx - gx;
    const outZ = nz - gz;
    const cx = (gx + 0.5) * CELL;
    const cz = (gz + 0.5) * CELL;
    const straight = inX === outX && inZ === outZ;

    push(cx - inX * HALF, cz - inZ * HALF, straight ? CELL : ARC, inX, inZ, outX, outZ);
  }

  push(cx0 - fx * HALF, cz0 - fz * HALF, HALF, fx, fz, fx, fz);

  return segments;
}

/** Night Run's route. */
export const BASE_ROUTE = new Route(BASE_TRACK.cells);

/** Night Run's lap, the length the room's limits and the attract start are scaled from. */
export const BASE_LAP_LENGTH = BASE_ROUTE.lapLength;

/** The finish line's centre, under the arch; every route starts here heading +z. */
export const FINISH_LINE: Readonly<{ x: number; y: number; z: number }> = { x: HALF, y: ROAD_Y, z: HALF };

/** Top of the finish arch, where confetti comes from. */
export const ARCH_TOP: Readonly<{ x: number; y: number; z: number }> = { x: HALF, y: 3.6, z: HALF };
