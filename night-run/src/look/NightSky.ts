import { Container3D, FlatMaterial, Geometry3D, linearToSrgb, Mesh3D, srgbToLinear } from '@pixi/3d';
import { CubeTexture, Texture } from 'pixi.js';

import { skipToneCurve } from './toneCurve';

/** Background cube face size: the cloud deck stays soft rather than blocky on a 1080p frame. */
const SKY_FACE = 512;
/** Reflection cube face size; the IBL prefilter resamples it to 256 anyway. */
const ENV_FACE = 128;
const DEG = Math.PI / 180;

/** Compass bearings, in degrees from +z toward +x. */
const CITY_BEARING = 55;
/** Where the lightning lights the cloud deck from; both scene bolts stand near it. */
const FLASH_BEARING = -34;
const MOON_BEARING = -112;
const MOON_ELEVATION = 17;

/** Unit vector toward the moon: low in the sky, off to the side of the home straight. */
export const MOON_DIRECTION: readonly [number, number, number] = [
  Math.cos(MOON_ELEVATION * DEG) * Math.sin(MOON_BEARING * DEG),
  Math.sin(MOON_ELEVATION * DEG),
  Math.cos(MOON_ELEVATION * DEG) * Math.cos(MOON_BEARING * DEG),
];

const [MOON_X, MOON_Y, MOON_Z] = MOON_DIRECTION;
const CITY_X = Math.sin(CITY_BEARING * DEG);
const CITY_Z = Math.cos(CITY_BEARING * DEG);
const FLASH_X = Math.sin(FLASH_BEARING * DEG);
const FLASH_Z = Math.cos(FLASH_BEARING * DEG);

type Rgb = readonly [number, number, number];

/** An sRGB hex colour as linear light, the space the sky is painted in. */
function lin(color: number): Rgb {
  return [
    srgbToLinear(((color >> 16) & 0xff) / 255),
    srgbToLinear(((color >> 8) & 0xff) / 255),
    srgbToLinear((color & 0xff) / 255),
  ];
}

const ZENITH = lin(0x03050b);
const HIGH_SKY = lin(0x0a0f1e);
/** The cloud deck's underside where no city light reaches it. */
const DECK = lin(0x0d1019);
const GLOW_SODIUM = lin(0xe0702e);
const GLOW_MAGENTA = lin(0xa23a8c);
const GLOW_VIOLET = lin(0x3a2e6c);
/** The rain haze on the horizon: warm mauve toward the city, blue-grey away from it. */
const HORIZON_CITY = lin(0x553242);
const HORIZON_AWAY = lin(0x1a2030);
const BELOW = lin(0x06070b);
const SKYLINE = lin(0x0a0a12);
const MOON_DISC = lin(0xf2f5ff);
const MOON_HALO = lin(0x8ea0cc);
/** Blue-white light inside the deck when lightning fires. */
const FLASH = lin(0xb8c4ff);
const CITY_LIGHT = lin(0xffb066);
const STAR = lin(0xc8d4ff);

/** Elevation, in degrees, over which the haze melts the sky into the horizon colour. */
const HAZE = 3.2;
/** The deck's height over the lens, in the noise's units; the horizon converges where it meets the haze. */
const DECK_LIFT = 0.035;
const DECK_SCALE = 1.15;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));

  return t * t * (3 - 2 * t);
}

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x2c1b3c6d);

  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);

  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A 256 × 256 lattice of random values that the noise tiles; far quicker than hashing every corner. */
const LATTICE: Float32Array = (() => {
  const lattice = new Float32Array(256 * 256);

  for (let i = 0; i < lattice.length; i++) lattice[i] = hash(i & 255, i >> 8, 1);

  return lattice;
})();

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const x0 = (xi + seed * 59) & 255;
  const x1 = (x0 + 1) & 255;
  const y0 = ((yi + seed * 113) & 255) << 8;
  const y1 = (y0 + 256) & 0xffff;
  const a = LATTICE[y0 + x0];
  const b = LATTICE[y0 + x1];
  const c = LATTICE[y1 + x0];
  const d = LATTICE[y1 + x1];

  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/**
 * Fractal noise, 0 to 1, with octaves finer than `footprint` (the noise-space size of one texel) faded out, so the
 * deck thins to smooth streaks toward the horizon instead of aliasing.
 */
function fbm(x: number, y: number, octaves: number, seed: number, footprint: number): number {
  let sum = 0;
  let norm = 0;
  let amp = 0.5;
  let freq = 1;

  for (let i = 0; i < octaves; i++) {
    const keep = 1 - smoothstep(0.25, 0.6, freq * footprint);

    norm += amp;

    if (keep > 0) sum += amp * (keep * valueNoise(x * freq, y * freq, seed + i) + (1 - keep) * 0.5);
    else sum += amp * 0.5;

    freq *= 2.03;
    amp *= 0.5;
  }

  return sum / norm;
}

/** How much a bearing faces the city, 0 to 1. */
function cityward(hx: number, hz: number): number {
  const c = (1 + hx * CITY_X + hz * CITY_Z) / 2;

  return c * c;
}

function mixInto(out: Float64Array, o: number, color: ArrayLike<number>, t: number): void {
  out[o] += (color[0] - out[o]) * t;
  out[o + 1] += (color[1] - out[o + 1]) * t;
  out[o + 2] += (color[2] - out[o + 2]) * t;
}

function addInto(out: Float64Array, o: number, color: ArrayLike<number>, k: number): void {
  out[o] += color[0] * k;
  out[o + 1] += color[1] * k;
  out[o + 2] += color[2] * k;
}

function horizonInto(out: Float64Array, o: number, hx: number, hz: number, flash: number): void {
  const w = cityward(hx, hz);

  out[o] = HORIZON_AWAY[0] + (HORIZON_CITY[0] - HORIZON_AWAY[0]) * w;
  out[o + 1] = HORIZON_AWAY[1] + (HORIZON_CITY[1] - HORIZON_AWAY[1]) * w;
  out[o + 2] = HORIZON_AWAY[2] + (HORIZON_CITY[2] - HORIZON_AWAY[2]) * w;

  if (flash > 0) {
    const toward = (1 + hx * FLASH_X + hz * FLASH_Z) / 2;

    addInto(out, o, FLASH, flash * 0.1 * (0.35 + 0.65 * toward * toward * toward));
  }
}

const _horizon = new Float64Array(3);
const _glow = new Float64Array(3);
/** The horizon colour, plain at 0..2 and lit by lightning at 3..5. */
const _haze = new Float64Array(6);

/**
 * The rain haze on the horizon for a view bearing, which the fog takes so distant scenery melts into the sky.
 * @param hx - Horizontal view direction, x; need not be unit length.
 * @param hz - Horizontal view direction, z.
 * @param flash - Lightning, 0 to 1: the haze lights up with the cloud deck.
 * @returns The colour as `0xRRGGBB`.
 */
export function horizonColor(hx: number, hz: number, flash = 0): number {
  const l = Math.sqrt(hx * hx + hz * hz);

  horizonInto(_horizon, 0, l > 1e-6 ? hx / l : 0, l > 1e-6 ? hz / l : 0, flash);

  const r = Math.round(linearToSrgb(Math.min(1, _horizon[0])) * 255);
  const g = Math.round(linearToSrgb(Math.min(1, _horizon[1])) * 255);
  const b = Math.round(linearToSrgb(Math.min(1, _horizon[2])) * 255);

  return (r << 16) | (g << 8) | b;
}

/** Horizon colour side-on to the city; the app's clear colour and the game's default fog. */
export const HORIZON = horizonColor(-CITY_Z, CITY_X);

/** The deck's glow colour from the city lights under it, sodium low and toward the city, violet high and away. */
function glowInto(out: Float64Array, elevation: number, toward: number): void {
  const h = Math.min(1.4, elevation / 26 + (1 - toward) * 0.8);

  if (h < 0.5) {
    const k = h / 0.5;

    out[0] = GLOW_SODIUM[0] + (GLOW_MAGENTA[0] - GLOW_SODIUM[0]) * k;
    out[1] = GLOW_SODIUM[1] + (GLOW_MAGENTA[1] - GLOW_SODIUM[1]) * k;
    out[2] = GLOW_SODIUM[2] + (GLOW_MAGENTA[2] - GLOW_SODIUM[2]) * k;
  } else {
    const k = Math.min(1, (h - 0.5) / 0.6);

    out[0] = GLOW_MAGENTA[0] + (GLOW_VIOLET[0] - GLOW_MAGENTA[0]) * k;
    out[1] = GLOW_MAGENTA[1] + (GLOW_VIOLET[1] - GLOW_MAGENTA[1]) * k;
    out[2] = GLOW_MAGENTA[2] + (GLOW_VIOLET[2] - GLOW_MAGENTA[2]) * k;
  }
}

/**
 * The far city on the horizon, into both layers of `out`: a skyline toward {@link CITY_BEARING} with lit windows,
 * and scattered lights all round.
 */
function cityInto(out: Float64Array, hx: number, hz: number, elevation: number, tx: number, ty: number): void {
  if (elevation > 2.4 || elevation < -1.6) return;

  const bearing = Math.atan2(hx, hz) / DEG;
  let off = bearing - CITY_BEARING;

  off -= 360 * Math.round(off / 360);

  const near = Math.max(0, 1 - Math.abs(off) / 62);
  // Blocks of buildings about half a degree wide, taller toward the middle of the city.
  const block = Math.floor((bearing + 360) * 2.1);
  const tall = hash(block, 7, 3);
  const height = near > 0 ? (0.15 + 1.6 * tall * tall * near + (tall > 0.93 ? 0.7 : 0)) * smoothstep(0, 0.25, near) : 0;
  const pick = hash(tx, ty, 11);

  if (elevation < height) {
    mixInto(out, 0, SKYLINE, 0.7);
    mixInto(out, 3, SKYLINE, 0.7);

    if (pick < 0.07 * near) {
      const light = 0.05 + 0.25 * hash(tx, ty, 12);

      addInto(out, 0, CITY_LIGHT, light);
      addInto(out, 3, CITY_LIGHT, light);
    }
  } else if (elevation < 0.25 && pick < 0.012 + 0.05 * near) {
    const light = 0.04 + 0.22 * hash(tx, ty, 13);

    addInto(out, 0, CITY_LIGHT, light);
    addInto(out, 3, CITY_LIGHT, light);
  }
}

/**
 * The cloud deck's noise for one face on a grid of every other texel corner, bilinearly sampled per texel: the deck
 * is soft, and four times fewer noise evaluations keep the painting quick.
 */
const CLOUD_CELLS = SKY_FACE / 2;
const CLOUD_GRID = CLOUD_CELLS + 1;
const _cloudDensity = new Float32Array(CLOUD_GRID * CLOUD_GRID);
const _cloudLump = new Float32Array(CLOUD_GRID * CLOUD_GRID);
const _cloudDirection = new Float64Array(3);

function prepareClouds(face: number): void {
  for (let gy = 0; gy < CLOUD_GRID; gy++) {
    const t = (gy / CLOUD_CELLS) * 2 - 1;

    for (let gx = 0; gx < CLOUD_GRID; gx++) {
      faceDirection(face, (gx / CLOUD_CELLS) * 2 - 1, t, _cloudDirection);

      const i = gy * CLOUD_GRID + gx;
      const dy = _cloudDirection[1];

      if (dy < -0.02) {
        _cloudDensity[i] = 0;
        _cloudLump[i] = 0.5;
        continue;
      }

      // The deck is a plane over the lens; noise on it compresses toward the horizon like a real overcast.
      const lift = Math.max(0, dy) + DECK_LIFT;
      const px = (_cloudDirection[0] / lift) * DECK_SCALE;
      const pz = (_cloudDirection[2] / lift) * DECK_SCALE;
      // Noise-space size of one grid cell: the plane stretches as 1/sin² of the elevation.
      const footprint = ((Math.PI / CLOUD_CELLS) * DECK_SCALE) / (lift * lift);
      const wx = fbm(px * 0.6 + 3.1, pz * 0.6 - 1.7, 2, 41, footprint * 0.6);
      const wz = fbm(px * 0.6 - 7.3, pz * 0.6 + 5.2, 2, 53, footprint * 0.6);

      _cloudDensity[i] = fbm(px + wx * 1.6, pz + wz * 1.6, 5, 7, footprint);
      _cloudLump[i] = fbm(px * 2.6 + 19.3, pz * 2.6 - 4.1, 3, 23, footprint * 2.6);
    }
  }
}

/** Bilinear sample of a cloud grid at texel (x, y) of the face. */
function sampleClouds(grid: Float32Array, x: number, y: number): number {
  const gx = (x + 0.5) * 0.5;
  const gy = (y + 0.5) * 0.5;
  const ix = Math.min(CLOUD_CELLS - 1, gx | 0);
  const iy = Math.min(CLOUD_CELLS - 1, gy | 0);
  const fx = gx - ix;
  const fy = gy - iy;
  const i = iy * CLOUD_GRID + ix;
  const a = grid[i];
  const b = grid[i + 1];
  const c = grid[i + CLOUD_GRID];
  const d = grid[i + CLOUD_GRID + 1];

  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

const COS_MOON_REACH = Math.cos(60 * DEG);
/** Below this elevation the haze has fully given way to the dark ground. */
const BELOW_DY = -Math.sin(7 * DEG);
const COS_MOON_THIN = Math.cos(16 * DEG);

/**
 * Shade one texel of the night sky into `out`: the plain sky at 0..2 and the lightning-lit sky at 3..5, both linear
 * light. Reads the face's cloud grid from {@link prepareClouds}.
 */
function shadeSky(dx: number, dy: number, dz: number, x: number, y: number, face: number, out: Float64Array): void {
  // Well below the horizon there is only dark ground; most of the cube's lower half takes this exit.
  if (dy < BELOW_DY) {
    out[0] = out[3] = BELOW[0];
    out[1] = out[4] = BELOW[1];
    out[2] = out[5] = BELOW[2];

    return;
  }

  const tx = x + face * SKY_FACE;
  const ty = y;
  const flat = Math.sqrt(dx * dx + dz * dz);
  const hx = flat > 1e-6 ? dx / flat : 0;
  const hz = flat > 1e-6 ? dz / flat : 1;
  const elevation = Math.asin(Math.max(-1, Math.min(1, dy))) / DEG;
  const toward = cityward(hx, hz);
  const flashToward = (1 + hx * FLASH_X + hz * FLASH_Z) / 2;
  const flashFocus = 0.12 + 0.88 * flashToward * flashToward * flashToward * flashToward;

  horizonInto(_haze, 0, hx, hz, 0);
  horizonInto(_haze, 3, hx, hz, 1);

  if (dy <= 0) {
    const dark = smoothstep(0, 7, -elevation);

    out.set(_haze);
    mixInto(out, 0, BELOW, dark);
    mixInto(out, 3, BELOW, dark * 0.85);
    cityInto(out, hx, hz, elevation, tx, ty);

    return;
  }

  const n = sampleClouds(_cloudDensity, x, y);
  const lump = sampleClouds(_cloudLump, x, y);

  const cosMoon = dx * MOON_X + dy * MOON_Y + dz * MOON_Z;
  const moonAngle = cosMoon > COS_MOON_REACH ? Math.acos(Math.min(1, cosMoon)) / DEG : 90;
  // The deck thins round the moon, so it shows as a hazy disc rather than a smudge.
  const thin = cosMoon > COS_MOON_THIN ? 0.5 + 0.5 * smoothstep(2.5, 16, moonAngle) : 1;
  const cover = smoothstep(0.3, 0.6, n) * thin;

  // Gaps: dark sky deepening to the zenith.
  out[0] = _haze[0];
  out[1] = _haze[1];
  out[2] = _haze[2];
  mixInto(out, 0, HIGH_SKY, smoothstep(0, 22, elevation));
  mixInto(out, 0, ZENITH, smoothstep(30, 85, elevation));

  if (elevation > 9 && cover < 0.2) {
    const star = hash(tx, ty, 5);

    if (star < 0.0016) addInto(out, 0, STAR, (0.02 + 0.1 * hash(tx, ty, 6)) * (1 - cover / 0.2));
  }

  out[3] = out[0];
  out[4] = out[1];
  out[5] = out[2];
  addInto(out, 3, FLASH, 0.06 * flashFocus);

  // Cloud: the underside glows with the city under it, sodium toward the horizon, magenta into violet overhead.
  const high = Math.exp(-elevation / 30);
  const glow = 0.12 * high + 0.8 * toward * Math.exp(-elevation / 12);
  const body = 0.45 + 1.1 * lump;

  glowInto(_glow, elevation, toward);

  const cr = DECK[0] + _glow[0] * glow * body;
  const cg = DECK[1] + _glow[1] * glow * body;
  const cb = DECK[2] + _glow[2] * glow * body;

  out[0] += (cr - out[0]) * cover;
  out[1] += (cg - out[1]) * cover;
  out[2] += (cb - out[2]) * cover;
  out[3] += (cr - out[3]) * cover;
  out[4] += (cg - out[4]) * cover;
  out[5] += (cb - out[5]) * cover;

  // Lightning inside the deck: thick cloud scatters it, brightest round the strike and in the deck's lower layers.
  addInto(out, 3, FLASH, flashFocus * (0.5 + 0.5 * high) * (0.015 + 0.5 * cover * (0.25 + 0.95 * lump)));

  if (moonAngle < 60) {
    // The moon behind thin cloud: a silver corona, the deck round it catching its light, and a soft disc.
    const corona = 0.55 * Math.exp(-moonAngle / 3.4) + 0.18 * Math.exp(-moonAngle / 13);
    const sheen = 0.07 * Math.exp(-moonAngle / 20) * cover * (0.4 + lump);
    const disc = smoothstep(1.5, 0.55, moonAngle) * (1 - 0.4 * cover);

    addInto(out, 0, MOON_HALO, corona * (0.3 + 0.7 * cover) + sheen);
    addInto(out, 0, MOON_DISC, disc * 0.9);
    addInto(out, 3, MOON_HALO, corona * 0.3);
    addInto(out, 3, MOON_DISC, disc * 0.3);
  }

  // Haze melts everything into the horizon colour the fog uses.
  if (elevation < 30) {
    const haze = Math.exp(-elevation / HAZE);

    mixInto(out, 0, _haze, haze);
    out[3] += (_haze[3] - out[3]) * haze;
    out[4] += (_haze[4] - out[4]) * haze;
    out[5] += (_haze[5] - out[5]) * haze;
  }

  cityInto(out, hx, hz, elevation, tx, ty);
}

/** A neon sign, tube or floodlight in the reflection cube: bearing and elevation of its centre, half-sizes, all degrees. */
type Lamp = readonly [
  bearing: number,
  elevation: number,
  halfWidth: number,
  halfHeight: number,
  color: number,
  power: number,
];

/**
 * What the wet road and the paint reflect: signs and tubes low round the track in the take's neon colours, and the
 * floodlight heads higher up. Reflections are all the reflection cube is for, so it is free to invent them.
 */
const LAMPS: readonly Lamp[] = [
  [-160, 6, 7, 1.6, 0xff2bd6, 0.9],
  [-128, 3.5, 3, 4.5, 0x2ee6ff, 0.8],
  [-96, 7, 9, 1.4, 0xff7a1a, 0.85],
  [-62, 4, 2.2, 6, 0xff2a4a, 0.75],
  [-34, 8, 6, 1.8, 0x8a5bff, 0.8],
  [-8, 3, 11, 1.1, 0x2ee6ff, 0.7],
  [18, 6.5, 4, 2.4, 0xff2bd6, 0.85],
  [44, 4.5, 2, 5, 0xffd23a, 0.7],
  [70, 7.5, 8, 1.5, 0x2affc0, 0.75],
  [98, 3.5, 5, 2.2, 0xff2a4a, 0.85],
  [124, 6, 2.4, 5.5, 0x8a5bff, 0.8],
  [150, 4, 9, 1.3, 0xff7a1a, 0.8],
  [178, 7, 3.5, 2.6, 0x2ee6ff, 0.8],
];

/** Floodlight heads: bearing, elevation, disc radius in degrees. */
const FLOODS: readonly (readonly [number, number, number])[] = [
  [-140, 26, 1.8],
  [-75, 30, 1.6],
  [-15, 24, 1.9],
  [40, 31, 1.6],
  [95, 25, 1.8],
  [160, 29, 1.7],
];

const FLOOD = lin(0xfff0d6);
const LAMP_COLORS: readonly Rgb[] = LAMPS.map((lamp) => lin(lamp[4]));

function shadeEnvironment(
  dx: number,
  dy: number,
  dz: number,
  _x: number,
  _y: number,
  _face: number,
  out: Float64Array,
): void {
  const flat = Math.sqrt(dx * dx + dz * dz);
  const hx = flat > 1e-6 ? dx / flat : 0;
  const hz = flat > 1e-6 ? dz / flat : 1;
  const elevation = Math.asin(Math.max(-1, Math.min(1, dy))) / DEG;
  const toward = cityward(hx, hz);

  horizonInto(out, 0, hx, hz, 0);

  if (elevation < 0) {
    mixInto(out, 0, BELOW, smoothstep(0, 10, -elevation));

    return;
  }

  // A smooth stand-in for the deck: the city glow under an even overcast.
  glowInto(_glow, elevation, toward);
  mixInto(out, 0, DECK, smoothstep(0, 12, elevation));
  addInto(out, 0, _glow, (0.12 * Math.exp(-elevation / 30) + 0.8 * toward * Math.exp(-elevation / 12)) * 0.9);

  const bearing = Math.atan2(hx, hz) / DEG;
  const cosElevation = flat;

  for (let i = 0; i < LAMPS.length; i++) {
    const [b, e, w, h, , power] = LAMPS[i];
    const v = Math.abs(elevation - e) / h;

    if (v > 2.5) continue;

    let off = bearing - b;

    off -= 360 * Math.round(off / 360);

    const d = Math.max(Math.abs(off * cosElevation) / w, v);

    if (d > 2.5) continue;

    addInto(out, 0, LAMP_COLORS[i], power * (smoothstep(1.05, 0.85, d) + 0.14 * Math.exp(-Math.max(0, d - 1) * 2.2)));
  }

  for (let i = 0; i < FLOODS.length; i++) {
    const [b, e, r] = FLOODS[i];
    const de = elevation - e;

    if (Math.abs(de) > r * 6) continue;

    let off = bearing - b;

    off -= 360 * Math.round(off / 360);
    off *= cosElevation;

    const d = Math.sqrt(off * off + de * de) / r;

    if (d > 6) continue;

    addInto(out, 0, FLOOD, smoothstep(1.05, 0.8, d) * 1.2 + 0.1 * Math.exp(-(d - 1) * 0.9));
  }
}

type Face = 'right' | 'left' | 'top' | 'bottom' | 'front' | 'back';

const FACES: readonly Face[] = ['right', 'left', 'top', 'bottom', 'front', 'back'];

/**
 * The unit direction point (s, t) of a cube face looks along, s left to right and t top to bottom, both -1 to 1, in
 * the cube-map convention both backends sample with; into `out`.
 */
function faceDirection(face: number, s: number, t: number, out: Float64Array): void {
  let dx = s;
  let dy = -t;
  let dz = 1;

  if (face === 0) {
    dx = 1;
    dz = -s;
  } else if (face === 1) {
    dx = -1;
    dz = s;
  } else if (face === 2) {
    dy = 1;
    dz = t;
  } else if (face === 3) {
    dy = -1;
    dz = -t;
  } else if (face === 5) {
    dx = -s;
    dz = -1;
  }

  const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);

  out[0] = dx * inv;
  out[1] = dy * inv;
  out[2] = dz * inv;
}

/** Linear light in steps of 1/65535 to gamma-2.2 bytes: fine enough in the darks to dither cleanly. */
const ENCODE_STEPS = 65535;
const ENCODE: Float32Array = (() => {
  const table = new Float32Array(ENCODE_STEPS + 1);

  for (let i = 0; i <= ENCODE_STEPS; i++) table[i] = Math.pow(i / ENCODE_STEPS, 1 / 2.2) * 255;

  return table;
})();

/**
 * Both backends decode a cube texel with a 2.2 power, so the texels store linear light to the 1/2.2. A texel's
 * worth of hashed dither hides the banding eight bits leave in a dark gradient.
 */
function encode(value: number, dither: number): number {
  return ENCODE[((value < 0 ? 0 : value > 1 ? 1 : value) * ENCODE_STEPS + 0.5) | 0] + dither;
}

/** A tile of hashed dither, -0.5 to 0.5 of a byte, so the per-texel dither is a lookup. */
const DITHER: Float32Array = (() => {
  const tile = new Float32Array(64 * 64);

  for (let i = 0; i < tile.length; i++) tile[i] = hash(i & 63, i >> 6, 97) - 0.5;

  return tile;
})();

/** Shades one texel: its direction, its texel on the face, the face, and the layers' linear colours out. */
type TexelShader = (dx: number, dy: number, dz: number, x: number, y: number, face: number, out: Float64Array) => void;

const _direction = new Float64Array(3);

/**
 * Paint `layers` cube maps in one sweep, every texel shaded from its own direction so the faces meet without seams.
 * @param size - Face size in texels.
 * @param layers - How many cubes `shade` writes at once, three channels each.
 * @param label - Texture label prefix.
 * @param shade - The texel shader.
 * @param prepare - Called before each face, for work shared across its texels.
 */
function paintCubes(
  size: number,
  layers: number,
  label: string,
  shade: TexelShader,
  prepare?: (face: number) => void,
): CubeTexture[] {
  const out = new Float64Array(layers * 3);
  const faces: Record<Face, Texture>[] = [];

  for (let l = 0; l < layers; l++) faces.push({} as Record<Face, Texture>);

  for (let f = 0; f < FACES.length; f++) {
    const canvases: HTMLCanvasElement[] = [];
    const images: ImageData[] = [];

    for (let l = 0; l < layers; l++) {
      const canvas = document.createElement('canvas');

      canvas.width = canvas.height = size;
      canvases.push(canvas);
      images.push(canvas.getContext('2d')!.createImageData(size, size));
    }

    prepare?.(f);

    for (let y = 0; y < size; y++) {
      const t = ((y + 0.5) / size) * 2 - 1;

      for (let x = 0; x < size; x++) {
        faceDirection(f, ((x + 0.5) / size) * 2 - 1, t, _direction);
        shade(_direction[0], _direction[1], _direction[2], x, y, f, out);

        const o = (y * size + x) * 4;
        const dither = DITHER[((y + f * 17) & 63) * 64 + ((x + f * 29) & 63)];

        for (let l = 0; l < layers; l++) {
          const pixels = images[l].data;
          const c = l * 3;

          pixels[o] = encode(out[c], dither);
          pixels[o + 1] = encode(out[c + 1], dither);
          pixels[o + 2] = encode(out[c + 2], dither);
          pixels[o + 3] = 255;
        }
      }
    }

    for (let l = 0; l < layers; l++) {
      canvases[l].getContext('2d')!.putImageData(images[l], 0, 0);
      faces[l][FACES[f]] = Texture.from(canvases[l]);
    }
  }

  return faces.map((set, l) => CubeTexture.from({ faces: set, label: `${label}-${l}` }));
}

// -- Lightning bolts --

/** One bolt, drawn on a sphere round the lens. Angles in degrees. */
export interface BoltShape {
  /** Bearing of the channel's top. */
  readonly bearing: number;
  /** Elevation where the channel leaves the cloud base. */
  readonly top: number;
  /** Elevation of the foot; below 0 it strikes behind the horizon. */
  readonly foot: number;
  /** Sideways drift of the foot from the top. */
  readonly lean: number;
  /** Branches that crawl out along the cloud base from the top. */
  readonly crawlers: number;
  readonly seed: number;
}

/** Radius of the sphere the bolts are drawn on: inside the camera's far plane, past the trees. */
const BOLT_RADIUS = 150;
/**
 * A channel's profile from edge to edge: offset in degrees at full strength, then linear colour and alpha. A white
 * core a couple of pixels wide, then a violet glow that falls away to nothing.
 */
const PROFILE: readonly (readonly [offset: number, r: number, g: number, b: number, a: number])[] = [
  [-1.2, 0.42, 0.5, 1, 0],
  [-0.24, 0.5, 0.58, 1, 0.32],
  [-0.06, 1, 1, 1, 0.9],
  [0, 1, 1, 1, 1],
  [0.06, 1, 1, 1, 0.9],
  [0.24, 0.5, 0.58, 1, 0.32],
  [1.2, 0.42, 0.5, 1, 0],
];
const ACROSS = PROFILE.length;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) | 0;

    let t = Math.imul(a ^ (a >>> 15), 1 | a);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A branch as a polyline in the bolt's tangent plane: x across in degrees, y elevation, strength per point. */
interface Channel {
  readonly x: number[];
  readonly y: number[];
  readonly strength: number[];
}

/**
 * Walk a jagged channel from (x, y) along an angle (0 is straight down, positive toward +x), wandering as lightning
 * does: short straight runs between kinks, and now and then a hard turn.
 */
function walk(
  rng: () => number,
  x: number,
  y: number,
  angle: number,
  length: number,
  strength: number,
  floor: number,
): Channel {
  const channel: Channel = { x: [x], y: [y], strength: [strength] };
  const steps = Math.max(3, Math.round(length / 0.45));
  let heading = angle;

  for (let i = 1; i <= steps; i++) {
    const kink = rng() < 0.16 ? 2.6 : 1;

    heading = angle + (heading - angle) * 0.55 + (rng() * 2 - 1) * 0.55 * kink;

    const step = (length / steps) * (0.6 + 0.8 * rng());

    x += Math.sin(heading) * step;
    y -= Math.cos(heading) * step;

    // Strength tapers toward the tip.
    channel.x.push(x);
    channel.y.push(y);
    channel.strength.push(strength * (1 - 0.65 * (i / steps) ** 1.5));

    if (y < floor) break;
  }

  return channel;
}

function growBolt(shape: BoltShape): Channel[] {
  const rng = mulberry32(shape.seed);
  const height = shape.top - shape.foot;
  const main = walk(rng, 0, shape.top, Math.atan2(shape.lean, height), height, 1, shape.foot - 1);
  const channels: Channel[] = [main];

  // Branches fork down and away from the main channel, and fork again.
  const fork = (from: Channel, chance: number, scale: number, depth: number): void => {
    for (let i = 2; i < from.x.length - 3; i++) {
      if (rng() > chance) continue;

      const side = rng() < 0.5 ? -1 : 1;
      const angle = side * (0.45 + rng() * 0.6);
      const length = height * scale * (0.25 + 0.6 * rng());
      const branch = walk(
        rng,
        from.x[i],
        from.y[i],
        angle,
        length,
        from.strength[i] * (0.4 + 0.25 * rng()),
        shape.foot,
      );

      channels.push(branch);

      if (depth > 0) fork(branch, chance * 0.55, scale * 0.45, depth - 1);
    }
  };

  fork(main, 0.17, 0.4, 2);

  // Crawlers spread out sideways under the cloud base from the top.
  for (let i = 0; i < shape.crawlers; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const crawler = walk(rng, 0, shape.top, side * (1.25 + rng() * 0.3), 5 + rng() * 9, 0.55 + 0.2 * rng(), shape.foot);

    channels.push(crawler);
    fork(crawler, 0.12, 0.12, 0);
  }

  return channels;
}

/** Point a tangent-plane point of the bolt on its sphere, into `out` at `o`. */
function boltPoint(shape: BoltShape, x: number, y: number, out: Float32Array, o: number): void {
  const elevation = y * DEG;
  const bearing = (shape.bearing + x / Math.max(0.2, Math.cos(elevation))) * DEG;
  const c = Math.cos(elevation);

  out[o] = c * Math.sin(bearing) * BOLT_RADIUS;
  out[o + 1] = Math.sin(elevation) * BOLT_RADIUS;
  out[o + 2] = c * Math.cos(bearing) * BOLT_RADIUS;
}

/**
 * Build a bolt as additive ribbons, one strip of {@link PROFILE} vertices across each point of each channel.
 * @param shape - The bolt.
 * @param core - Receives the point on the main channel that flares the lens, low enough to stay in frame.
 */
function createBoltGeometry(shape: BoltShape, core: Float32Array): Geometry3D {
  const channels = growBolt(shape);
  const main = channels[0];
  const c = Math.floor(main.x.length * 0.65);

  boltPoint(shape, main.x[c], main.y[c], core, 0);
  let points = 0;
  let segments = 0;

  for (const channel of channels) {
    points += channel.x.length;
    segments += channel.x.length - 1;
  }

  const positions = new Float32Array(points * ACROSS * 3);
  const colors = new Float32Array(points * ACROSS * 4);
  const indices = new Uint32Array(segments * (ACROSS - 1) * 6);
  let vertex = 0;
  let index = 0;

  for (const channel of channels) {
    const { x, y, strength } = channel;
    const n = x.length;

    for (let i = 0; i < n; i++) {
      const prev = Math.max(0, i - 1);
      const next = Math.min(n - 1, i + 1);
      const tx = x[next] - x[prev];
      const ty = y[next] - y[prev];
      const tl = Math.sqrt(tx * tx + ty * ty) || 1;
      const nx = -ty / tl;
      const ny = tx / tl;
      const k = strength[i];
      const width = 0.45 + 0.55 * k;

      for (let j = 0; j < ACROSS; j++) {
        const [offset, r, g, b, alpha] = PROFILE[j];
        const v = vertex + j;
        const c = v * 4;

        boltPoint(shape, x[i] + nx * offset * width, y[i] + ny * offset * width, positions, v * 3);
        colors[c] = r;
        colors[c + 1] = g;
        colors[c + 2] = b;
        colors[c + 3] = alpha * k;
      }

      if (i < n - 1) {
        for (let j = 0; j < ACROSS - 1; j++) {
          const a = vertex + j;
          const b = a + ACROSS;

          indices[index++] = a;
          indices[index++] = b;
          indices[index++] = a + 1;
          indices[index++] = a + 1;
          indices[index++] = b;
          indices[index++] = b + 1;
        }
      }

      vertex += ACROSS;
    }
  }

  return new Geometry3D({ positions, colors, indices });
}

/**
 * The night over the track: a low overcast lit sodium and magenta from below by a city on the horizon, a hazy moon
 * behind thin cloud, a far skyline and its lights, and a few stars in the gaps. It is painted twice, plain and lit
 * up by lightning, and swapping {@link View3D.background} between the two is free. A third cube holds what the wet
 * road and the paint reflect: dark night with neon signs and floodlight heads.
 *
 * It also owns the lightning bolts, drawn on a sphere round the lens: keep {@link NightSky.dome} on the camera.
 */
export class NightSky {
  public readonly background: CubeTexture;
  /** The same sky, the cloud deck lit from inside by lightning. */
  public readonly struck: CubeTexture;
  /** What glossy surfaces reflect, for `View3D.environment`. */
  public readonly environment: CubeTexture;
  /** Follows the camera's position, so the bolts hang in the sky like the background does. */
  public readonly dome = new Container3D({ label: 'night-sky' });
  public readonly bolts: readonly Mesh3D[];
  /** Where each bolt flares the lens, in the dome's frame. */
  public readonly boltCores: readonly Float32Array[];

  private readonly _boltMaterial: FlatMaterial;

  /** @param shapes - The bolts, in the order {@link NightSky.showBolt} picks them by. */
  constructor(shapes: readonly BoltShape[]) {
    [this.background, this.struck] = paintCubes(SKY_FACE, 2, 'night-sky', shadeSky, prepareClouds);
    [this.environment] = paintCubes(ENV_FACE, 1, 'night-env', shadeEnvironment);

    const material = skipToneCurve(new FlatMaterial({ alphaMode: 'blend', fog: false, doubleSided: true }));

    material.state.blendMode = 'add';
    material.vertexColors = true;
    this._boltMaterial = material;
    this.boltCores = shapes.map(() => new Float32Array(3));
    this.bolts = shapes.map((shape, i) => {
      const mesh = new Mesh3D({
        geometry: createBoltGeometry(shape, this.boltCores[i]),
        material,
        castShadow: false,
        receiveShadow: false,
      });

      mesh.visible = false;
      this.dome.addChild(mesh);

      return mesh;
    });
  }

  /**
   * Light one bolt and hide the rest.
   * @param index - Which bolt, or -1 for none.
   * @param amount - Brightness, 0 to 1.
   */
  public showBolt(index: number, amount: number): void {
    const bolts = this.bolts;

    for (let i = 0; i < bolts.length; i++) bolts[i].visible = i === index && amount > 0.004;

    this._boltMaterial.alpha = Math.min(1, amount);
  }

  public destroy(): void {
    for (const bolt of this.bolts) bolt.geometry.destroy();

    this.dome.destroy({ children: true });
    this._boltMaterial.destroy();
    this.background.destroy(true);
    this.struck.destroy(true);
    this.environment.destroy(true);
  }
}
