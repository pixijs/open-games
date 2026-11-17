import { Assets, BitmapFont, BitmapText, Container, Sprite, Text, TextStyle, Texture, type TextStyleOptions } from "pixi.js";
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

const bitmapFonts = new Set<string>();

/**
 * The name of a bitmap font that draws `style` for text whose words change often: changing a
 * BitmapText only lays its glyphs out again, where a Text draws and uploads a new texture.
 * Glyphs are drawn at `res` rounded up to a whole number, so they stay sharp and resizing the
 * window installs a handful of fonts, not one per size. `chars` are drawn up front; any other
 * glyph is added the first time it shows.
 */
export function bitmapFont(name: string, style: TextStyleOptions, res: number, chars: string | string[][]): string {
  const step = Math.max(1, Math.ceil(res - 0.01));
  const font = `${name}@${step}`;
  if (!bitmapFonts.has(font)) {
    BitmapFont.install({ name: font, style, chars, resolution: step });
    bitmapFonts.add(font);
  }
  return font;
}

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

/** Whether two parts take the same node: any two texts do, unless one is empty (it has none). */
function sameKind(a: Part, b: Part) {
  if (typeof a === "string" || typeof b === "string") return typeof a === typeof b && !a === !b;
  if ("icon" in a) return "icon" in b && a.icon === b.icon && a.size === b.size;
  if ("key" in a) return "key" in b && a.key === b.key;
  return "pad" in b && a.pad === b.pad;
}

/**
 * Text and icons laid out left to right on one midline. `set` rebuilds it only when its icons,
 * keys or buttons change; new words go into the texts it has, and only a text whose words
 * changed is drawn again.
 */
export class RichLine extends Container {
  private parts: Part[] = [];
  /** The pad style its buttons are drawn in (a new pad redraws them). */
  private padStyle = "";
  /** A node per part (none for an empty text), and how wide each icon, key or button is. */
  private nodes: (Container | null)[] = [];
  private widths: number[] = [];
  private textStyle: TextStyle;
  /**
   * Midline height: icons are this tall, text is centred on it. `font`: a {@link bitmapFont}
   * made from `style`, to draw the words as BitmapText.
   */
  constructor(style: TextStyleOptions, private size = 28, private gap = 6, private font?: string) {
    super();
    this.textStyle = new TextStyle(font ? { fontFamily: font, fontSize: style.fontSize } : style);
  }

  set(parts: Part[]) {
    const pad = padGlyphStyle();
    if (pad === this.padStyle && parts.length === this.parts.length && parts.every((p, i) => sameKind(p, this.parts[i]))) {
      let changed = false;
      parts.forEach((p, i) => {
        if (typeof p !== "string" || p === this.parts[i]) return;
        (this.nodes[i] as Text | BitmapText).text = p;
        changed = true;
      });
      if (!changed) return;
    } else {
      this.padStyle = pad;
      this.removeChildren().forEach((c) => c.destroy(FREE));
      this.widths = [];
      this.nodes = parts.map((part, i) => this.build(part, i));
    }
    this.parts = parts.slice();
    let x = 0;
    this.parts.forEach((part, i) => {
      const node = this.nodes[i];
      if (!node) return;
      if (typeof part === "string") {
        node.position.set(x, 0);
        // the ink outline reaches past the measured glyphs: keep it off the next icon
        x += node.width + 3 + this.gap;
      } else {
        node.position.set(x + this.widths[i] / 2, 0);
        x += this.widths[i] + this.gap;
      }
    });
    this.lineWidth = Math.max(0, x - this.gap);
  }

  private build(part: Part, i: number): Container | null {
    let node: Container;
    if (typeof part === "string") {
      if (!part) return null;
      const t = this.font ? new BitmapText({ text: part, style: this.textStyle }) : new Text({ text: part, style: this.textStyle });
      t.anchor.set(0, 0.5);
      node = t;
    } else if ("icon" in part) {
      node = iconSprite(part.icon, part.size ?? this.size);
      this.widths[i] = node.width;
    } else if ("pad" in part) {
      node = padGlyph(part.pad, this.size * 1.05);
      this.widths[i] = node.width;
    } else {
      node = keySprite(part.key, this.size * 1.25);
      this.widths[i] = node.width * 0.86;
    }
    return this.addChild(node);
  }

  /** Laid-out width (px). */
  lineWidth = 0;
}
