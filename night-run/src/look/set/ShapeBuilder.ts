import { Geometry3D } from '@pixi/3d';

/**
 * Builds one merged geometry out of many tubes, boxes and quads, so every neon tube of one colour, or every pole and
 * lamp housing, is one mesh and one draw.
 *
 * Tubes follow a polyline with a frame carried along it, so a curve doesn't twist; a sharp corner wants two tubes.
 */
export class ShapeBuilder {
  private readonly _positions: number[] = [];
  private readonly _normals: number[] = [];
  private readonly _uvs: number[] = [];
  private readonly _indices: number[] = [];

  /** Vertices written so far. */
  public get vertexCount(): number {
    return this._positions.length / 3;
  }

  /**
   * A tube along a polyline, open at both ends.
   * @param points - Centreline, xyz interleaved; at least two points.
   * @param radius - Tube radius.
   * @param sides - Sides round the tube; 4 is a square section.
   * @param twist - Turns the section about the centreline, in radians; π/4 stands a square on its corner.
   * @returns This builder.
   */
  public tube(points: readonly number[], radius: number, sides = 6, twist = 0): this {
    const count = points.length / 3;
    const first = this.vertexCount;
    // The section's frame: n and b span the plane across the tangent.
    let nx = 0;
    let ny = 0;
    let nz = 0;

    for (let i = 0; i < count; i++) {
      const a = Math.max(0, i - 1) * 3;
      const c = Math.min(count - 1, i + 1) * 3;
      let tx = points[c] - points[a];
      let ty = points[c + 1] - points[a + 1];
      let tz = points[c + 2] - points[a + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;

      tx /= tl;
      ty /= tl;
      tz /= tl;

      if (i === 0) {
        // Any vector off the tangent seeds the frame; up unless the tube starts vertical.
        const vertical = Math.abs(ty) > 0.9;

        nx = vertical ? 1 : 0;
        ny = vertical ? 0 : 1;
        nz = 0;
      }

      // Carry the last normal over: drop its part along the new tangent and renormalise.
      const along = nx * tx + ny * ty + nz * tz;

      nx -= along * tx;
      ny -= along * ty;
      nz -= along * tz;

      const nl = Math.hypot(nx, ny, nz) || 1;

      nx /= nl;
      ny /= nl;
      nz /= nl;

      const bx = ty * nz - tz * ny;
      const by = tz * nx - tx * nz;
      const bz = tx * ny - ty * nx;
      const px = points[i * 3];
      const py = points[i * 3 + 1];
      const pz = points[i * 3 + 2];

      for (let k = 0; k < sides; k++) {
        const angle = twist + (k / sides) * Math.PI * 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const ox = nx * cos + bx * sin;
        const oy = ny * cos + by * sin;
        const oz = nz * cos + bz * sin;

        this._vertex(px + ox * radius, py + oy * radius, pz + oz * radius, ox, oy, oz, k / sides, i / (count - 1));
      }
    }

    for (let i = 0; i < count - 1; i++) {
      for (let k = 0; k < sides; k++) {
        const a = first + i * sides + k;
        const b = first + i * sides + ((k + 1) % sides);

        this._indices.push(a, a + sides, b, b, a + sides, b + sides);
      }
    }

    return this;
  }

  /**
   * A box from its centre and three half-axes, which need not be axis-aligned but should be at right angles.
   * @param cx - Centre x.
   * @param cy - Centre y.
   * @param cz - Centre z.
   * @param ax - Half-axis one, `[x, y, z]`.
   * @param ay - Half-axis two.
   * @param az - Half-axis three.
   * @returns This builder.
   */
  public box(
    cx: number,
    cy: number,
    cz: number,
    ax: readonly number[],
    ay: readonly number[],
    az: readonly number[],
  ): this {
    const axes = [ax, ay, az];

    for (let f = 0; f < 6; f++) {
      const n = axes[f >> 1];
      const sign = f & 1 ? -1 : 1;
      const u = axes[((f >> 1) + 1) % 3];
      const v = axes[((f >> 1) + 2) % 3];
      const nl = Math.hypot(n[0], n[1], n[2]) || 1;

      this.quad(
        cx + n[0] * sign,
        cy + n[1] * sign,
        cz + n[2] * sign,
        u[0] * sign,
        u[1] * sign,
        u[2] * sign,
        v[0],
        v[1],
        v[2],
        (n[0] * sign) / nl,
        (n[1] * sign) / nl,
        (n[2] * sign) / nl,
      );
    }

    return this;
  }

  /**
   * A flat quad from its centre and two half-axes, facing `n`, with UVs 0..1 along them (v down the second axis).
   * @param cx - Centre x.
   * @param cy - Centre y.
   * @param cz - Centre z.
   * @param ux - Half-axis along u, x.
   * @param uy - Half-axis along u, y.
   * @param uz - Half-axis along u, z.
   * @param vx - Half-axis along v, x.
   * @param vy - Half-axis along v, y.
   * @param vz - Half-axis along v, z.
   * @param nx - Facing, x.
   * @param ny - Facing, y.
   * @param nz - Facing, z.
   * @returns This builder.
   */
  public quad(
    cx: number,
    cy: number,
    cz: number,
    ux: number,
    uy: number,
    uz: number,
    vx: number,
    vy: number,
    vz: number,
    nx: number,
    ny: number,
    nz: number,
  ): this {
    const a = this.vertexCount;

    this._vertex(cx - ux - vx, cy - uy - vy, cz - uz - vz, nx, ny, nz, 0, 0);
    this._vertex(cx + ux - vx, cy + uy - vy, cz + uz - vz, nx, ny, nz, 1, 0);
    this._vertex(cx + ux + vx, cy + uy + vy, cz + uz + vz, nx, ny, nz, 1, 1);
    this._vertex(cx - ux + vx, cy - uy + vy, cz - uz + vz, nx, ny, nz, 0, 1);

    // Wind counter-clockwise seen from the side `n` points to.
    const cross = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;

    if (cross > 0) this._indices.push(a, a + 1, a + 2, a, a + 2, a + 3);
    else this._indices.push(a, a + 2, a + 1, a, a + 3, a + 2);

    return this;
  }

  /**
   * An open frustum along +z from radius `r0` at z = 0 to radius 1 at z = 1, with v running along it. Scale it to
   * aim a light shaft: x and y set the far radius, z the length.
   * @param r0 - Radius at z = 0.
   * @param segments - Segments round it.
   * @returns This builder.
   */
  public frustum(r0: number, segments: number): this {
    const first = this.vertexCount;
    const slope = 1 - r0;
    const nl = Math.hypot(1, slope);

    for (let k = 0; k <= segments; k++) {
      const angle = (k / segments) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      this._vertex(cos * r0, sin * r0, 0, cos / nl, sin / nl, -slope / nl, k / segments, 0);
      this._vertex(cos, sin, 1, cos / nl, sin / nl, -slope / nl, k / segments, 1);
    }

    for (let k = 0; k < segments; k++) {
      const a = first + k * 2;

      this._indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }

    return this;
  }

  /**
   * Scale the vertices written since `first`, then turn their +z onto `forward` and move them to `origin`.
   * @param first - First vertex to move.
   * @param ox - Origin x.
   * @param oy - Origin y.
   * @param oz - Origin z.
   * @param fx - Unit forward, x.
   * @param fy - Unit forward, y.
   * @param fz - Unit forward, z.
   * @param across - Scale on x and y.
   * @param along - Scale on z.
   * @returns This builder.
   */
  public aim(
    first: number,
    ox: number,
    oy: number,
    oz: number,
    fx: number,
    fy: number,
    fz: number,
    across: number,
    along: number,
  ): this {
    // x across, level; y completes the frame.
    const level = Math.hypot(fx, fz) > 1e-4;
    let rx = level ? fz : 1;
    let rz = level ? -fx : 0;
    const rl = Math.hypot(rx, rz);

    rx /= rl;
    rz /= rl;

    const ux = fy * rz;
    const uy = fz * rx - fx * rz;
    const uz = -fy * rx;
    const p = this._positions;
    const n = this._normals;

    for (let i = first * 3; i < p.length; i += 3) {
      const x = p[i] * across;
      const y = p[i + 1] * across;
      const z = p[i + 2] * along;

      p[i] = ox + rx * x + ux * y + fx * z;
      p[i + 1] = oy + uy * y + fy * z;
      p[i + 2] = oz + rz * x + uz * y + fz * z;

      const nx = n[i] / across;
      const ny = n[i + 1] / across;
      const nz = n[i + 2] / along;
      const wx = rx * nx + ux * ny + fx * nz;
      const wy = uy * ny + fy * nz;
      const wz = rz * nx + uz * ny + fz * nz;
      const wl = Math.hypot(wx, wy, wz) || 1;

      n[i] = wx / wl;
      n[i + 1] = wy / wl;
      n[i + 2] = wz / wl;
    }

    return this;
  }

  /** @returns A new geometry holding everything built so far. */
  public build(): Geometry3D {
    const count = this.vertexCount;

    return new Geometry3D({
      positions: new Float32Array(this._positions),
      normals: new Float32Array(this._normals),
      uvs: new Float32Array(this._uvs),
      indices: count > 0xffff ? new Uint32Array(this._indices) : new Uint16Array(this._indices),
    });
  }

  private _vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): void {
    this._positions.push(x, y, z);
    this._normals.push(nx, ny, nz);
    this._uvs.push(u, v);
  }
}
