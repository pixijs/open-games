import { Container, Graphics, Text } from "pixi.js";
import type { PadStyle } from "./Controls.js";

/**
 * Gamepad button glyphs for the HUD's hints, drawn (not baked): the same ink outline and
 * cream caps as the key caps, in the pad's own labels and colours (Xbox, PlayStation,
 * Nintendo). Buttons are named by where they sit, as on an Xbox pad: "a" is the bottom
 * face button, which a PlayStation pad calls ✕ and a Nintendo one B.
 */
export type PadButton = "a" | "b" | "x" | "y" | "lb" | "rb" | "lt" | "rt" | "ls" | "rs" | "l3" | "r3" | "dpad" | "dlr" | "dud" | "dup" | "view" | "menu";

const INK = 0x2b2340;
const CREAM = 0xfff6ec;
const LIP = 0xa79fc0;
const DARK = 0x3b3352;
const DARK_LIP = 0x221c33;
const SUN = 0xffd23f;
const FONT = "'Barlow Semi Condensed', 'Arial Narrow', system-ui, sans-serif";

type Face = "a" | "b" | "x" | "y";
/** Face buttons: label and colour per style (PlayStation draws shapes instead of letters). */
const FACES: Record<PadStyle, Record<Face, { label: string; color: number }>> = {
  xbox: { a: { label: "A", color: 0x5fc94a }, b: { label: "B", color: 0xff5a4f }, x: { label: "X", color: 0x3d8cff }, y: { label: "Y", color: 0xffc928 } },
  ps: { a: { label: "✕", color: 0x8fb8ff }, b: { label: "○", color: 0xff7070 }, x: { label: "□", color: 0xff9ad5 }, y: { label: "△", color: 0x6fe3b4 } },
  nintendo: { a: { label: "B", color: 0xffffff }, b: { label: "A", color: 0xffffff }, x: { label: "Y", color: 0xffffff }, y: { label: "X", color: 0xffffff } },
};
const SHOULDERS: Record<PadStyle, Record<"lb" | "rb" | "lt" | "rt", string>> = {
  xbox: { lb: "LB", rb: "RB", lt: "LT", rt: "RT" },
  ps: { lb: "L1", rb: "R1", lt: "L2", rt: "R2" },
  nintendo: { lb: "L", rb: "R", lt: "ZL", rt: "ZR" },
};

let style: PadStyle = "xbox";
/** The style glyphs are drawn in from now on (lines already drawn keep theirs until rebuilt). */
export function setPadGlyphStyle(s: PadStyle) { style = s; }
export function padGlyphStyle(): PadStyle { return style; }

/** What a button says, as plain text (the menu's HTML hints). */
export function padLabel(b: PadButton, s: PadStyle = style): string {
  if (b === "a" || b === "b" || b === "x" || b === "y") return FACES[s][b].label;
  if (b === "lb" || b === "rb" || b === "lt" || b === "rt") return SHOULDERS[s][b];
  if (b === "view") return s === "nintendo" ? "−" : s === "ps" ? "SHARE" : "VIEW";
  if (b === "menu") return s === "nintendo" ? "+" : s === "ps" ? "OPTIONS" : "MENU";
  return { ls: "L", rs: "R", l3: "L3", r3: "R3", dpad: "✚", dlr: "◀▶", dud: "▲▼", dup: "▲" }[b];
}

/** A face button's colour (the menu's HTML hints). */
export function padColor(b: PadButton, s: PadStyle = style): string | null {
  if (b !== "a" && b !== "b" && b !== "x" && b !== "y") return null;
  return `#${FACES[s][b].color.toString(16).padStart(6, "0")}`;
}

function label(text: string, size: number, fill: number, outline = 0) {
  const t = new Text({
    text,
    style: { fontFamily: FONT, fontWeight: "800", fontSize: Math.round(size), fill, ...(outline ? { stroke: { color: INK, width: Math.max(2, size / 6), join: "round" as const } } : {}) },
  });
  t.anchor.set(0.5);
  return t;
}

/** A cap raised over a lip (the lip shows below it), both ink-outlined: like the key caps. */
function cap(g: Graphics, shape: (g: Graphics, dy: number) => void, top: number, lip: number, line: number) {
  shape(g, line * 0.9);
  g.fill(lip).stroke({ width: line, color: INK, join: "round" });
  shape(g, 0);
  g.fill(top).stroke({ width: line * 0.55, color: INK, join: "round" });
}

/** A glyph about `size` px tall, centred on its position. */
export function padGlyph(b: PadButton, size: number): Container {
  const c = new Container();
  const g = new Graphics();
  c.addChild(g);
  const line = Math.max(2, size * 0.09);
  const lift = line * 0.45;

  if (b === "a" || b === "b" || b === "x" || b === "y") {
    const r = size * 0.46;
    const f = FACES[style][b];
    const filled = style === "xbox";
    cap(g, (g, dy) => g.circle(0, dy, r), filled ? f.color : DARK, filled ? shade(f.color) : DARK_LIP, line);
    if (style === "ps") {
      const s = r * 0.42, w = Math.max(2, size * 0.1);
      const st = { width: w, color: f.color, cap: "round" as const, join: "round" as const };
      if (b === "a") g.moveTo(-s, -s - lift).lineTo(s, s - lift).moveTo(s, -s - lift).lineTo(-s, s - lift).stroke(st);
      else if (b === "b") g.circle(0, -lift, s * 1.05).stroke(st);
      else if (b === "x") g.rect(-s * 0.9, -s * 0.9 - lift, s * 1.8, s * 1.8).stroke(st);
      else g.poly([0, -s * 1.15 - lift, s * 1.05, s * 0.75 - lift, -s * 1.05, s * 0.75 - lift]).stroke(st);
    } else {
      const t = label(f.label, size * 0.62, 0xffffff, filled ? 1 : 0);
      t.y = -lift;
      c.addChild(t);
    }
    return c;
  }

  if (b === "lb" || b === "rb") {
    const text = SHOULDERS[style][b];
    const w = size * (text.length > 1 ? 1.45 : 1.05), h = size * 0.66;
    cap(g, (g, dy) => g.roundRect(-w / 2, -h / 2 + dy, w, h, h * 0.45), CREAM, LIP, line);
    const t = label(text, size * 0.44, INK);
    t.y = -lift;
    c.addChild(t);
    return c;
  }

  if (b === "lt" || b === "rt") {
    // a tall tab with a rounded top, like the trigger seen from behind
    const text = SHOULDERS[style][b];
    const w = size * 1.08, h = size * 0.92, r = w * 0.42, r2 = size * 0.12;
    cap(g, (g, dy) => {
      const x0 = -w / 2, x1 = w / 2, y0 = -h / 2 + dy, y1 = h / 2 + dy;
      g.moveTo(x0, y1 - r2).lineTo(x0, y0 + r).quadraticCurveTo(x0, y0, x0 + r, y0).lineTo(x1 - r, y0).quadraticCurveTo(x1, y0, x1, y0 + r)
        .lineTo(x1, y1 - r2).quadraticCurveTo(x1, y1, x1 - r2, y1).lineTo(x0 + r2, y1).quadraticCurveTo(x0, y1, x0, y1 - r2).closePath();
    }, CREAM, LIP, line);
    const t = label(text, size * 0.44, INK);
    t.y = size * 0.06 - lift;
    c.addChild(t);
    return c;
  }

  if (b === "ls" || b === "rs" || b === "l3" || b === "r3") {
    const r = size * 0.48;
    cap(g, (g, dy) => g.circle(0, dy, r), CREAM, LIP, line);
    // the stick's dished top
    g.circle(0, -lift, r * 0.62).fill(0xe6ddf2).stroke({ width: line * 0.45, color: INK, alpha: 0.5 });
    const t = label(padLabel(b), size * (b.length > 2 || b.endsWith("3") ? 0.4 : 0.5), INK);
    t.y = -lift;
    c.addChild(t);
    return c;
  }

  if (b === "dpad" || b === "dlr" || b === "dud" || b === "dup") {
    const a = size * 0.19, l = size * 0.5;
    const plus = (dy: number) => [-a, -l + dy, a, -l + dy, a, -a + dy, l, -a + dy, l, a + dy, a, a + dy, a, l + dy, -a, l + dy, -a, a + dy, -l, a + dy, -l, -a + dy, -a, -a + dy];
    g.poly(plus(line * 0.9)).fill(LIP).stroke({ width: line, color: INK, join: "round" });
    g.poly(plus(0)).fill(CREAM);
    // the arms it means, lit up
    const arm = l - a - line * 0.3;
    if (b === "dlr") g.rect(-l + line * 0.3, -a, arm, a * 2).rect(a, -a, arm, a * 2).fill(SUN);
    if (b === "dud") g.rect(-a, -l + line * 0.3, a * 2, arm).rect(-a, a, a * 2, arm).fill(SUN);
    if (b === "dup") g.rect(-a, -l + line * 0.3, a * 2, arm).fill(SUN);
    g.poly(plus(0)).stroke({ width: line * 0.55, color: INK, join: "round" });
    return c;
  }

  // view / menu: a small pill with the button's mark
  if (style === "nintendo") {
    const r = size * 0.36;
    cap(g, (g, dy) => g.circle(0, dy, r), DARK, DARK_LIP, line);
    const t = label(padLabel(b), size * 0.55, 0xffffff);
    t.y = -lift - size * 0.03;
    c.addChild(t);
    return c;
  }
  if (style === "ps" && b === "view") {
    const t = label(padLabel(b), size * 0.36, INK);
    const w = t.width + size * 0.5, h = size * 0.62;
    cap(g, (g, dy) => g.roundRect(-w / 2, -h / 2 + dy, w, h, h / 2), CREAM, LIP, line);
    t.y = -lift;
    c.addChild(t);
    return c;
  }
  const w = size * 0.95, h = size * 0.66;
  cap(g, (g, dy) => g.roundRect(-w / 2, -h / 2 + dy, w, h, h / 2), CREAM, LIP, line);
  const st = { width: Math.max(1.5, size * 0.065), color: INK, cap: "round" as const };
  const k = size * 0.13;
  if (b === "menu") {
    for (const dy of [-k, 0, k]) g.moveTo(-k * 1.4, dy - lift).lineTo(k * 1.4, dy - lift);
    g.stroke(st);
  } else {
    // two overlapping windows
    g.rect(-k * 1.5, -k * 1.2 - lift, k * 1.9, k * 1.5).stroke(st);
    g.rect(-k * 0.4, -k * 0.3 - lift, k * 1.9, k * 1.5).fill(CREAM).stroke(st);
  }
  return c;
}

/** A darker shade of a colour (a face button's lip). */
function shade(c: number) {
  return (Math.round(((c >> 16) & 255) * 0.62) << 16) | (Math.round(((c >> 8) & 255) * 0.62) << 8) | Math.round((c & 255) * 0.62);
}
