import { Geometry3D, Material3D, Mesh3D } from "@pixi/3d";
import { Texture } from "pixi.js";

/**
 * Flat, glowing, see-through bands drawn on the world: the fumes' wall, tape and dashes, and
 * the stink bomb's aim arc and rings. They all share one material recipe (emissive, blended,
 * both sides, no shadows), which is the tracers' shader program: nothing new compiles, and
 * blending writes no depth, so the tilt-shift focus isn't fooled. Every geometry here has
 * positions, normals and float UVs only (no colours, no tangents), like the tracers'.
 */
export function bandMaterial(color: number, tex: Texture, alpha: number, glow: number, strength: number): Material3D {
  const m = new Material3D({ baseColor: color, baseColorTexture: tex, alphaMode: "blend", alpha, emissive: { color: glow, strength } });
  m.state.culling = false; // seen from either side
  return m;
}

export function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): Texture {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d")!, w, h);
  const t = Texture.from(c);
  t.source.style.addressMode = "repeat";
  t.source.autoGenerateMipmaps = true;
  return t;
}

/** Yellow and black hazard stripes. */
export const tapeTexture = () => canvasTexture(64, 16, (ctx, w, h) => {
  ctx.fillStyle = "#ffd23f";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#2b2340";
  for (let x = -h; x < w + h; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, h); ctx.lineTo(x + 8, h); ctx.lineTo(x + 8 + h, 0); ctx.lineTo(x + h, 0);
    ctx.fill();
  }
});

/** White dashes on transparent. */
export const dashTexture = () => canvasTexture(32, 4, (ctx, w, h) => {
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, w * 0.55, h);
});

/**
 * A ring of quads around a centre, rebuilt in place when it moves: a vertical wall (radius r,
 * `y` → `y + h`), or a flat band (radius r → r + h, at height `y`). Dynamic geometry: drawn
 * from its own buffers, never culled. A band that keeps its shape is a `bandMesh` instead.
 */
export class Band {
  readonly mesh: Mesh3D;
  private readonly geo: Geometry3D;
  private key = "";

  constructor(material: Material3D, private readonly wall: boolean, private readonly uMetres: number, private readonly seg = 128) {
    this.geo = new Geometry3D({ ...bandArrays(wall, seg), dynamic: true });
    this.mesh = new Mesh3D({ geometry: this.geo, material, castShadow: false, receiveShadow: false });
  }

  /** Place the band around (cx, cz) at radius r (rows: wall 0 = bottom, ring 0 = inner). */
  set(cx: number, cz: number, r: number, y: number, h: number) {
    const key = `${cx.toFixed(3)}|${cz.toFixed(3)}|${r.toFixed(3)}|${y.toFixed(3)}|${h.toFixed(3)}`;
    if (key === this.key) return;
    this.key = key;
    writeBand(this.geo.positions as Float32Array, this.geo.uvs as Float32Array, this.wall, this.seg, this.uMetres, cx, cz, r, y, h);
    this.geo.attributes.aPosition.buffer.update();
    this.geo.attributes.aUV.buffer.update();
  }
}

/** Built once per shape: copies share it, so they draw as one batch. */
const bandShapes = new Map<string, Geometry3D>();

/**
 * A band that keeps its shape (see `Band`), around its mesh's origin: static geometry, so it
 * is culled and its copies batch. Move it with `position`; scale a wall's x and z to resize it.
 */
export function bandMesh(material: Material3D, wall: boolean, r: number, h: number, uMetres: number, seg: number): Mesh3D {
  const key = [wall, r, h, uMetres, seg].join();
  let geo = bandShapes.get(key);
  if (!geo) {
    // (filled in before it's made: static geometry measures its bounds then)
    const a = bandArrays(wall, seg);
    writeBand(a.positions, a.uvs, wall, seg, uMetres, 0, 0, r, 0, h);
    bandShapes.set(key, (geo = new Geometry3D(a)));
  }
  return new Mesh3D({ geometry: geo, material, castShadow: false, receiveShadow: false });
}

function bandArrays(wall: boolean, seg: number) {
  const n = (seg + 1) * 2;
  const normals = new Float32Array(n * 3);
  const indices = new Uint32Array(seg * 6);
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    for (const k of [0, 1]) {
      const v = (i * 2 + k) * 3;
      if (wall) { normals[v] = Math.cos(a); normals[v + 2] = Math.sin(a); } else normals[v + 1] = 1;
    }
    if (i < seg) {
      const b = i * 2, o = i * 6;
      indices.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], o);
    }
  }
  return { positions: new Float32Array(n * 3), normals, uvs: new Float32Array(n * 2), indices };
}

function writeBand(pos: Float32Array, uv: Float32Array, wall: boolean, seg: number, uMetres: number, cx: number, cz: number, r: number, y: number, h: number) {
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const u = (a * Math.max(r, 1)) / uMetres;
    for (const k of [0, 1]) {
      const v = i * 2 + k;
      const rr = wall ? r : r + h * k;
      pos[v * 3] = cx + c * rr;
      pos[v * 3 + 1] = wall ? y + h * k : y;
      pos[v * 3 + 2] = cz + s * rr;
      uv[v * 2] = u;
      uv[v * 2 + 1] = wall ? 1 - k : k;
    }
  }
}

/**
 * A flat ribbon (facing up) along a polyline of up to `max` points, `w` wide, its texture
 * repeating every `uMetres` along it. Points it isn't given collapse onto the last one.
 */
export class Strip {
  readonly mesh: Mesh3D;
  private readonly geo: Geometry3D;

  constructor(material: Material3D, private readonly max: number) {
    const n = max * 2;
    const normals = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) normals[v * 3 + 1] = 1;
    const indices = new Uint32Array((max - 1) * 6);
    for (let i = 0; i < max - 1; i++) {
      const b = i * 2;
      indices.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], i * 6);
    }
    this.geo = new Geometry3D({ positions: new Float32Array(n * 3), normals, uvs: new Float32Array(n * 2), indices, dynamic: true });
    this.mesh = new Mesh3D({ geometry: this.geo, material, castShadow: false, receiveShadow: false });
  }

  /** Lay it along `n` points (x, y, z triples in `xyz`, every `stride`-th one), `w` m wide. */
  set(xyz: ArrayLike<number>, n: number, w: number, uMetres: number, stride = 1) {
    const pos = this.geo.positions as Float32Array, uv = this.geo.uvs as Float32Array;
    const m = Math.max(1, Math.min(this.max, n));
    let u = 0, sx = 1, sz = 0;
    for (let i = 0; i < this.max; i++) {
      const j = Math.min(i, m - 1);
      const p = j * stride * 3;
      const x = xyz[p], y = xyz[p + 1], z = xyz[p + 2];
      if (i > 0 && i < m) {
        const q = (j - 1) * stride * 3;
        u += Math.hypot(x - xyz[q], y - xyz[q + 1], z - xyz[q + 2]) / uMetres;
      }
      // across the way it's heading (flat): from the neighbours on either side
      if (i < m) {
        const a = Math.max(0, j - 1) * stride * 3, b = Math.min(m - 1, j + 1) * stride * 3;
        const tx = xyz[b] - xyz[a], tz = xyz[b + 2] - xyz[a + 2], tl = Math.hypot(tx, tz);
        if (tl > 1e-4) { sx = -tz / tl; sz = tx / tl; }
      }
      for (const k of [0, 1]) {
        const v = i * 2 + k, side = (k - 0.5) * w;
        pos[v * 3] = x + sx * side;
        pos[v * 3 + 1] = y;
        pos[v * 3 + 2] = z + sz * side;
        uv[v * 2] = u;
        uv[v * 2 + 1] = k;
      }
    }
    this.geo.attributes.aPosition.buffer.update();
    this.geo.attributes.aUV.buffer.update();
  }
}
