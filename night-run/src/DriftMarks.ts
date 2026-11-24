import type { Container3D } from '@pixi/3d';
import { FlatMaterial, Geometry3D, Mesh3D, Vector3 } from '@pixi/3d';
import { Buffer, BufferUsage } from 'pixi.js';

import { clamp } from './MathUtils';
import type { TruckPose } from './race/truck';
import { truckPoint, WHEEL_LOCAL } from './race/truck';

const VERTS_PER_SEGMENT = 6;
const FLOATS_PER_POSITION = 3;
const FLOATS_PER_COLOR = 4;
const POSITION_FLOATS_PER_SEGMENT = VERTS_PER_SEGMENT * FLOATS_PER_POSITION;
const COLOR_FLOATS_PER_SEGMENT = VERTS_PER_SEGMENT * FLOATS_PER_COLOR;

const WIDTH = 0.08;
const Y_OFFSET = 0.05;
/** Marks are laid in pieces at least this long, so slow motion still leaves a continuous ribbon. */
const MIN_SEGMENT_LENGTH = 0.06;
const INTENSITY_MIN = 0.5;
const INTENSITY_MAX = 2.0;
const INV_INTENSITY_RANGE = 1 / (INTENSITY_MAX - INTENSITY_MIN);

const _wheelPos = new Vector3();

/**
 * Dark rubber ribbons behind any number of wheels, all in one mesh and one draw call.
 *
 * Every emitter writes quads into a shared ring of segments with a fixed-size position buffer and a per-vertex
 * `aColor` (only alpha varies). Unwritten and cleared slots stay at zero, degenerate triangles the rasterizer
 * skips, so there is no draw count to manage. Each frame's writes are uploaded as one range on {@link flush}.
 */
export class DriftMarks {
  private readonly _mesh: Mesh3D;
  private readonly _positions: Float32Array;
  private readonly _colors: Float32Array;
  private readonly _positionsBuffer: Buffer;
  private readonly _colorsBuffer: Buffer;
  private readonly _capacity: number;

  /** Each emitter's last laid point, x y z per emitter. */
  private readonly _prev: Float32Array;
  /** Whether each emitter was laying a mark last time it was tracked. */
  private readonly _active: Uint8Array;

  private _cursor = 0;
  /** Segments ever written, capped at the capacity; what {@link clear} has to wipe. */
  private _used = 0;
  /** The first segment written since the last flush, or -1. */
  private _dirtyFrom = -1;
  private _dirtyCount = 0;

  /**
   * @param parent - Where the ribbon mesh goes.
   * @param emitters - How many wheels lay marks; each gets an index for {@link track}.
   * @param segments - Ring size shared by every emitter; the oldest marks are overwritten first.
   */
  constructor(parent: Container3D, emitters = 2, segments = 8192) {
    this._capacity = segments;
    this._prev = new Float32Array(emitters * 3);
    this._active = new Uint8Array(emitters);
    this._positions = new Float32Array(segments * POSITION_FLOATS_PER_SEGMENT);
    this._colors = new Float32Array(segments * COLOR_FLOATS_PER_SEGMENT);

    // RGB stays white for good; only alpha is written per segment.
    for (let i = 0; i < segments * VERTS_PER_SEGMENT; i++) {
      const o = i * FLOATS_PER_COLOR;

      this._colors[o] = 1;
      this._colors[o + 1] = 1;
      this._colors[o + 2] = 1;
    }

    this._positionsBuffer = new Buffer({
      data: this._positions,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: 'driftMarks-positions',
      shrinkToFit: false,
    });

    this._colorsBuffer = new Buffer({
      data: this._colors,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: 'driftMarks-colors',
      shrinkToFit: false,
    });

    const geometry = new Geometry3D({
      attributes: {
        aPosition: { buffer: this._positionsBuffer, format: 'float32x3', stride: FLOATS_PER_POSITION * 4, offset: 0 },
        aColor: { buffer: this._colorsBuffer, format: 'float32x4', stride: FLOATS_PER_COLOR * 4, offset: 0 },
      },
      topology: 'triangle-list',
      dynamic: true,
    });

    // Rubber, not an emitter, so it stays on the view's tone curve, which keeps it near black.
    const material = new FlatMaterial({
      baseColor: [0.07, 0.07, 0.07, 1],
      alphaMode: 'blend',
      doubleSided: true,
      // Off by default; without it `aColor` is ignored and every mark draws at full alpha.
      vertexColors: true,
    });

    // WebGL honours polygon offset; WebGPU ignores it, and the small lift above the ground keeps marks clear.
    material.state.polygonOffset = -4;

    this._mesh = new Mesh3D({ geometry, material, castShadow: false, receiveShadow: false });
    parent.addChild(this._mesh);
  }

  /** Whether the marks draw. */
  public get visible(): boolean {
    return this._mesh.visible;
  }

  public set visible(value: boolean) {
    this._mesh.visible = value;
  }

  /**
   * Follow one wheel. While `emit` holds it lays a ribbon from where it was to here, in pieces long enough to
   * read; otherwise it only remembers where the wheel is.
   * @param index - Emitter index, below the count given to the constructor.
   * @param x - Ground point under the wheel, x.
   * @param y - Height to lay the mark at, just above the surface.
   * @param z - Ground point under the wheel, z.
   * @param alpha - How dark the mark is, 0 to 1.
   * @param emit - Whether the wheel is sliding on the ground.
   */
  public track(index: number, x: number, y: number, z: number, alpha: number, emit: boolean): void {
    const prev = this._prev;
    const p = index * 3;

    if (emit && this._active[index] === 1) {
      const dx = x - prev[p];
      const dz = z - prev[p + 2];
      const length = Math.hypot(dx, dz);

      if (length < MIN_SEGMENT_LENGTH) return;

      this._writeSegment(prev[p], prev[p + 1], prev[p + 2], x, y, z, dx / length, dz / length, alpha);
    }

    prev[p] = x;
    prev[p + 1] = y;
    prev[p + 2] = z;
    this._active[index] = emit ? 1 : 0;
  }

  /** Upload everything tracked since the last flush, as one range per buffer. Call once a frame after tracking. */
  public flush(): void {
    if (this._dirtyFrom < 0) return;

    const from = this._dirtyFrom;
    const count = this._dirtyCount;

    this._positionsBuffer.update(count * POSITION_FLOATS_PER_SEGMENT * 4, from * POSITION_FLOATS_PER_SEGMENT * 4);
    this._colorsBuffer.update(count * COLOR_FLOATS_PER_SEGMENT * 4, from * COLOR_FLOATS_PER_SEGMENT * 4);
    this._dirtyFrom = -1;
    this._dirtyCount = 0;
  }

  /** Wipe every mark and forget where the wheels were. */
  public clear(): void {
    const used = this._used;

    if (used > 0) {
      this._positions.fill(0, 0, used * POSITION_FLOATS_PER_SEGMENT);
      this._positionsBuffer.update(used * POSITION_FLOATS_PER_SEGMENT * 4, 0);
    }

    this._active.fill(0);
    this._cursor = 0;
    this._used = 0;
    this._dirtyFrom = -1;
    this._dirtyCount = 0;
  }

  /**
   * One truck: marks under both rear wheels while it drifts. Call {@link DriftMarks.flush} after the last truck.
   * @param slot - The truck's slot; it owns emitters `slot * 2` and `slot * 2 + 1`.
   * @param pose - The truck.
   */
  public trackTruck(slot: number, pose: Readonly<TruckPose>): void {
    const emit = pose.drift > 0.5 && pose.speed > 1.2;
    const alpha = clamp((pose.drift - INTENSITY_MIN) * INV_INTENSITY_RANGE, 0, 1);
    const groundY = pose.y + Y_OFFSET;

    for (let w = 0; w < 2; w++) {
      const wheel = WHEEL_LOCAL[2 + w];

      truckPoint(pose, wheel[0], 0, wheel[2], _wheelPos);
      this.track(slot * 2 + w, _wheelPos.x, groundY, _wheelPos.z, alpha, emit);
    }
  }

  /**
   * Stop a truck's marks here, so the next one doesn't join up with where it was, as after a respawn.
   * @param slot - The truck's slot.
   */
  public cut(slot: number): void {
    this._active[slot * 2] = 0;
    this._active[slot * 2 + 1] = 0;
  }

  /** Release the mesh with its geometry, buffers and material. */
  public destroy(): void {
    this._mesh.destroy({ geometry: true, material: true });
  }

  private _writeSegment(
    px: number,
    py: number,
    pz: number,
    cx: number,
    cy: number,
    cz: number,
    dirX: number,
    dirZ: number,
    alpha: number,
  ): void {
    // Perpendicular in the XZ plane, scaled to half-width.
    const sideX = dirZ * WIDTH;
    const sideZ = -dirX * WIDTH;
    const segment = this._cursor;
    const positions = this._positions;
    const o = segment * POSITION_FLOATS_PER_SEGMENT;

    // Two triangles, CCW from above: (pL, pR, cL) (pR, cR, cL).
    positions[o] = px + sideX;
    positions[o + 1] = py;
    positions[o + 2] = pz + sideZ;
    positions[o + 3] = px - sideX;
    positions[o + 4] = py;
    positions[o + 5] = pz - sideZ;
    positions[o + 6] = cx + sideX;
    positions[o + 7] = cy;
    positions[o + 8] = cz + sideZ;
    positions[o + 9] = px - sideX;
    positions[o + 10] = py;
    positions[o + 11] = pz - sideZ;
    positions[o + 12] = cx - sideX;
    positions[o + 13] = cy;
    positions[o + 14] = cz - sideZ;
    positions[o + 15] = cx + sideX;
    positions[o + 16] = cy;
    positions[o + 17] = cz + sideZ;

    const colors = this._colors;
    const c = segment * COLOR_FLOATS_PER_SEGMENT;

    for (let i = 0; i < VERTS_PER_SEGMENT; i++) {
      colors[c + i * FLOATS_PER_COLOR + 3] = alpha;
    }

    // Grow this frame's upload range; a wrap round the ring uploads the whole ring once.
    if (this._dirtyFrom < 0) {
      this._dirtyFrom = segment;
      this._dirtyCount = 1;
    } else if (segment === 0) {
      this._dirtyFrom = 0;
      this._dirtyCount = this._capacity;
    } else if (this._dirtyCount < this._capacity) {
      this._dirtyCount = segment - this._dirtyFrom + 1;
    }

    this._cursor = (segment + 1) % this._capacity;
    this._used = Math.min(this._capacity, this._used + 1);
  }
}
