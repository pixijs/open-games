import {
  ACC_COLORS, BACKS, BELLIES, FACES, FURS, HEADS, NECKS, packOutfit, tintable, unpackOutfit, type Outfit, type Swatch, type Wear,
} from "../shared/outfit.js";
import { OutfitThumbs } from "./outfitThumbs.js";

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

type ColorKey = "fur" | "belly" | "acc";
/** The colour pickers: what each sets, its name on the menu, and its colours. */
const COLORS: { key: ColorKey; label: string; what: string; list: Swatch[] }[] = [
  { key: "fur", label: "fur", what: "fur", list: FURS },
  { key: "belly", label: "belly", what: "belly", list: BELLIES },
  { key: "acc", label: "gear", what: "gear colour", list: ACC_COLORS },
];

/**
 * The start screen's outfit controls, built from the shared option tables.
 * - The colours fold into one line, under the rest: a picker each for the fur, the belly and
 *   the gear (the accessories), showing the colour you have. A click opens that picker's palette under the
 *   line; hovering or focusing a colour there tries it on (`onPreview`), a click picks it.
 *   Esc, a click elsewhere, or leaving the palette puts the outfit's colour back.
 * - Pictures of the hats and the extras (shades; a bandana or a bow tie; a sack), baked from
 *   the raccoon's own accessories and worn in the gear colour (a colour tried on in the gear
 *   palette shows on them too). One of each slot: a click puts it on, a second click takes
 *   it off. Over each row, what it is and what you wear.
 * Every change calls `onChange`.
 */
export class OutfitPicker {
  onChange: (look: number, surprise: boolean) => void = () => {};
  /** A look being tried on (a colour hovered or focused in an open palette), or null: back to the outfit. */
  onPreview: (look: number | null) => void = () => {};
  private outfit: Outfit;
  /** Each picture and what it puts on (for the pressed states). */
  private tiles: { el: HTMLButtonElement; canvas: HTMLCanvasElement; wear: Wear; on: (o: Outfit) => boolean }[] = [];
  /** What you wear, over the hat and the extras rows. */
  private worn = new Map<"hat" | "extras", HTMLElement>();
  private thumbs: OutfitThumbs | null = null;
  /** The gear colour the pictures are painted in (-1: not yet). */
  private painted = -1;
  private picks = new Map<ColorKey, { el: HTMLButtonElement; value: HTMLElement }>();
  private colours!: HTMLElement;
  private palette!: HTMLElement;
  private open: ColorKey | null = null;
  private previewing = false;

  constructor(root: HTMLElement, look: number) {
    this.outfit = unpackOutfit(look);
    // the colours last: an open palette takes the room under them, and nothing else moves
    root.append(this.row("hat", this.slot("head", HEADS)), this.row("extras", this.extras()), this.colourPickers());
    OutfitThumbs.load().then((t) => {
      this.thumbs = t;
      this.paint(this.outfit.acc);
    }, (e) => {
      // no pictures: their names, then
      console.warn("outfit pictures failed to load", e);
      for (const t of this.tiles) { t.canvas.remove(); t.el.textContent = t.wear.label; t.el.classList.add("named"); }
    });
    // a palette closes when you click anywhere else, or press Esc (that Esc closes nothing else)
    document.addEventListener("pointerdown", (e) => { if (this.open && !this.colours.contains(e.target as Node)) this.close(); });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.open) return;
      e.preventDefault();
      const key = this.open;
      this.close();
      this.picks.get(key)?.el.focus();
    });
    this.sync();
  }

  get look() { return packOutfit(this.outfit); }

  /** Wear another outfit (the dice), as if picked. */
  set(look: number, surprise = false) {
    this.outfit = unpackOutfit(look);
    this.close();
    this.sync();
    this.onChange(this.look, surprise);
  }

  private pick(change: (o: Outfit) => void) {
    change(this.outfit);
    this.sync();
    this.onChange(this.look, false);
  }

  private sync() {
    for (const t of this.tiles) {
      const on = t.on(this.outfit);
      t.el.setAttribute("aria-pressed", String(on));
      t.el.title = on ? `${t.wear.label} (click again to take it off)` : t.wear.label;
    }
    const o = this.outfit;
    this.worn.get("hat")!.textContent = o.head ? HEADS[o.head].label : "none";
    this.worn.get("extras")!.textContent = [FACES[o.face], NECKS[o.neck], BACKS[o.back]].filter((w) => w.node).map((w) => w.label).join(" · ") || "none";
    if (!this.previewing) this.paint(o.acc);
    for (const { key, list, what } of COLORS) {
      const p = this.picks.get(key)!;
      const s = list[this.outfit[key]];
      p.el.style.setProperty("--c", hex(s.color));
      p.value.textContent = s.label;
      p.el.setAttribute("aria-expanded", String(this.open === key));
      p.el.setAttribute("aria-label", `${what}: ${s.label}`);
    }
    // nothing worn takes a colour: the gear picker has nothing to do
    const gear = this.picks.get("acc")!.el, off = !tintable(this.outfit);
    gear.disabled = off;
    gear.title = off ? "nothing you wear takes a colour (the pirate hat has its own)" : "";
    if (off && this.open === "acc") this.close();
  }

  /** A row: what it is and what you wear (`worn`), over its pictures. */
  private row(label: "hat" | "extras", choices: HTMLElement) {
    const el = document.createElement("div");
    el.className = "opt";
    const head = document.createElement("div");
    head.className = "opt-head";
    const name = document.createElement("span");
    name.textContent = label;
    const worn = document.createElement("b");
    this.worn.set(label, worn);
    head.append(name, worn);
    choices.setAttribute("role", "group");
    choices.setAttribute("aria-label", label);
    el.append(head, choices);
    return el;
  }

  /** The pictures in a gear colour (an `ACC_COLORS` index), unless they wear it already. */
  private paint(acc: number) {
    if (!this.thumbs || acc === this.painted) return;
    this.painted = acc;
    for (const t of this.tiles) this.thumbs.paint(t.canvas, t.wear.node, ACC_COLORS[acc].color);
  }

  // ------------------------------------------------------------------ colours
  private colourPickers() {
    const box = document.createElement("div");
    box.className = "colours";
    const line = document.createElement("div");
    line.className = "picks";
    for (const { key, label } of COLORS) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "pick";
      el.setAttribute("aria-controls", "palette");
      // the colour, then what it's for over its name
      const dot = document.createElement("i");
      dot.className = "dot";
      const text = document.createElement("span");
      const name = document.createElement("b");
      name.textContent = label;
      const value = document.createElement("small");
      text.append(name, value);
      el.append(dot, text);
      // (detail 0: pressed with the keyboard)
      el.onclick = (e) => (this.open === key ? this.close() : this.show(key, e.detail === 0));
      this.picks.set(key, { el, value });
      line.append(el);
    }
    this.palette = document.createElement("div");
    this.palette.id = "palette";
    this.palette.className = "palette";
    this.palette.hidden = true;
    // trying colours on: leaving the palette (pointer or focus) puts the outfit's back
    this.palette.addEventListener("pointerleave", () => this.unpreview());
    this.palette.addEventListener("focusout", (e) => { if (!this.palette.contains(e.relatedTarget as Node)) this.unpreview(); });
    box.append(line, this.palette);
    this.colours = box;
    return box;
  }

  /**
   * Open one picker's palette, in two lines at most (the furs: the natural ones, a gap, the
   * dyed ones); from the keyboard, focus moves into it.
   */
  private show(key: ColorKey, byKey = false) {
    const { list, what } = COLORS.find((c) => c.key === key)!;
    this.unpreview();
    this.open = key;
    const groups: number[][] = key === "fur"
      ? [list.flatMap((s, i) => (s.rare ? [] : [i])), list.flatMap((s, i) => (s.rare ? [i] : []))]
      : [list.map((_, i) => i)];
    const g = document.createElement("div");
    g.className = "group";
    this.palette.replaceChildren(g);
    groups.forEach((idx, n) => {
      if (n > 0) {
        const gap = document.createElement("i");
        gap.className = "sw-gap";
        g.append(gap);
      }
      for (const i of idx) {
        const s = list[i];
        const el = document.createElement("button");
        el.type = "button";
        el.className = "sw";
        el.style.setProperty("--c", hex(s.color));
        el.title = s.label;
        el.setAttribute("aria-label", `${what}: ${s.label}`);
        el.setAttribute("aria-pressed", String(this.outfit[key] === i));
        const tryOn = () => {
          this.previewing = true;
          if (key === "acc") this.paint(i);
          this.onPreview(packOutfit({ ...this.outfit, [key]: i }));
        };
        el.addEventListener("pointerenter", tryOn);
        el.addEventListener("focus", tryOn);
        el.onclick = () => {
          this.previewing = false;
          this.close();
          this.pick((o) => { o[key] = i; });
          this.picks.get(key)?.el.focus();
        };
        g.append(el);
      }
    });
    this.palette.setAttribute("aria-label", what);
    this.palette.hidden = false;
    this.sync();
    // (on a small phone it opens under PLAY!: the sheet scrolls just enough to show it)
    this.palette.scrollIntoView({ block: "nearest" });
    if (byKey) (this.palette.querySelector('[aria-pressed="true"]') as HTMLElement | null)?.focus();
  }

  /** Close the open palette, if any (also when the wardrobe closes). */
  close() {
    if (!this.open) return;
    this.unpreview();
    this.open = null;
    this.palette.hidden = true;
    this.palette.replaceChildren();
    this.sync();
  }

  private unpreview() {
    if (!this.previewing) return;
    this.previewing = false;
    this.paint(this.outfit.acc);
    this.onPreview(null);
  }

  // ------------------------------------------------------------------ pictures
  /** A picture of `wear`: a click puts it on (in `key`'s slot as number `i`), a second click takes it off. */
  private tile(key: "head" | "face" | "neck" | "back", list: Wear[], i: number) {
    const wear = list[i];
    const el = document.createElement("button");
    el.type = "button";
    el.className = "tile";
    el.setAttribute("aria-label", wear.label);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 192;
    el.append(canvas);
    el.onclick = () => this.pick((o) => { o[key] = o[key] === i ? 0 : i; });
    this.tiles.push({ el, canvas, wear, on: (o) => o[key] === i });
    return el;
  }

  /** The pictures of one slot (all but "none"). */
  private slot(key: "head" | "face" | "neck" | "back", list: Wear[]) {
    const box = document.createElement("div");
    box.className = "tiles";
    for (let i = 1; i < list.length; i++) box.append(this.tile(key, list, i));
    return box;
  }

  /** The extras: a slot each (the face, the neck, the back), a little room between them. */
  private extras() {
    const box = document.createElement("div");
    box.className = "tiles";
    ([["face", FACES], ["neck", NECKS], ["back", BACKS]] as const).forEach(([key, list], n) => {
      if (n > 0) {
        const gap = document.createElement("i");
        gap.className = "tiles-gap";
        box.append(gap);
      }
      box.append(...this.slot(key, list).children);
    });
    return box;
  }
}
