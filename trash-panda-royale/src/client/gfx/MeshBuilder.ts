import { Geometry3D, srgbToLinear } from "@pixi/3d";

/** sRGB hex → linear RGB (vertex colours are read as linear), decoded as material colours are. */
export function linear(hex: number): [number, number, number] {
  return [srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255), srgbToLinear((hex & 255) / 255)];
}

/**
 * Accumulates coloured boxes/quads into one static geometry, so whole layers of the
 * city (roads, markings, rails...) are a single draw call.
 *
 * Every vertex gets a UV in world metres ÷ `tile`, so a repeating texture on the layer's
 * material tiles evenly across it. Every geometry has UVs (textured or not): the city's
 * layers then all share one shader program.
 */
export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];

  /** @param tile metres per texture repeat */
  constructor(private readonly tile = 1) {}

  get vertexCount() { return this.pos.length / 3; }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: [number, number, number], u: number, v: number) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(c[0], c[1], c[2], 1);
    this.uv.push(u / this.tile, v / this.tile);
  }

  /** Flat horizontal rectangle (axis aligned) at height y. */
  rect(minX: number, minZ: number, maxX: number, maxZ: number, y: number, color: number) {
    const c = linear(color);
    const i = this.vertexCount;
    this.vert(minX, y, minZ, 0, 1, 0, c, minX, minZ);
    this.vert(minX, y, maxZ, 0, 1, 0, c, minX, maxZ);
    this.vert(maxX, y, maxZ, 0, 1, 0, c, maxX, maxZ);
    this.vert(maxX, y, minZ, 0, 1, 0, c, maxX, minZ);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  /** Flat horizontal quad of length `len` and width `w`, centred at (x, z), rotated by yaw. */
  quad(x: number, z: number, yaw: number, len: number, w: number, y: number, color: number) {
    const c = linear(color);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const lx = Math.cos(yaw), lz = -Math.sin(yaw);
    const hl = len / 2, hw = w / 2;
    const i = this.vertexCount;
    // world-space UVs, so markings carry the same grain as the road under them
    const p = (a: number, b: number) => {
      const px = x + fx * a + lx * b, pz = z + fz * a + lz * b;
      this.vert(px, y, pz, 0, 1, 0, c, px, pz);
    };
    p(-hl, -hw); p(-hl, hw); p(hl, hw); p(hl, -hw);
    this.idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
  }

  /**
   * A flat picture on the ground: `h` metres along the yaw direction (the image's height)
   * by `w` across (its width), with UVs over `uv` (an atlas cell: u0, v0, u1, v1) instead
   * of the world. With yaw 0 the image's top points to −Z: right way up for the north-up
   * camera (screen up = −Z, screen right = +X).
   */
  decal(x: number, z: number, yaw: number, h: number, w: number, y: number, uv: { u0: number; v0: number; u1: number; v1: number }, tint = 0xffffff) {
    const c = linear(tint);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const lx = Math.cos(yaw), lz = -Math.sin(yaw);
    const hh = h / 2, hw = w / 2;
    const i = this.vertexCount;
    // explicit UVs (×tile, undone by vert()'s ÷tile)
    const p = (a: number, b: number, u: number, v: number) =>
      this.vert(x + fx * a + lx * b, y, z + fz * a + lz * b, 0, 1, 0, c, u * this.tile, v * this.tile);
    // (a: along, b: across) → top-left, top-right, bottom-right, bottom-left of the image
    p(-hh, -hw, uv.u0, uv.v0); p(-hh, hw, uv.u1, uv.v0); p(hh, hw, uv.u1, uv.v1); p(hh, -hw, uv.u0, uv.v1);
    this.idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
  }

  /** An oriented box (yaw about Y) from y0 to y1. */
  box(x: number, z: number, yaw: number, len: number, w: number, y0: number, y1: number, color: number) {
    const c = linear(color);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const lx = Math.cos(yaw), lz = -Math.sin(yaw);
    const hl = len / 2, hw = w / 2;
    const corner = (a: number, b: number): [number, number] => [x + fx * a + lx * b, z + fz * a + lz * b];
    const P = [corner(-hl, -hw), corner(-hl, hw), corner(hl, hw), corner(hl, -hw)];
    // top
    let i = this.vertexCount;
    for (const [px, pz] of P) this.vert(px, y1, pz, 0, 1, 0, c, px, pz);
    this.idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
    // sides: u along the side, v up
    for (let k = 0; k < 4; k++) {
      const [ax, az] = P[k], [bx, bz] = P[(k + 1) % 4];
      let nx = bz - az, nz = -(bx - ax);
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;
      // make the normal point outward
      const mx = (ax + bx) / 2 - x, mz = (az + bz) / 2 - z;
      if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
      const side = Math.hypot(bx - ax, bz - az);
      i = this.vertexCount;
      this.vert(ax, y0, az, nx, 0, nz, c, 0, y0);
      this.vert(bx, y0, bz, nx, 0, nz, c, side, y0);
      this.vert(bx, y1, bz, nx, 0, nz, c, side, y1);
      this.vert(ax, y1, az, nx, 0, nz, c, 0, y1);
      // wind counter-clockwise seen from outside
      const cross = (bx - ax) * nz - (bz - az) * nx;
      if (cross > 0) this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
      else this.idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
    }
  }

  /**
   * A sloped quad over a turned rectangle (see `Ramp` in map.ts): rising along its local +Z
   * from h0 to h1. Local x runs along (c, −s), local z along (s, c).
   */
  slope(r: { cx: number; cz: number; hx: number; hz: number; c: number; s: number; h0: number; h1: number }, color: number) {
    const c = linear(color);
    const i = this.vertexCount;
    const len = 2 * r.hz, dh = r.h1 - r.h0;
    const nl = Math.hypot(len, dh);
    const nx = (-r.s * dh) / nl, ny = len / nl, nz = (-r.c * dh) / nl;
    const p = (lx: number, lz: number, h: number) => {
      const x = r.cx + lx * r.c + lz * r.s, z = r.cz - lx * r.s + lz * r.c;
      this.vert(x, h, z, nx, ny, nz, c, x, z);
      return [x, z] as const;
    };
    const a = p(-r.hx, -r.hz, r.h0), b = p(-r.hx, r.hz, r.h1), d = p(r.hx, r.hz, r.h1);
    p(r.hx, -r.hz, r.h0);
    // face up whichever way the frame turns
    const up = (b[1] - a[1]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[1] - a[1]) > 0;
    if (up) this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    else this.idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
  }

  /** One upward-facing triangle over vertices i0, i1, i2 at (x, z) a, b, c, whichever way round they were given. */
  private upTri(i0: number, i1: number, i2: number, a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }) {
    if ((b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z) > 0) this.idx.push(i0, i1, i2);
    else this.idx.push(i0, i2, i1);
  }

  /** A flat fan around (cx, cz) through the points of `ring` (closed): a star-shaped patch (a junction, a disc). */
  fan(cx: number, cz: number, ring: readonly { x: number; z: number }[], y: number, color: number) {
    const c = linear(color);
    const i0 = this.vertexCount;
    this.vert(cx, y, cz, 0, 1, 0, c, cx, cz);
    for (const p of ring) this.vert(p.x, y, p.z, 0, 1, 0, c, p.x, p.z);
    const mid = { x: cx, z: cz };
    for (let k = 0; k < ring.length; k++) {
      const k1 = (k + 1) % ring.length;
      this.upTri(i0, i0 + 1 + k, i0 + 1 + k1, mid, ring[k], ring[k1]);
    }
  }

  /** A flat open fan around (cx, cz) through `pts` in order (not closed back to the first): one wedge of a junction. */
  sector(cx: number, cz: number, pts: readonly { x: number; z: number }[], y: number, color: number) {
    const c = linear(color);
    const i0 = this.vertexCount;
    this.vert(cx, y, cz, 0, 1, 0, c, cx, cz);
    for (const p of pts) this.vert(p.x, y, p.z, 0, 1, 0, c, p.x, p.z);
    const mid = { x: cx, z: cz };
    for (let k = 0; k + 1 < pts.length; k++) this.upTri(i0, i0 + 1 + k, i0 + 2 + k, mid, pts[k], pts[k + 1]);
  }

  /** An upright cylinder (`seg` sides, a lid on top) from y0 to y1. */
  cylinder(cx: number, cz: number, r: number, y0: number, y1: number, color: number, seg = 10) {
    const c = linear(color);
    const lid = this.vertexCount;
    this.vert(cx, y1, cz, 0, 1, 0, c, cx, cz);
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      this.vert(cx + Math.cos(a) * r, y1, cz + Math.sin(a) * r, 0, 1, 0, c, cx + Math.cos(a) * r, cz + Math.sin(a) * r);
    }
    for (let k = 0; k < seg; k++) this.idx.push(lid, lid + 1 + ((k + 1) % seg), lid + 1 + k);
    const side = this.vertexCount, circ = 2 * Math.PI * r;
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2, nx = Math.cos(a), nz = Math.sin(a);
      this.vert(cx + nx * r, y0, cz + nz * r, nx, 0, nz, c, (k / seg) * circ, y0);
      this.vert(cx + nx * r, y1, cz + nz * r, nx, 0, nz, c, (k / seg) * circ, y1);
    }
    for (let k = 0; k < seg; k++) {
      const a = side + k * 2;
      this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }

  /** One triangle anywhere (both faces when `twoSided`: a flag on a string). */
  tri(a: readonly [number, number, number], b: readonly [number, number, number], d: readonly [number, number, number], color: number, twoSided = false) {
    const c = linear(color);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    for (const s of twoSided ? [1, -1] : [1]) {
      const i = this.vertexCount;
      for (const p of [a, b, d]) this.vert(p[0], p[1], p[2], nx * s, ny * s, nz * s, c, p[0] + p[2], p[1]);
      if (s > 0) this.idx.push(i, i + 1, i + 2);
      else this.idx.push(i, i + 2, i + 1);
    }
  }

  /** A flat disc. */
  disc(cx: number, cz: number, r: number, y: number, color: number, seg = 28) {
    const ring: { x: number; z: number }[] = [];
    for (let k = 0; k < seg; k++) ring.push({ x: cx + Math.cos((k / seg) * Math.PI * 2) * r, z: cz + Math.sin((k / seg) * Math.PI * 2) * r });
    this.fan(cx, cz, ring, y, color);
  }

  /** A flat polygon (simple, any winding, convex or not: ear clipping). */
  poly(pts: readonly { x: number; z: number }[], y: number, color: number) {
    const n = pts.length;
    if (n < 3) return;
    const c = linear(color);
    const i0 = this.vertexCount;
    for (const p of pts) this.vert(p.x, y, p.z, 0, 1, 0, c, p.x, p.z);
    // work counter-clockwise (positive area in x/z)
    let area = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
    const idx = Array.from({ length: n }, (_, i) => (area > 0 ? i : n - 1 - i));
    const cross = (a: number, b: number, d: number) => (pts[b].x - pts[a].x) * (pts[d].z - pts[a].z) - (pts[b].z - pts[a].z) * (pts[d].x - pts[a].x);
    const inside = (p: number, a: number, b: number, d: number) => cross(a, b, p) >= 0 && cross(b, d, p) >= 0 && cross(d, a, p) >= 0;
    let guard = 0;
    while (idx.length > 3 && guard++ < n * n) {
      let cut = false;
      for (let k = 0; k < idx.length; k++) {
        const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], d = idx[(k + 1) % idx.length];
        if (cross(a, b, d) <= 1e-9) continue;
        let ear = true;
        for (const p of idx) if (p !== a && p !== b && p !== d && inside(p, a, b, d)) { ear = false; break; }
        if (!ear) continue;
        this.upTri(i0 + a, i0 + b, i0 + d, pts[a], pts[b], pts[d]);
        idx.splice(k, 1);
        cut = true;
        break;
      }
      if (!cut) break;
    }
    if (idx.length === 3) this.upTri(i0 + idx[0], i0 + idx[1], i0 + idx[2], pts[idx[0]], pts[idx[1]], pts[idx[2]]);
  }

  /**
   * A flat band along a polyline, between offsets `o0` and `o1` to its right (−dz, dx), with
   * mitred corners (a very sharp corner's mitre is capped).
   */
  ribbon(pts: readonly { x: number; z: number }[], o0: number, o1: number, y: number, color: number) {
    if (pts.length < 2) return;
    const c = linear(color);
    const side: { x: number; z: number }[][] = [[], []];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[i], d = pts[Math.min(pts.length - 1, i + 1)];
      let n0x = -(b.z - a.z), n0z = b.x - a.x, n1x = -(d.z - b.z), n1z = d.x - b.x;
      const l0 = Math.hypot(n0x, n0z), l1 = Math.hypot(n1x, n1z);
      if (l0 > 1e-9) { n0x /= l0; n0z /= l0; } else { n0x = n1x / (l1 || 1); n0z = n1z / (l1 || 1); }
      if (l1 > 1e-9) { n1x /= l1; n1z /= l1; } else { n1x = n0x; n1z = n0z; }
      let mx = n0x + n1x, mz = n0z + n1z;
      const ml = Math.hypot(mx, mz) || 1;
      mx /= ml; mz /= ml;
      const k = Math.min(2.5, 1 / Math.max(0.4, mx * n0x + mz * n0z));
      side[0].push({ x: b.x + mx * o0 * k, z: b.z + mz * o0 * k });
      side[1].push({ x: b.x + mx * o1 * k, z: b.z + mz * o1 * k });
    }
    const i0 = this.vertexCount;
    for (let i = 0; i < pts.length; i++) {
      for (const s of side) this.vert(s[i].x, y, s[i].z, 0, 1, 0, c, s[i].x, s[i].z);
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = i0 + i * 2, b = a + 1, d = a + 2, e = a + 3;
      this.upTri(a, b, d, side[0][i], side[1][i], side[0][i + 1]);
      this.upTri(b, e, d, side[1][i], side[1][i + 1], side[0][i + 1]);
    }
  }

  /** A box turned to `yaw` (local +Z along (sin, cos)), from y0 to y1, `hx` × `hz` half sizes. Shorthand for `box`. */
  obox(cx: number, cz: number, yaw: number, hx: number, hz: number, y0: number, y1: number, color: number) {
    this.box(cx, cz, yaw, hz * 2, hx * 2, y0, y1, color);
  }

  build(): Geometry3D {
    return new Geometry3D({
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      colors: new Float32Array(this.col),
      uvs: new Float32Array(this.uv),
      indices: new Uint32Array(this.idx),
    });
  }
}
