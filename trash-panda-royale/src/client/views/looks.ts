/**
 * What a character looks like, derived from the 32-bit `look` the server hands out:
 * raccoons for players (an outfit, or a random seed), people (with a job) for the townsfolk. Colours go to the model's
 * recolourable materials; accessories are node names switched on in the model.
 */
import * as outfit from "../../shared/outfit.js";

export type Species = "raccoon" | "human";
export type Role = "jogger" | "office" | "chef" | "granny" | "kid" | "pest" | "tourist" | "binman";

export interface Look {
  species: Species;
  seed: number;
  /** glTF material name → colour. */
  colors: Record<string, number>;
  /** Accessory nodes to show (every other `acc_*` / `hair_*` node is hidden). */
  accessories: string[];
  role: Role | null;
  /** Shirt pattern cell (people): 0 plain, 1 stripes, 2 dots, 3 hawaiian. */
  pattern: number;
  /** Uniform scale of the whole character (kids are small). */
  scale: number;
}

const INK = 0x2b2340;

/** Blend two colours (t = 0 → a, 1 → b). */
export function mix(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round((((a >> s) & 255) * (1 - t)) + (((b >> s) & 255) * t));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s % n;
  };
}

// ---------------------------------------------------------------- raccoons
// (from a seed; players wear outfits, which have their own option lists)
/** Fur: mostly natural raccoon greys and browns, now and then a dyed one. */
const FURS = [0x9a96a3, 0x8d8a96, 0xa69888, 0x8f7f72, 0xb08a68, 0x6f6875, 0xc9bfb0];
const DYED = [0xff9ec7, 0x8fe3c8, 0xb9a6ff, 0x8cc8ff, 0xffc36b];
const BELLIES = [0xf3ead8, 0xfff7ec, 0xe9dcc2, 0xf6efe6];
const ACC_COLORS = [0xff5d8f, 0xffd23f, 0x3ec1ff, 0x7cff6b, 0xb084ff, 0xff9f43, 0xffffff, 0x2b2340];
/** One head accessory (or none); a loot sack on some backs. */
const HATS = ["", "acc_bandana", "acc_beanie", "acc_cap", "acc_pirate", "acc_tophat"];

/**
 * A raccoon: the outfit picked on the start screen (see `shared/outfit.ts`), or, for any
 * other look (the dev gallery's and the shader warm-up's seeds), a random one from the seed.
 */
export function raccoonLook(seed: number): Look {
  if (outfit.isOutfit(seed)) return outfitLook(seed);
  const r = rng(seed);
  const fur = r(10) === 0 ? DYED[r(DYED.length)] : FURS[r(FURS.length)];
  const hat = HATS[r(HATS.length)];
  const accessories = hat ? [hat] : [];
  if (r(3) === 0) accessories.push("acc_sack");
  const belly = BELLIES[r(BELLIES.length)];
  return {
    species: "raccoon", seed, role: null, pattern: 0, scale: 1,
    // the face patch (mask, eyes, muzzle) is drawn on white and takes the belly's cream
    colors: { Fur: fur, FurDark: mix(fur, INK, 0.55), Belly: belly, Face: belly, Acc: ACC_COLORS[r(ACC_COLORS.length)] },
    accessories,
  };
}

function outfitLook(look: number): Look {
  const o = outfit.unpackOutfit(look);
  const fur = outfit.FURS[o.fur].color, belly = outfit.BELLIES[o.belly].color;
  return {
    species: "raccoon", seed: look, role: null, pattern: 0, scale: 1,
    colors: { Fur: fur, FurDark: mix(fur, INK, 0.55), Belly: belly, Face: belly, Acc: outfit.ACC_COLORS[o.acc].color },
    accessories: outfit.wornNodes(o),
  };
}

// ---------------------------------------------------------------- people
const SKINS = [0xffd9b8, 0xf1c08f, 0xd99a6c, 0xa86b45, 0x7a4a2c, 0xffe3cf];
const HAIRS = [0x3b2416, 0x6b4226, 0xd9a441, 0x1e1e1e, 0xb5523b, 0xf2e6d8];
const NEONS = [0x7cff6b, 0xff5d8f, 0x3ec1ff, 0xffd23f];
const PANTS = [0x3d5a80, 0x2b2d42, 0x6d597a, 0x8d6e63, 0x4a7c59, 0x264653];
const ROLES: [Role, number][] = [["jogger", 2], ["office", 3], ["chef", 1], ["granny", 2], ["kid", 2], ["pest", 1], ["tourist", 1]];

export function humanLook(seed: number, role?: Role): Look {
  const r = rng(seed);
  if (!role) {
    let k = r(ROLES.reduce((s, [, w]) => s + w, 0));
    role = ROLES[0][0];
    for (const [name, w] of ROLES) { if (k < w) { role = name; break; } k -= w; }
  }
  const hair = `hair_${r(3)}`;
  const skin = SKINS[r(SKINS.length)];
  const colors: Record<string, number> = {
    // the face patch (drawn on white, expressions swapped by UV) and the rest of the skin
    Face: skin, Skin: skin, Hair: HAIRS[r(HAIRS.length)], Shoes: [0xffffff, 0x2b2340, 0xff5d8f][r(3)],
    Shirt: 0xffffff, Pants: PANTS[r(PANTS.length)],
  };
  let accessories: string[] = [hair];
  let pattern = 0, scale = 1;
  switch (role) {
    case "jogger":
      colors.Shirt = NEONS[r(NEONS.length)];
      pattern = 1;
      accessories.push("acc_sweatband");
      break;
    case "office":
      colors.Shirt = [0xffffff, 0xdbe8ff, 0xfff3d6][r(3)];
      colors.Pants = 0x2b2d42;
      accessories.push("acc_tie", "acc_briefcase");
      if (r(2)) accessories.push("acc_glasses");
      break;
    case "chef":
      colors.Shirt = 0xffffff;
      colors.Pants = 0x2b2d42;
      accessories = ["acc_chef_hat", "acc_apron", "acc_mustache"];
      scale = 1.05;
      break;
    case "granny":
      colors.Hair = [0xdcdce4, 0xf2f2f2, 0xc9c3d6][r(3)];
      colors.Shirt = [0xb084ff, 0xff9ec7, 0x8fd3c8][r(3)];
      accessories = ["hair_3", "acc_glasses", "acc_handbag"];
      scale = 0.9;
      break;
    case "kid":
      colors.Shirt = NEONS[r(NEONS.length)];
      pattern = 2;
      accessories = ["acc_cap", "acc_backpack"];
      if (r(2)) accessories.push("acc_balloon");
      scale = 0.72;
      break;
    case "pest":
      colors.Shirt = 0xff9f43;
      colors.Pants = 0xff9f43;
      accessories = ["acc_overalls", "acc_gasmask", "acc_tank", "acc_sprayer"];
      scale = 1.05;
      break;
    case "tourist":
      colors.Shirt = [0xff5d8f, 0x3ec1ff, 0xffd23f][r(3)];
      pattern = 3;
      accessories.push("acc_sunhat", "acc_camera");
      break;
    case "binman":
      // the garbage truck's driver: hi-vis overalls and a cap
      colors.Shirt = 0xc6ff3d;
      colors.Pants = 0x3fae5a;
      accessories = [hair, "acc_cap", "acc_overalls"];
      scale = 1.05;
      break;
  }
  return { species: "human", seed, colors, accessories, role, pattern, scale };
}
