/**
 * A player's outfit, picked on the start screen: fur, belly, something on the head, the
 * face, the neck and the back, and the colour of whatever takes one. It travels packed in
 * the 32-bit `look` that the server syncs: bit 31 marks an outfit (any other look is a
 * random seed, see the client's `raccoonLook`). Shared: the server checks and rolls
 * outfits, the menu lists the options, the client dresses the raccoon.
 */
export interface Swatch { id: string; label: string; color: number; rare?: boolean }
export interface Wear {
  id: string;
  label: string;
  /** The model's accessory node ("" for none). */
  node: string;
  /** Takes the accessory colour (`ACC_COLORS`). */
  tint: boolean;
}

/** Fur: natural raccoon greys and browns, and the rarer dyed ones. */
export const FURS: Swatch[] = [
  { id: "alley", label: "alley grey", color: 0x9a96a3 },
  { id: "storm", label: "storm", color: 0x8d8a96 },
  { id: "dusty", label: "dusty", color: 0xa69888 },
  { id: "mocha", label: "mocha", color: 0x8f7f72 },
  { id: "ginger", label: "ginger", color: 0xb08a68 },
  { id: "dusk", label: "dusk", color: 0x6f6875 },
  { id: "ash", label: "ash", color: 0xc9bfb0 },
  { id: "snow", label: "snow", color: 0xe9e6ef },
  { id: "soot", label: "soot", color: 0x4d4858 },
  { id: "bubblegum", label: "bubblegum", color: 0xff9ec7, rare: true },
  { id: "mint", label: "mint", color: 0x8fe3c8, rare: true },
  { id: "lilac", label: "lilac", color: 0xb9a6ff, rare: true },
  { id: "sky", label: "sky", color: 0x8cc8ff, rare: true },
  { id: "mango", label: "mango", color: 0xffc36b, rare: true },
  { id: "coral", label: "coral", color: 0xff8f7a, rare: true },
  { id: "lime", label: "lime", color: 0xc4ec7a, rare: true },
];

/** Belly, inner ears and the face patch (its mask stays dark whatever the colour). */
export const BELLIES: Swatch[] = [
  { id: "cream", label: "cream", color: 0xf3ead8 },
  { id: "milk", label: "milk", color: 0xfffaf2 },
  { id: "sand", label: "sand", color: 0xe6d3ae },
  { id: "peach", label: "peach", color: 0xffd6c4 },
  { id: "mist", label: "mist", color: 0xdcd9ea },
  { id: "latte", label: "latte", color: 0xd4b796 },
];

export const HEADS: Wear[] = [
  { id: "none", label: "none", node: "", tint: false },
  { id: "beanie", label: "beanie", node: "acc_beanie", tint: true },
  { id: "cap", label: "cap", node: "acc_cap", tint: true },
  { id: "pirate", label: "pirate hat", node: "acc_pirate", tint: false },
  { id: "tophat", label: "top hat", node: "acc_tophat", tint: true },
  { id: "headphones", label: "headphones", node: "acc_headphones", tint: true },
  // (its stripes take the colour)
  { id: "cone", label: "traffic cone", node: "acc_cone", tint: true },
];

export const FACES: Wear[] = [
  { id: "none", label: "none", node: "", tint: false },
  { id: "shades", label: "shades", node: "acc_shades", tint: true },
];

export const NECKS: Wear[] = [
  { id: "none", label: "none", node: "", tint: false },
  { id: "bandana", label: "bandana", node: "acc_bandana", tint: true },
  { id: "bowtie", label: "bow tie", node: "acc_bowtie", tint: true },
];

export const BACKS: Wear[] = [
  { id: "none", label: "none", node: "", tint: false },
  { id: "sack", label: "loot sack", node: "acc_sack", tint: true },
];

export const ACC_COLORS: Swatch[] = [
  { id: "pink", label: "pink", color: 0xff5d8f },
  { id: "sun", label: "sunshine", color: 0xffd23f },
  { id: "sky", label: "sky", color: 0x3ec1ff },
  { id: "lime", label: "lime", color: 0x7cff6b },
  { id: "grape", label: "grape", color: 0xb084ff },
  { id: "orange", label: "orange", color: 0xff9f43 },
  { id: "white", label: "white", color: 0xffffff },
  { id: "ink", label: "ink", color: 0x2b2340 },
];

/** Indices into the tables above. */
export interface Outfit { fur: number; belly: number; head: number; face: number; neck: number; back: number; acc: number }

const FLAG = 0x80000000;
/** Field, bits, options: from bit 0 up. */
const LAYOUT: [keyof Outfit, number, readonly unknown[]][] = [
  ["fur", 4, FURS], ["belly", 3, BELLIES], ["head", 3, HEADS], ["face", 2, FACES], ["neck", 2, NECKS], ["back", 1, BACKS], ["acc", 3, ACC_COLORS],
];
for (const [k, bits, list] of LAYOUT) if (list.length > 1 << bits) throw new Error(`outfit: too many ${k} options for ${bits} bits`);

/** Is this look an outfit (rather than a random seed)? */
export const isOutfit = (look: number) => (look & FLAG) !== 0;

export function packOutfit(o: Outfit): number {
  let v = 0, shift = 0;
  for (const [k, bits, list] of LAYOUT) {
    const i = o[k];
    v |= (Number.isInteger(i) && i >= 0 && i < list.length ? i : 0) << shift;
    shift += bits;
  }
  return (v | FLAG) >>> 0;
}

/** Fields out of range read as 0 (none, or the first colour). */
export function unpackOutfit(look: number): Outfit {
  const o = {} as Outfit;
  let shift = 0;
  for (const [k, bits, list] of LAYOUT) {
    const i = (look >>> shift) & ((1 << bits) - 1);
    o[k] = i < list.length ? i : 0;
    shift += bits;
  }
  return o;
}

const pick = <T>(list: readonly T[], rand: () => number) => Math.min(list.length - 1, Math.floor(rand() * list.length));

/** A random outfit, with the odds of the old random looks: dyed fur now and then, a sack on some backs. */
export function randomOutfit(rand: () => number): number {
  const common = FURS.filter((f) => !f.rare), rare = FURS.filter((f) => f.rare);
  const furs = rand() < 0.1 ? rare : common;
  const n = rand();
  return packOutfit({
    fur: FURS.indexOf(furs[pick(furs, rand)]),
    belly: pick(BELLIES, rand),
    head: pick(HEADS, rand),
    face: rand() < 1 / 6 ? 1 : 0,
    neck: n < 0.17 ? 1 : n < 0.29 ? 2 : 0,
    back: rand() < 1 / 3 ? 1 : 0,
    acc: pick(ACC_COLORS, rand),
  });
}

/** A look a client asked for: an outfit with every field in range, or else a random one. */
export function sanitizeOutfit(v: unknown, rand: () => number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffffffff || !isOutfit(v)) return randomOutfit(rand);
  return packOutfit(unpackOutfit(v));
}

/** What the outfit puts on (accessory node names). */
export function wornNodes(o: Outfit): string[] {
  return [HEADS[o.head].node, FACES[o.face].node, NECKS[o.neck].node, BACKS[o.back].node].filter(Boolean);
}

/** Does anything worn take the accessory colour? */
export function tintable(o: Outfit): boolean {
  return HEADS[o.head].tint || FACES[o.face].tint || NECKS[o.neck].tint || BACKS[o.back].tint;
}

/** Fallback names (no name given), with a number after them. */
export const NAMES = ["Trashley", "Binjamin", "Scraps", "Rascal", "Ringo", "Nibbles", "Bandit", "Crumbs", "Munch", "Pickles", "Mochi", "Waffles"];

export const randomName = (rand: () => number) => `${NAMES[pick(NAMES, rand)]}${Math.floor(rand() * 90 + 10)}`;
