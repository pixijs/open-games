import { linearToSrgb, srgbToLinear } from "@pixi/3d";
import { CubeTexture, Texture } from "pixi.js";
import { mulberry32 } from "../../shared/map.js";

type Vec = [number, number, number];
type Rgb = [number, number, number];

/** The sky's colours (sRGB), out of the start screen's palette (its `--sky` and page blue). */
const ZENITH = 0x3a8fe8, SKY = 0x58b4fa, PALE = 0x9ad7ff;
/** Cloud underside (a cool lilac, the menu's `--mist` gone bluer), body and sunlit tops. */
const CLOUD_SHADE = 0xb9c0ef, CLOUD_BODY = 0xebf0ff, CLOUD_LIGHT = 0xffffff;
const SUN_DISC = 0xfff5cf, SUN_GLOW = 0xfff0bf;
/** The gradient is worked out on this coarse a grid per face (it's smooth) and stretched over it. */
const GRID = 48;

/**
 * The cube's faces as WebGL samples them: a direction `d` lands on the face whose axis `n` it's
 * nearest, at u = d·a / d·n, v = d·b / d·n (-1..1, left to right and top to bottom of the picture).
 */
const FACES = {
  right: { n: [1, 0, 0], a: [0, 0, -1], b: [0, -1, 0] },
  left: { n: [-1, 0, 0], a: [0, 0, 1], b: [0, -1, 0] },
  top: { n: [0, 1, 0], a: [1, 0, 0], b: [0, 0, 1] },
  bottom: { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, -1] },
  front: { n: [0, 0, 1], a: [1, 0, 0], b: [0, -1, 0] },
  back: { n: [0, 0, -1], a: [-1, 0, 0], b: [0, -1, 0] },
} satisfies Record<string, { n: Vec; a: Vec; b: Vec }>;
type Face = (typeof FACES)[keyof typeof FACES];

const RAD = Math.PI / 180;
const dot = (p: Vec, q: Vec) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const along = (p: Vec, q: Vec, s: number): Vec => [p[0] + q[0] * s, p[1] + q[1] * s, p[2] + q[2] * s];
const unit = (p: Vec): Vec => { const l = Math.hypot(p[0], p[1], p[2]); return [p[0] / l, p[1] / l, p[2] / l]; };
const mix = (p: Rgb, q: Rgb, t: number): Rgb => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** sRGB hex to linear light, the way the engine decodes every colour (the fog's too). */
function linear(hex: number): Rgb {
  return [srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255), srgbToLinear((hex & 255) / 255)];
}
/**
 * Linear light to what's painted, the inverse: the sky shader decodes its texels the engine's
 * way too, so the horizon comes out the fog's exact colour.
 */
const encode = (c: Rgb): Rgb => [255 * linearToSrgb(c[0]), 255 * linearToSrgb(c[1]), 255 * linearToSrgb(c[2])];
const css = (c: Rgb) => { const [r, g, b] = encode(c); return `rgb(${r.toFixed(1)},${g.toFixed(1)},${b.toFixed(1)})`; };

/**
 * A lump of cloud: an ellipse `x`, `y` (deg) off the cloud's middle and flat bottom, `rx`, `ry`
 * (deg) across. Its white is lifted `lift` (of `ry`) off its lilac: a band under the base row, a
 * crescent under the heap.
 */
interface Puff { x: number; y: number; rx: number; ry: number; lift: number }
/**
 * A cartoon cloud, a flat card facing the camera at its base's middle `c` (`e` east and `u` up
 * along it), in three tones: lilac underneath, white body, whiter tops.
 */
interface Cloud { el: number; c: Vec; e: Vec; u: Vec; reach: number; puffs: Puff[]; shade: string; body: string; light: string }

/** Unit direction `az` (deg, from +Z toward +X) round and `el` (deg) up. */
function direction(az: number, el: number): Vec {
  const ce = Math.cos(el * RAD);
  return [Math.sin(az * RAD) * ce, Math.sin(el * RAD), Math.cos(az * RAD) * ce];
}

class SkyPainter {
  private horizon: Rgb;
  private zenith = linear(ZENITH);
  private sky = linear(SKY);
  private pale = linear(PALE);
  private glow = linear(SUN_GLOW);
  private sun: Vec;

  constructor(horizon: number, sun: Vec) {
    this.horizon = linear(horizon);
    this.sun = unit(sun);
  }

  /**
   * The sky's colour (linear) looking along `d`: the fog's colour at and below the horizon, a pale
   * haze just over it, deepening to the zenith's blue; a warm glow round the sun.
   */
  colour(d: Vec): Rgb {
    const el = Math.asin(Math.max(-1, Math.min(1, d[1]))) / RAD;
    if (el <= 0) return this.horizon;
    let c = mix(this.sky, this.zenith, smooth(8, 90, el));
    c = mix(c, this.pale, 0.65 * Math.exp(-el / 14));
    c = mix(c, this.horizon, Math.exp(-el / 3.2));
    const toSun = Math.acos(Math.max(-1, Math.min(1, dot(d, this.sun)))) / RAD;
    return mix(c, this.glow, 0.5 * Math.exp(-((toSun / 9) ** 2)) + 0.15 * Math.exp(-((toSun / 28) ** 2)));
  }

  /** A deal of cartoon clouds round the horizon, the same for everyone (a fixed seed). */
  clouds(): Cloud[] {
    const rand = mulberry32(0x5c10d5);
    const out: Cloud[] = [];
    const n = 18;
    for (let i = 0; i < n; i++) {
      const az = (i / n) * 360 + (rand() - 0.5) * 14;
      // most sit low (far off, where the camera looks), a few high up (near and big)
      const el = 1.5 + 19 * rand() ** 1.25;
      const width = 8 + el * 0.55 + rand() * 9;
      out.push(this.cloud(rand, az, el, width));
    }
    return out.sort((p, q) => p.el - q.el); // far ones first
  }

  private cloud(rand: () => number, az: number, el: number, width: number): Cloud {
    const puffs: Puff[] = [];
    // the base: a wide flat slab (no gaps along the bottom), and a row of low puffs, all cut
    // flat (the end ones sit higher, so the ends come out round)
    puffs.push({ x: 0, y: width * 0.04, rx: width * 0.42, ry: width * 0.12, lift: 1.1 });
    const nBase = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < nBase; i++) {
      const side = i / (nBase - 1) - 0.5;
      const x = side * width * 0.78 + (rand() - 0.5) * width * 0.05;
      const r = width * (0.13 + rand() * 0.05);
      puffs.push({ x, y: r * (0.35 + 1.8 * side * side), rx: r * 1.25, ry: r, lift: 0.95 });
    }
    // the heap: bigger puffs on top, the tallest toward the middle
    const nTop = 2 + Math.floor(rand() * 3);
    for (let j = 0; j < nTop; j++) {
      const x = ((j + 0.5) / nTop - 0.5) * width * 0.6 + (rand() - 0.5) * width * 0.08;
      const r = width * (0.17 + rand() * 0.08) * (1 - (0.9 * Math.abs(x)) / width);
      puffs.push({ x, y: width * 0.1 + r * 0.75, rx: r, ry: r, lift: 0.3 });
    }
    // far off (low down) they're flatter, and fade into the haze
    const squash = 0.55 + 0.45 * smooth(0, 22, el);
    for (const p of puffs) { p.y *= squash; p.ry *= squash; }
    const c = direction(az, el);
    const e: Vec = [Math.cos(az * RAD), 0, -Math.sin(az * RAD)];
    const u = unit(along([0, 1, 0], c, -c[1]));
    const haze = 0.45 * (1 - smooth(1, 14, el));
    const behind = this.colour(direction(az, el + 1));
    const tone = (hex: number) => css(mix(linear(hex), behind, haze));
    return { el, c, e, u, reach: width, puffs, shade: tone(CLOUD_SHADE), body: tone(CLOUD_BODY), light: tone(CLOUD_LIGHT) };
  }

  face(f: Face, size: number, clouds: Cloud[]): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;

    // the gradient, on a coarse grid with samples on the face's very edges (so the faces meet)
    const grid = document.createElement("canvas");
    grid.width = grid.height = GRID + 1;
    const g = grid.getContext("2d")!;
    const img = g.createImageData(GRID + 1, GRID + 1);
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        const d = unit(along(along(f.n, f.a, (i / GRID) * 2 - 1), f.b, (j / GRID) * 2 - 1));
        const [r, gg, b] = encode(this.colour(d));
        const k = (j * (GRID + 1) + i) * 4;
        img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = b; img.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(grid, 0.5, 0.5, GRID, GRID, 0, 0, size, size);

    // where a direction lands on this face, in pixels (null: behind it)
    const at = (d: Vec): [number, number] | null => {
      const z = dot(d, f.n);
      return z > 0.05 ? [((dot(d, f.a) / z + 1) * size) / 2, ((dot(d, f.b) / z + 1) * size) / 2] : null;
    };
    // an ellipse on a card (middle `o`, `e` and `u` its half axes) as it lands here: three points
    // make the affine map from a unit circle (fine at a few degrees across)
    const ellipse = (o: Vec, e: Vec, u: Vec) => {
      const p = at(o), px = at(along(o, e, 1)), py = at(along(o, u, 1));
      if (!p || !px || !py) return;
      const ax = px[0] - p[0], ay = px[1] - p[1], bx = py[0] - p[0], by = py[1] - p[1];
      ctx.setTransform(ax, ay, bx, by, p[0], p[1]);
      ctx.moveTo(1, 0);
      // every ellipse wound the same way, so overlapping ones fill as one shape
      ctx.arc(0, 0, 1, 0, Math.PI * 2, ax * by - ay * bx < 0);
    };

    // the sun, where the shadows say it is
    if (dot(this.sun, f.n) > 0.3) {
      const e = unit(Math.abs(this.sun[1]) > 0.99 ? [1, 0, 0] : [this.sun[2], 0, -this.sun[0]]);
      const u: Vec = [this.sun[1] * e[2] - this.sun[2] * e[1], this.sun[2] * e[0] - this.sun[0] * e[2], this.sun[0] * e[1] - this.sun[1] * e[0]];
      const r = Math.tan(3.6 * RAD);
      ctx.beginPath();
      ellipse(this.sun, [e[0] * r, e[1] * r, e[2] * r], [u[0] * r, u[1] * r, u[2] * r]);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = css(linear(SUN_DISC));
      ctx.fill();
    }

    for (const cl of clouds) {
      if (dot(cl.c, f.n) < 0.3) continue;
      const puffPath = (lift: number, grow: number) => {
        ctx.beginPath();
        for (const p of cl.puffs) {
          const o = along(along(cl.c, cl.e, Math.tan(p.x * RAD)), cl.u, Math.tan((p.y + lift * p.lift * p.ry) * RAD));
          const rx = Math.tan(p.rx * grow * RAD), ry = Math.tan(p.ry * grow * RAD);
          ellipse(o, [cl.e[0] * rx, cl.e[1] * rx, cl.e[2] * rx], [cl.u[0] * ry, cl.u[1] * ry, cl.u[2] * ry]);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      };
      ctx.save();
      // the flat bottom: only what's over the base line (a straight line on the card stays straight here)
      const w = Math.tan(cl.reach * RAD);
      const pa = at(along(cl.c, cl.e, -w)), pb = at(along(cl.c, cl.e, w)), pu = at(along(cl.c, cl.u, 0.05));
      if (!pa || !pb || !pu) { ctx.restore(); continue; }
      let tx = pb[0] - pa[0], ty = pb[1] - pa[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      let nx = -ty, ny = tx;
      if ((pu[0] - pa[0]) * nx + (pu[1] - pa[1]) * ny < 0) { nx = -nx; ny = -ny; }
      const L = size * 4;
      ctx.beginPath();
      ctx.moveTo(pa[0] - tx * L, pa[1] - ty * L);
      ctx.lineTo(pb[0] + tx * L, pb[1] + ty * L);
      ctx.lineTo(pb[0] + tx * L + nx * L, pb[1] + ty * L + ny * L);
      ctx.lineTo(pa[0] - tx * L + nx * L, pa[1] - ty * L + ny * L);
      ctx.closePath();
      ctx.clip();
      // lilac all over, then the white body lifted off it (leaving a shadow under every puff),
      // then the sunlit tops lifted again
      puffPath(0, 1);
      ctx.fillStyle = cl.shade;
      ctx.fill();
      ctx.clip();
      puffPath(1, 1);
      ctx.fillStyle = cl.body;
      ctx.fill();
      puffPath(1.8, 0.82);
      ctx.fillStyle = cl.light;
      ctx.fill();
      ctx.restore();
    }
    return canvas;
  }
}

/**
 * The sky behind the town: a cube map painted once, here, at load (no download). A blue that
 * deepens overhead and pales to the fog's colour `horizon` at the horizon (so the fogged far
 * ground melts into it), cartoon clouds round the horizon, and the sun where `toSun` points.
 * Drawn by the view's own background pass: one texture read per sky pixel, as cheap as the
 * plain gradient it replaces. `size` is each face's edge in pixels.
 */
export function paintSky(horizon: number, toSun: { x: number; y: number; z: number }, size: number): CubeTexture {
  const f = skyFaces(horizon, toSun, size);
  return CubeTexture.from({
    faces: {
      right: Texture.from(f.right), left: Texture.from(f.left),
      top: Texture.from(f.top), bottom: Texture.from(f.bottom),
      front: Texture.from(f.front), back: Texture.from(f.back),
    },
    label: "sky",
  });
}

/** The six faces as pictures, by pixi's names for them. */
export function skyFaces(horizon: number, toSun: { x: number; y: number; z: number }, size: number) {
  const painter = new SkyPainter(horizon, [toSun.x, toSun.y, toSun.z]);
  const clouds = painter.clouds();
  const faces = {} as Record<keyof typeof FACES, HTMLCanvasElement>;
  for (const name of Object.keys(FACES) as (keyof typeof FACES)[]) faces[name] = painter.face(FACES[name], size, clouds);
  return faces;
}
