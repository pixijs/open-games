import { Assets, Container, Sprite, Text, Texture, type TextStyleOptions } from "pixi.js";
import { padGlyph, padGlyphStyle, type PadButton } from "./padGlyphs.js";

/**
 * Icons baked in Blender from the game's own models (assets-src/blender/build_icons.py):
 * transparent 192×192 PNGs with an ink outline (keycap_wide is 384×128).
 */
export const ICON_NAMES = [
  "wpn_pistol", "wpn_smg", "wpn_shotgun", "wpn_grenade",
  "car_hatch", "car_taxi", "car_pest", "car_van", "train_loco", "loot_can", "star", "raccoon", "raccoon_dizzy", "ride",
  "paw", "heart", "skull", "tombstone", "cork", "cap", "junk", "signal", "boom", "keycap", "keycap_wide", "mouse", "speaker_off",
  "food", "coffee", "fumes", "crown", "eye", "bin",
  "gull", "manhole", "car_garbage", "dumpster_gold", "splat",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** Icon per weapon slot. */
export const WEAPON_ICONS: IconName[] = ["paw", "wpn_pistol", "wpn_smg", "wpn_shotgun", "wpn_grenade"];
/** Icon per car kind. */
export const CAR_ICONS: IconName[] = ["car_hatch", "car_taxi", "car_pest", "car_van", "car_garbage"];

const textures = new Map<string, Texture>();

export async function loadIcons(onProgress: (f: number) => void) {
  let done = 0;
  await Promise.all(ICON_NAMES.map(async (name) => {
    try {
      // mipmapped: the HUD draws these at 14-64 px
      const tex = await Assets.load<Texture>({
        src: `assets/icons/${name}.png`,
        data: { autoGenerateMipmaps: true, scaleMode: "linear", mipmapFilter: "linear" },
      });
      textures.set(name, tex);
    } catch (e) {
      console.warn(`icon ${name} failed to load`, e);
    }
    onProgress(++done / ICON_NAMES.length);
  }));
}

export function iconTexture(name: IconName): Texture {
  return textures.get(name) ?? Texture.EMPTY;
}

/** A sprite `px` tall (keeps the icon's aspect), centred on its position by default. */
export function iconSprite(name: IconName, px: number, anchor = 0.5): Sprite {
  const s = new Sprite(iconTexture(name));
  s.anchor.set(anchor);
  setIconSize(s, px);
  return s;
}

export function setIconSize(s: Sprite, px: number) {
  const t = s.texture;
  const k = px / (t.height || 1);
  s.width = (t.width || 1) * k;
  s.height = px;
}

// ---------------------------------------------------------------- rich lines
/** A part of a {@link RichLine}: text, an icon, a key cap with its label, or a gamepad button. */
export type Part = string | { icon: IconName; size?: number } | { key: string } | { pad: PadButton };

const INK = 0x2b2340;

/** Destroys a HUD subtree: a Graphics frees its drawing only when told `context`. */
export const FREE = { children: true, context: true } as const;

/** A key cap icon with its label drawn on the blank top. */
export function keySprite(label: string, px: number): Container {
  const wide = label.length > 2;
  const c = new Container();
  const cap = iconSprite(wide ? "keycap_wide" : "keycap", wide ? px * 0.82 : px);
  c.addChild(cap);
  // (the HUD's FONT; icons.ts can't import Hud.ts, which imports it)
  const t = new Text({
    text: label.toUpperCase(),
    style: { fontFamily: "'Barlow Semi Condensed', 'Arial Narrow', system-ui, sans-serif", fontWeight: "700", fontSize: Math.round(px * (wide ? 0.34 : 0.46)), fill: INK },
  });
  t.anchor.set(0.5);
  t.position.set(0, -px * 0.01);
  c.addChild(t);
  return c;
}

/**
 * Text and icons laid out left to right on one midline. Rebuilt only when its parts
 * change (`set`), so it costs nothing per frame.
 */
export class RichLine extends Container {
  private key = "";
  /** Midline height: icons are this tall, text is centred on it. */
  constructor(private style: TextStyleOptions, private size = 28, private gap = 6) {
    super();
  }

  set(parts: Part[]) {
    // (pad buttons are drawn in the pad's own style: a new pad redraws them)
    const key = JSON.stringify(parts) + padGlyphStyle();
    if (key === this.key) return;
    this.key = key;
    this.removeChildren().forEach((c) => c.destroy(FREE));
    let x = 0;
    for (const part of parts) {
      let node: Container;
      let w: number;
      if (typeof part === "string") {
        if (!part) continue;
        const t = new Text({ text: part, style: this.style });
        t.anchor.set(0, 0.5);
        node = t;
        // the ink outline reaches past the measured glyphs: keep it off the next icon
        w = t.width + 3;
        node.position.set(x, 0);
      } else if ("icon" in part) {
        const s = iconSprite(part.icon, part.size ?? this.size);
        node = s;
        w = s.width;
        node.position.set(x + w / 2, 0);
      } else if ("pad" in part) {
        node = padGlyph(part.pad, this.size * 1.05);
        w = node.width;
        node.position.set(x + w / 2, 0);
      } else {
        node = keySprite(part.key, this.size * 1.25);
        w = node.width * 0.86;
        node.position.set(x + w / 2, 0);
      }
      this.addChild(node);
      x += w + this.gap;
    }
    this.lineWidth = Math.max(0, x - this.gap);
  }

  /** Laid-out width (px). */
  lineWidth = 0;
}
