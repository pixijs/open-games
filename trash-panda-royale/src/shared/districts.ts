/**
 * What each district looks like: the colours its buildings, roofs, trees and pavements are
 * painted, and its colour on the minimap. Where each one is and what gets built in it:
 * `DISTRICTS` in layout.ts. Shared, because the town's generator paints the walls (`tint`); the
 * client paints the rest.
 */
import { inPoly } from "./geom.js";
import { DISTRICTS, type AreaKey } from "./layout.js";

export type { AreaKey } from "./layout.js";

export interface Look {
  name: string;
  /** Wall tints (multiplied into the models' white-ish brick, siding and stucco). */
  walls: number[];
  /** Pitched roofs (the houses' shingles). */
  shingles: number[];
  /** Flat roofs (tar). */
  tar: number;
  /** Tree and bush foliage (and the pines', where they aren't the usual green). */
  leaves: number[];
  pine?: number;
  /** The pavements: sidewalk, kerb, the plots under buildings and paved squares, the lawn. */
  sidewalk: number; curb: number; paving: number; lawn: number;
  /** On the minimap. */
  map: number;
}

export const LOOKS: Record<AreaKey, Look> = {
  // an autumn suburb: white and pastel clapboard, slate and green shingles, maples turning
  maple: {
    name: "Maple Close",
    walls: [0xfff7ea, 0xfdeec4, 0xdcefd2, 0xd3e6f7, 0xf7ddd0, 0xe9e2f5],
    shingles: [0x6f86a8, 0x5d8f6b, 0xb55a4c, 0x7a6f86],
    tar: 0x8c9bb5,
    leaves: [0xff8a3d, 0xe8503a, 0xffc23d, 0xe0702e],
    sidewalk: 0xe6e3dc, curb: 0xcdc8bf, paving: 0xe4ddd0, lawn: 0x8fd468,
    map: 0xf2b27a,
  },
  // brick and terracotta: warm reds and ochres, tiled roofs, brick sidewalks, cobbled streets
  oldtown: {
    name: "Old Town",
    walls: [0xe08a6c, 0xe8a674, 0xedc683, 0xd2766c, 0xf3dcb6, 0xc99a78],
    shingles: [0xc95b3c, 0xb8513a, 0xd8743f],
    tar: 0x9a7a66,
    leaves: [0x58b05e, 0x4c9f58],
    sidewalk: 0xdca586, curb: 0xc2b09c, paving: 0xe6c8a6, lawn: 0x92cf6a,
    map: 0xe7a58e,
  },
  // glass and concrete: cool greys and blues, slate roofs, pale concrete
  downtown: {
    name: "Downtown",
    walls: [0xc6d2df, 0xa9bbce, 0xe5eaf0, 0x93a9c1, 0xbac9d6, 0xd8dee6],
    shingles: [0x4d5462, 0x5b6372],
    tar: 0x6b7489,
    leaves: [0x7fcf8c, 0x6cc27e],
    sidewalk: 0xd8dce1, curb: 0xb5bbc3, paving: 0xcbd0d7, lawn: 0x96d470,
    map: 0xaec3db,
  },
  // bunting and flowers: candy colours round the fountain and down the shop row
  plaza: {
    name: "The Plaza",
    walls: [0xffa3bd, 0xffd66e, 0x8fdcc6, 0xffb784, 0xc2adff, 0xa6dcff],
    shingles: [0xe2675a, 0xf0904a],
    tar: 0x6fa3a8,
    leaves: [0x6ccb6a, 0x7fd36a],
    sidewalk: 0xf0dcc0, curb: 0xd2bea0, paving: 0xf3dfc2, lawn: 0x98d672,
    map: 0xf6d9a6,
  },
  // graffiti and neon: loud purples, teals and pinks, blossom trees, lilac pavements
  run: {
    name: "Raccoon Run",
    walls: [0xa58ae6, 0x5ec8c4, 0xf27fb1, 0x7f90e8, 0xbfe46c, 0xffbd5e],
    shingles: [0x5a4d72, 0x47557a],
    tar: 0x7a6a96,
    leaves: [0xd36fe3, 0xff86c8, 0xb884f2],
    pine: 0x4f9a86,
    sidewalk: 0xcdc4d8, curb: 0xaea5bd, paving: 0xd6cce0, lawn: 0x9ad672,
    map: 0xd2aeea,
  },
  // rust and gravel: brick, corrugated iron, dry grass, worn concrete
  mill: {
    name: "Millside",
    walls: [0xcc8158, 0xb8664b, 0xa3ae96, 0xd8ae66, 0xaaa39a, 0xc49a78],
    shingles: [0x8a4b33, 0x6b6f72, 0x7a5a3e],
    tar: 0x8a6a52,
    leaves: [0xa6b04a, 0x8fa648, 0xc2b04a],
    pine: 0x6f8a3c,
    sidewalk: 0xc7bdab, curb: 0xaaa08e, paving: 0xbcac92, lawn: 0xb5c47a,
    map: 0xcda882,
  },
};

/** The district at (x, z), or null out in the country past the town's edge. */
export function areaAt(x: number, z: number): AreaKey | null {
  for (const d of DISTRICTS) if (inPoly(d.poly, x, z)) return d.area;
  return null;
}

/** A district's look, or null out in the country. */
export function lookAt(x: number, z: number): Look | null {
  const a = areaAt(x, z);
  return a ? LOOKS[a] : null;
}

/** A pick from `list` that's always the same for the same spot (the client and the server agree). */
export function pickAt<T>(list: readonly T[], x: number, z: number, salt = 0): T {
  let h = (Math.round(x * 16) * 73856093) ^ (Math.round(z * 16) * 19349663) ^ (salt * 83492791);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  h ^= h >>> 15;
  return list[(h >>> 0) % list.length];
}
