import { Geometry3D, Mesh3D } from "@pixi/3d";
import { Texture } from "pixi.js";
import { bandMaterial } from "../gfx/Band.js";

/** Most pieces of rubber on the road at once; past that, the oldest go first. */
const MAX = 1600;
/** A mark lasts this long (s), fading out over the last FADE s. */
const LIFE = 16;
const FADE = 7;
/** Width of a tyre's mark (m). */
const WIDTH = 0.26;
/** Laid this far over the ground: above the parking lots and the road paint. */
const LIFT = 0.045;
/** A new piece every MIN_STEP m of travel; a jump of more than MAX_STEP starts a new mark. */
const MIN_STEP = 0.22;
const MAX_STEP = 3;
/** A wheel not laid on for this long (s) is a new mark next time. */
const GAP = 0.12;
/** Marks fade in steps this often (s): a fade over seconds doesn't need every frame. */
const FADE_EVERY = 0.1;

/**
 * The picture of a piece of mark: across it (v) a tyre's soft-edged stripe; along it (u) its
 * opacity, from full (u = 0) to none (u = 1). A vertex's u is how faded it is (its heat and
 * age), so a mark fades as one ribbon, its oldest end first, from one texture and one draw.
 */
function rubberTexture(): Texture {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 16;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(64, 16);
  for (let y = 0; y < 16; y++) {
    const edge = Math.min(1, Math.sin((Math.PI * (y + 0.5)) / 16) * 1.6);
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * edge * (1 - x / 63));
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = Texture.from(c);
  t.source.style.addressMode = "clamp-to-edge";
  return t;
}

interface Trail {
  /** Where the mark's last piece ended, and that end's two corners. */
  x: number; y: number; z: number;
  ax: number; az: number; bx: number; bz: number;
  /** How hard it skidded there, and when (s). */
  heat: number; at: number;
  /** When it was last laid on (s). */
  seen: number;
  /** No piece laid yet: the corners aren't set. */
  fresh: boolean;
}

/**
 * Tyre marks on the road: one ribbon per skidding wheel, in a ring of quads (one dynamic mesh,
 * never culled). Drawn with the bands' material recipe (blended, both sides, no shadows), so
 * no new shader program, and blending writes no depth.
 */
export class SkidMarks {
  readonly mesh: Mesh3D;
  private readonly geo: Geometry3D;
  /** Per vertex: when it was laid (s) and how hard the tyre skidded there (0..1). */
  private readonly born = new Float32Array(MAX * 4);
  private readonly heat = new Float32Array(MAX * 4);
  private readonly trails = new Map<string, Trail>();
  private next = 0;
  /** Slots in use: 0 .. used - 1. */
  private used = 0;
  private now = 0;
  private fadeAt = 0;
  private dirty = false;

  constructor() {
    const n = MAX * 4;
    const normals = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) normals[v * 3 + 1] = 1;
    const uvs = new Float32Array(n * 2);
    for (let v = 0; v < n; v++) { uvs[v * 2] = 1; uvs[v * 2 + 1] = v & 1; }
    const indices = new Uint32Array(MAX * 6);
    for (let q = 0; q < MAX; q++) {
      const b = q * 4;
      indices.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], q * 6);
    }
    this.geo = new Geometry3D({ positions: new Float32Array(n * 3), normals, uvs, indices, dynamic: true });
    const mat = bandMaterial(0x1c1a20, rubberTexture(), 0.6, 0x000000, 0);
    this.mesh = new Mesh3D({ geometry: this.geo, material: mat, castShadow: false, receiveShadow: false });
    this.mesh.visible = false;
  }

  /** Wheel `key` is skidding at (x, ground y, z), `heat` hard (0..1): the mark goes on. */
  lay(key: string, x: number, y: number, z: number, heat: number) {
    let t = this.trails.get(key);
    if (!t || this.now - t.seen > GAP) {
      t = { x, y, z, ax: 0, az: 0, bx: 0, bz: 0, heat, at: this.now, seen: this.now, fresh: true };
      this.trails.set(key, t);
      return;
    }
    t.seen = this.now;
    const dx = x - t.x, dz = z - t.z, d = Math.hypot(dx, dz);
    if (d < MIN_STEP) { t.heat = Math.max(t.heat, heat); return; }
    if (d > MAX_STEP) {
      t.x = x; t.y = y; t.z = z; t.heat = heat; t.at = this.now; t.fresh = true;
      return;
    }
    const sx = (-dz / d) * WIDTH * 0.5, sz = (dx / d) * WIDTH * 0.5;
    if (t.fresh) {
      t.ax = t.x + sx; t.az = t.z + sz; t.bx = t.x - sx; t.bz = t.z - sz;
      t.fresh = false;
    }
    const q = this.next;
    this.next = (q + 1) % MAX;
    if (q >= this.used) this.used = q + 1;
    const pos = this.geo.positions as Float32Array;
    const corner = (v: number, cx: number, cy: number, cz: number, born: number, h: number) => {
      const i = q * 4 + v;
      pos[i * 3] = cx; pos[i * 3 + 1] = cy + LIFT; pos[i * 3 + 2] = cz;
      this.born[i] = born; this.heat[i] = h;
    };
    // from where the last piece ended (no seam) to here
    corner(0, t.ax, t.y, t.az, t.at, t.heat);
    corner(1, t.bx, t.y, t.bz, t.at, t.heat);
    corner(2, x + sx, y, z + sz, this.now, heat);
    corner(3, x - sx, y, z - sz, this.now, heat);
    t.x = x; t.y = y; t.z = z;
    t.ax = x + sx; t.az = z + sz; t.bx = x - sx; t.bz = z - sz;
    t.heat = heat; t.at = this.now;
    this.dirty = true;
  }

  /** Wheel `key` stopped skidding: its mark ends here. */
  lift(key: string) {
    this.trails.delete(key);
  }

  update(dt: number) {
    this.now += dt;
    if (this.used === 0) return;
    if (!this.dirty && this.now < this.fadeAt) return;
    this.fadeAt = this.now + FADE_EVERY;
    const uv = this.geo.uvs as Float32Array;
    let alive = false;
    for (let i = 0; i < this.used * 4; i++) {
      const left = LIFE - (this.now - this.born[i]);
      const a = this.heat[i] * Math.max(0, Math.min(1, left / FADE));
      uv[i * 2] = 1 - a;
      if (a > 0) alive = true;
    }
    this.geo.attributes.aUV.buffer.update();
    if (this.dirty) this.geo.attributes.aPosition.buffer.update();
    this.dirty = false;
    this.mesh.visible = alive;
    // forget wheels long gone (a car that drove off, or out of view)
    if (this.trails.size > 64) for (const [k, t] of this.trails) if (this.now - t.seen > 1) this.trails.delete(k);
  }

  /** For the loading screen's warm-up frame: one piece, out of sight. */
  prewarm(): () => void {
    this.lay("prewarm", 0, -500, 0, 1);
    this.lay("prewarm", 1, -500, 0, 1);
    this.update(0);
    this.mesh.visible = true;
    return () => { this.lift("prewarm"); };
  }
}
