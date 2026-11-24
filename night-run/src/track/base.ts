/**
 * Night Run's curated venue, moved here verbatim from where each part was built: the hand-placed road and scenery
 * (once `Track.ts`), the floodlight towers (`look/set/Floodlights.ts`), the light tunnel (`look/set/Neon.ts`), the TV
 * cranes (`CameraRig.ts`), the ground (`main.ts`) and the bots' racing line (`race/BotDriver.ts`). Custom tracks get
 * theirs from rules; Night Run keeps these, so it looks and races exactly as it shipped.
 */

import type { Orient, PieceKey, Placement, SceneryKey, TowerSpec } from './plan';

type Row<K> = readonly [number, number, K, Orient];

const toPlacement = <K extends PieceKey | SceneryKey>([gx, gz, key, orient]: Row<K>): Placement => ({
  gx,
  gz,
  key,
  orient,
});

/**
 * The road, piece by piece. Pieces derived from the route make the same walls but for two that differ by 1e-16, so
 * Night Run keeps its own list and its bots race exactly as they always have.
 */
const PIECES: readonly Row<PieceKey>[] = [
  [-3, -3, 'track-corner', 16],
  [-2, -3, 'track-straight', 22],
  [-1, -3, 'track-straight', 22],
  [0, -3, 'track-corner', 0],
  [-3, -2, 'track-straight', 0],
  [0, -2, 'track-straight', 0],
  [-3, -1, 'track-corner', 10],
  [-2, -1, 'track-corner', 0],
  [0, -1, 'track-straight', 0],
  [-2, 0, 'track-straight', 10],
  [0, 0, 'track-finish', 0],
  [-2, 1, 'track-straight', 10],
  [0, 1, 'track-straight', 0],
  [-2, 2, 'track-corner', 10],
  [-1, 2, 'track-straight', 16],
  [0, 2, 'track-corner', 22],
];

/** The hand-placed tents and the forest ringing the circuit. */
const DECO: readonly Row<SceneryKey>[] = [
  [-4, -2, 'decoration-tents', 10],
  [-1, -4, 'decoration-tents', 22],
  [-1, 1, 'decoration-tents', 22],
  [-8, -9, 'decoration-forest', 0],
  [-7, -9, 'decoration-forest', 0],
  [-6, -9, 'decoration-forest', 0],
  [-5, -9, 'decoration-forest', 0],
  [-4, -9, 'decoration-forest', 0],
  [-3, -9, 'decoration-forest', 0],
  [-2, -9, 'decoration-forest', 0],
  [-1, -9, 'decoration-forest', 0],
  [0, -9, 'decoration-forest', 0],
  [1, -9, 'decoration-forest', 0],
  [2, -9, 'decoration-forest', 0],
  [-8, -8, 'decoration-forest', 0],
  [-7, -8, 'decoration-forest', 0],
  [-6, -8, 'decoration-forest', 0],
  [-5, -8, 'decoration-forest', 0],
  [-4, -8, 'decoration-forest', 0],
  [-3, -8, 'decoration-forest', 0],
  [-2, -8, 'decoration-forest', 0],
  [-1, -8, 'decoration-forest', 0],
  [0, -8, 'decoration-forest', 0],
  [1, -8, 'decoration-forest', 0],
  [2, -8, 'decoration-forest', 0],
  [-8, -7, 'decoration-forest', 0],
  [-7, -7, 'decoration-forest', 0],
  [-6, -7, 'decoration-forest', 0],
  [-5, -7, 'decoration-forest', 0],
  [-4, -7, 'decoration-forest', 0],
  [-3, -7, 'decoration-forest', 0],
  [-2, -7, 'decoration-forest', 0],
  [-1, -7, 'decoration-forest', 0],
  [0, -7, 'decoration-forest', 0],
  [1, -7, 'decoration-forest', 0],
  [2, -7, 'decoration-forest', 0],
  [-8, -6, 'decoration-forest', 0],
  [-7, -6, 'decoration-forest', 0],
  [-6, -6, 'decoration-forest', 0],
  [-5, -6, 'decoration-forest', 0],
  [-4, -6, 'decoration-forest', 0],
  [-3, -6, 'decoration-empty', 0],
  [-2, -6, 'decoration-empty', 0],
  [-1, -6, 'decoration-empty', 0],
  [0, -6, 'decoration-empty', 0],
  [1, -6, 'decoration-forest', 0],
  [2, -6, 'decoration-forest', 0],
  [-8, -5, 'decoration-forest', 0],
  [-7, -5, 'decoration-forest', 0],
  [-6, -5, 'decoration-forest', 0],
  [-5, -5, 'decoration-forest', 0],
  [-4, -5, 'decoration-empty', 0],
  [-3, -5, 'decoration-empty', 0],
  [-2, -5, 'decoration-empty', 0],
  [-1, -5, 'decoration-empty', 0],
  [0, -5, 'decoration-empty', 0],
  [1, -5, 'decoration-forest', 0],
  [2, -5, 'decoration-forest', 0],
  [-8, -4, 'decoration-forest', 0],
  [-7, -4, 'decoration-forest', 0],
  [-6, -4, 'decoration-forest', 0],
  [-5, -4, 'decoration-forest', 0],
  [-4, -4, 'decoration-empty', 0],
  [1, -4, 'decoration-forest', 0],
  [2, -4, 'decoration-forest', 0],
  [-8, -3, 'decoration-forest', 0],
  [-7, -3, 'decoration-forest', 0],
  [-6, -3, 'decoration-forest', 0],
  [-5, -3, 'decoration-forest', 0],
  [-4, -3, 'decoration-empty', 0],
  [1, -3, 'decoration-forest', 0],
  [2, -3, 'decoration-forest', 0],
  [-8, -2, 'decoration-forest', 0],
  [-7, -2, 'decoration-forest', 0],
  [-6, -2, 'decoration-forest', 0],
  [-5, -2, 'decoration-forest', 0],
  [1, -2, 'decoration-forest', 0],
  [2, -2, 'decoration-forest', 0],
  [-8, -1, 'decoration-forest', 0],
  [-7, -1, 'decoration-forest', 0],
  [-6, -1, 'decoration-forest', 0],
  [-5, -1, 'decoration-forest', 0],
  [-4, -1, 'decoration-empty', 0],
  [-1, -1, 'decoration-empty', 0],
  [1, -1, 'decoration-forest', 0],
  [2, -1, 'decoration-forest', 0],
  [-8, 0, 'decoration-forest', 0],
  [-7, 0, 'decoration-forest', 0],
  [-6, 0, 'decoration-forest', 0],
  [-5, 0, 'decoration-forest', 0],
  [-4, 0, 'decoration-empty', 0],
  [-3, 0, 'decoration-empty', 0],
  [-1, 0, 'decoration-empty', 0],
  [1, 0, 'decoration-forest', 0],
  [2, 0, 'decoration-forest', 0],
  [-8, 1, 'decoration-forest', 0],
  [-7, 1, 'decoration-forest', 0],
  [-6, 1, 'decoration-forest', 0],
  [-5, 1, 'decoration-forest', 0],
  [-4, 1, 'decoration-empty', 0],
  [-3, 1, 'decoration-empty', 0],
  [1, 1, 'decoration-forest', 0],
  [2, 1, 'decoration-forest', 0],
  [-8, 2, 'decoration-forest', 0],
  [-7, 2, 'decoration-forest', 0],
  [-6, 2, 'decoration-forest', 0],
  [-5, 2, 'decoration-forest', 0],
  [-4, 2, 'decoration-empty', 0],
  [-3, 2, 'decoration-empty', 0],
  [1, 2, 'decoration-forest', 0],
  [2, 2, 'decoration-forest', 0],
  [-8, 3, 'decoration-forest', 0],
  [-7, 3, 'decoration-forest', 0],
  [-6, 3, 'decoration-forest', 0],
  [-5, 3, 'decoration-forest', 0],
  [-4, 3, 'decoration-forest', 0],
  [-3, 3, 'decoration-forest', 0],
  [-2, 3, 'decoration-forest', 0],
  [-1, 3, 'decoration-forest', 0],
  [0, 3, 'decoration-forest', 0],
  [1, 3, 'decoration-forest', 0],
  [2, 3, 'decoration-forest', 0],
  [-8, 4, 'decoration-forest', 0],
  [-7, 4, 'decoration-forest', 0],
  [-6, 4, 'decoration-forest', 0],
  [-5, 4, 'decoration-forest', 0],
  [-4, 4, 'decoration-forest', 0],
  [-3, 4, 'decoration-forest', 0],
  [-2, 4, 'decoration-forest', 0],
  [-1, 4, 'decoration-forest', 0],
  [0, 4, 'decoration-forest', 0],
  [1, 4, 'decoration-forest', 0],
  [2, 4, 'decoration-forest', 0],
];

/** Hand-placed road pieces. */
export const BASE_PIECES: readonly Placement[] = PIECES.map(toPlacement);

/** Orient codes by quarter turns, 0 to 3. */
const QUARTER_ORIENTS: readonly Orient[] = [0, 16, 10, 22];

/**
 * Every hand-placed decoration, then the fill: a band three cells deep round the road's and decorations' bounding
 * box, tents or a few trees right next to it and forest further out, each cell's choice from a hash of where it is.
 */
function scenery(): Placement[] {
  const placed = DECO.map(toPlacement);
  const occupied = new Set<string>();
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const [gx, gz] of [...PIECES, ...DECO]) {
    occupied.add(`${gx},${gz}`);
    if (gx < minX) minX = gx;
    if (gx > maxX) maxX = gx;
    if (gz < minZ) minZ = gz;
    if (gz > maxZ) maxZ = gz;
  }

  const pad = 3;

  for (let gz = minZ - pad; gz <= maxZ + pad; gz++) {
    for (let gx = minX - pad; gx <= maxX + pad; gx++) {
      if (occupied.has(`${gx},${gz}`)) continue;

      const distX = gx < minX ? minX - gx : gx > maxX ? gx - maxX : 0;
      const distZ = gz < minZ ? minZ - gz : gz > maxZ ? gz - maxZ : 0;
      const dist = Math.max(distX, distZ);

      let key: SceneryKey = 'decoration-forest';
      let yawQuarters = 0;

      if (dist <= 1) {
        const h = pseudoHash(gx, gz);

        if (h % 7 === 0) {
          key = 'decoration-tents';
          yawQuarters = h % 4;
        } else {
          key = 'decoration-empty';
        }
      }

      placed.push({ gx, gz, key, orient: QUARTER_ORIENTS[yawQuarters] });
    }
  }

  return placed;
}

function pseudoHash(gx: number, gz: number): number {
  let h = gx * 374761393 + gz * 668265263;

  h = (h ^ (h >> 13)) * 1274126177;

  return (h ^ (h >> 16)) >>> 0;
}

/** Every decoration, hand-placed first, in the order they're built. */
export const BASE_SCENERY: readonly Placement[] = scenery();

/**
 * The floodlight towers, each at least 3.75 units outside the barriers: past the finish arch on the home straight,
 * outside turn one, beside the kicker, outside the chicane, outside turn five and outside the last corner.
 */
export const BASE_TOWERS: readonly TowerSpec[] = [
  // Far out beside the arch, so its lamps stay clear of the logos on top of it from both ends of the straight.
  { s: 2, lateral: -15, height: 9.5, aimS: 1, aimLateral: 0, power: 0.8, kind: 'mast' },
  { s: 14.2, lateral: -7.5, height: 10, aimS: 14.2, aimLateral: -0.5, power: 1, kind: 'mast' },
  { s: 33, lateral: -7.5, height: 9.5, aimS: 36.5, aimLateral: 0, power: 1, kind: 'mast' },
  { s: 54.31, lateral: -7.5, height: 10, aimS: 52.5, aimLateral: 0, power: 1, kind: 'mast' },
  { s: 67.7, lateral: -7.5, height: 10, aimS: 69, aimLateral: 0, power: 1, kind: 'mast' },
  { s: 88.5, lateral: -7.5, height: 9.5, aimS: 88.5, aimLateral: -0.5, power: 1, kind: 'mast' },
];

/** The light tunnel over the bottom straight: portal gantries at these route distances. */
export const BASE_GANTRY_S: readonly number[] = [72.5, 75.5, 78.5, 81.5, 84.5];
/** The gantry whose tube is failing and flickers. */
export const BASE_FLICKER_GANTRY = 3;

/** TV crane positions around the circuit, mostly in the grassy infield where the trees don't block them. */
export const BASE_TV_SPOTS: readonly (readonly [number, number, number])[] = [
  [-3.8, 6.5, 14.5],
  [-3.8, 6.5, -1],
  [-4.5, 6.5, -13],
  [-17, 6, 6],
  [-27, 7, -6],
  [-9, 7, -27],
  [11, 8.5, -8],
  [11, 8.5, 15],
];

/** The grass: centred on the origin, a physics slab 50 either way and a plane 200 across. */
export const BASE_GROUND = { x: 0, z: 0, half: 50, plane: 200 } as const;

/** The attract race strings out back from this route distance, so its camera never opens on a parked grid. */
export const BASE_ATTRACT_START = 34;

/**
 * The racing line: where a bot aims across the road, as offsets to the right of the centreline at evenly spaced
 * points round the lap from the finish line. The truck runs well inside it, since it aims far ahead. Found by
 * searching a race simulator for the fastest lap that keeps off the walls, at top speeds from 0.8 to 1.15 of the
 * truck's.
 */
export const BASE_OFFSETS: readonly number[] = [
  -2.62, 0.19, -0.72, 0.05, 0.5, 2.32, -0.58, 2.85, -0.11, 2.84, 1.61, 1.66, 2.84, 1.97, 0.32, -0.8, -0.04, -0.94,
  -1.48, -2.48, -1.68, 2.85, 0.52, 1.89, 2.37, 2.85, 2.85, 2.83, 2.84, 2.77, -0.22, -2.83, -0.79, 0.18, 0.21, 2.76,
  2.69, 2.77, 0.3, 0.1, -0.97, -1.67, -0.45, 0.39,
];
