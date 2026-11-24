import type { CourseView } from './race/course';

/** What a solid is, the first of its {@link STRIDE} floats. */
const CONE = 0;
const BOX = 1;
const ARCH = 2;
const STRIDE = 8;
/** Solids further than this from the route's centreline are never between a race camera and a truck. */
const REACH = 16;
/** Samples a segment this far apart, in metres, where it passes a solid. */
const STEP = 0.18;
/** Room for the densest venue: a forested band round a 126-cell track keeps about 12 solids a road cell. */
const MAX_SOLIDS = 2048;

const _spot = { s: 0, lateral: 0, heading: 0 };

/**
 * The scenery a race camera keeps out of and sees past, as simple solids built from the set's layout: upright cones on
 * trunks for trees, upright columns for poles, boxes for signs, beams and tent roofs, and the finish arch's half ring.
 * The track pieces and the night set add theirs as they're built; the cameras ask whether a line of sight is clear.
 *
 * Every query is allocation-free, and only solids near the track are kept.
 */
export class Occluders {
  /** How many solids there are. */
  private _count = 0;
  /** Solids refused because the table was full, since the last {@link Occluders.clear}. */
  private _dropped = 0;
  private readonly _course: CourseView;

  /** Per solid: its kind and shape, {@link STRIDE} floats. */
  private readonly _solids = new Float32Array(MAX_SOLIDS * STRIDE);
  /** Per solid: the centre and radius of a circle on the ground that holds it. */
  private readonly _bounds = new Float32Array(MAX_SOLIDS * 3);

  /** Whether to time every query, as `?debug` asks; off, a query costs one more branch. */
  public timing = false;
  private _queryMs = 0;
  private _queries = 0;

  /** @param course - The track; only solids near its road are kept, judged as each is added. */
  constructor(course: CourseView) {
    this._course = course;
  }

  /** How many solids the cameras see past. */
  public get count(): number {
    return this._count;
  }

  /** Solids refused for a full table since the last {@link Occluders.clear}; any is a camera clipping a tree. */
  public get dropped(): number {
    return this._dropped;
  }

  /**
   * The time spent in queries, and how many, since the last call; nothing unless {@link Occluders.timing} is on.
   * @returns Milliseconds and queries.
   */
  public takeQueryTime(): { ms: number; queries: number } {
    const taken = { ms: this._queryMs, queries: this._queries };

    this._queryMs = 0;
    this._queries = 0;

    return taken;
  }

  /** Forget every solid, for another track's; add them again only once the course has the new route. */
  public clear(): void {
    this._count = 0;
    this._dropped = 0;
  }

  /**
   * An upright cone on a trunk, as a pine tree is: a trunk from `bottom` to `crown`, then a crown narrowing from
   * `radius` at `crown` to a point at `top`. A column is a cone whose crown starts at its top.
   */
  public addCone(
    x: number,
    z: number,
    bottom: number,
    crown: number,
    top: number,
    radius: number,
    trunk: number,
  ): void {
    const at = this._add(x, z, Math.max(radius, trunk));

    if (at < 0) return;

    const s = this._solids;

    s[at] = CONE;
    s[at + 1] = x;
    s[at + 2] = z;
    s[at + 3] = bottom;
    s[at + 4] = crown;
    s[at + 5] = top;
    s[at + 6] = radius;
    s[at + 7] = trunk;
  }

  /** An upright column, such as a pole. */
  public addColumn(x: number, z: number, bottom: number, top: number, radius: number): void {
    this.addCone(x, z, bottom, top, top, radius, radius);
  }

  /**
   * A box turned about the vertical.
   * @param x - Centre, x.
   * @param y - Centre, y.
   * @param z - Centre, z.
   * @param hx - Half its size along its own x.
   * @param hy - Half its height.
   * @param hz - Half its size along its own z.
   * @param yaw - Its turn: its own +z points along `(sin yaw, 0, cos yaw)`.
   */
  public addBox(x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number): void {
    const at = this._add(x, z, Math.hypot(hx, hz));

    if (at < 0) return;

    const s = this._solids;

    s[at] = BOX;
    s[at + 1] = x;
    s[at + 2] = y;
    s[at + 3] = z;
    s[at + 4] = hx;
    s[at + 5] = hy;
    s[at + 6] = hz;
    s[at + 7] = yaw;
  }

  /**
   * A half ring standing across the x axis, as the finish arch does: the band between `inner` and `outer` from its
   * centre, above the centre, `halfDepth` either side of it along z.
   */
  public addArch(x: number, y: number, z: number, inner: number, outer: number, halfDepth: number): void {
    const at = this._add(x, z, Math.hypot(outer, halfDepth));

    if (at < 0) return;

    const s = this._solids;

    s[at] = ARCH;
    s[at + 1] = x;
    s[at + 2] = y;
    s[at + 3] = z;
    s[at + 4] = inner;
    s[at + 5] = outer;
    s[at + 6] = halfDepth;
  }

  /**
   * Whether a point lies inside any solid, each grown by `pad`.
   * @param x - Point, x.
   * @param y - Point, y.
   * @param z - Point, z.
   * @param pad - How far outside a solid still counts as in it.
   */
  public contains(x: number, y: number, z: number, pad: number): boolean {
    if (!this.timing) return this._contains(x, y, z, pad);

    const start = performance.now();
    const inside = this._contains(x, y, z, pad);

    this._took(start);

    return inside;
  }

  /**
   * How far along a segment it first meets a solid, each grown by `pad`.
   * @param ax - Start, x.
   * @param ay - Start, y.
   * @param az - Start, z.
   * @param bx - End, x.
   * @param by - End, y.
   * @param bz - End, z.
   * @param pad - How far outside a solid still blocks.
   * @returns The fraction of the way from start to end, 0 to 1, or 1 when the segment is clear.
   */
  public segmentHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad: number): number {
    if (!this.timing) return this._segmentHit(ax, ay, az, bx, by, bz, pad);

    const start = performance.now();
    const hit = this._segmentHit(ax, ay, az, bx, by, bz, pad);

    this._took(start);

    return hit;
  }

  private _took(start: number): void {
    this._queryMs += performance.now() - start;
    this._queries++;
  }

  private _contains(x: number, y: number, z: number, pad: number): boolean {
    const bounds = this._bounds;

    for (let i = 0; i < this._count; i++) {
      const reach = bounds[i * 3 + 2] + pad;
      const dx = x - bounds[i * 3];
      const dz = z - bounds[i * 3 + 1];

      if (dx * dx + dz * dz < reach * reach && this._inside(i, x, y, z, pad)) return true;
    }

    return false;
  }

  private _segmentHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad: number): number {
    const bounds = this._bounds;
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const flat2 = dx * dx + dz * dz;
    const length = Math.sqrt(flat2 + dy * dy);
    let first = 1;

    for (let i = 0; i < this._count; i++) {
      const cx = bounds[i * 3];
      const cz = bounds[i * 3 + 1];
      const reach = bounds[i * 3 + 2] + pad;
      // The stretch of the segment whose footprint passes within `reach` of the solid's centre.
      const t0 = flat2 > 1e-8 ? Math.min(1, Math.max(0, ((cx - ax) * dx + (cz - az) * dz) / flat2)) : 0;
      const px = ax + dx * t0 - cx;
      const pz = az + dz * t0 - cz;
      const miss = reach * reach - (px * px + pz * pz);

      if (miss < 0) continue;

      const half = flat2 > 1e-8 ? Math.sqrt(miss / flat2) : 1;
      const from = Math.max(0, t0 - half);
      const to = Math.min(first, t0 + half);
      const steps = Math.ceil(((to - from) * length) / STEP);

      for (let k = 0; k <= steps; k++) {
        const t = steps > 0 ? from + ((to - from) * k) / steps : from;

        if (this._inside(i, ax + dx * t, ay + dy * t, az + dz * t, pad)) {
          first = t;
          break;
        }
      }
    }

    return first;
  }

  /** Keep a solid's bounds; returns where its shape goes, or -1 when it's off the track's reach or the list is full. */
  private _add(x: number, z: number, radius: number): number {
    if (Math.abs(this._course.route.project(x, z, _spot).lateral) > REACH + radius) return -1;

    if (this._count >= MAX_SOLIDS) {
      this._dropped++;

      return -1;
    }

    const i = this._count++;

    this._bounds[i * 3] = x;
    this._bounds[i * 3 + 1] = z;
    this._bounds[i * 3 + 2] = radius;

    return i * STRIDE;
  }

  private _inside(i: number, x: number, y: number, z: number, pad: number): boolean {
    const s = this._solids;
    const at = i * STRIDE;
    const kind = s[at];

    if (kind === CONE) {
      const bottom = s[at + 3];
      const crown = s[at + 4];
      const top = s[at + 5];

      if (y < bottom - pad || y > top + pad) return false;

      const radius = y < crown ? s[at + 7] : (s[at + 6] * (top - y)) / Math.max(1e-4, top - crown);
      const dx = x - s[at + 1];
      const dz = z - s[at + 2];
      const reach = Math.max(0, radius) + pad;

      return dx * dx + dz * dz < reach * reach;
    }

    if (kind === BOX) {
      const yaw = s[at + 7];
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      const dx = x - s[at + 1];
      const dz = z - s[at + 3];

      return (
        Math.abs(dx * c - dz * sn) < s[at + 4] + pad &&
        Math.abs(y - s[at + 2]) < s[at + 5] + pad &&
        Math.abs(dx * sn + dz * c) < s[at + 6] + pad
      );
    }

    const dy = y - s[at + 2];

    if (dy < -pad || Math.abs(z - s[at + 3]) > s[at + 6] + pad) return false;

    const r = Math.hypot(x - s[at + 1], dy);

    return r > s[at + 4] - pad && r < s[at + 5] + pad;
  }
}
