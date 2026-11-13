import { Container, Graphics, Sprite, Text, type TextStyleOptions } from "pixi.js";
import { AOI_IN, AOI_OUT, MAP_HALF, PICKUP_ZOOMIES, WEAPONS, Weapon } from "../shared/constants.js";
import { CITY } from "../shared/map.js";
import { MANHOLES, SEWER } from "../shared/sewer.js";
import { LOOKS } from "../shared/districts.js";
import { DISTRICTS } from "../shared/layout.js";
import { TRACK_LENGTH, trackPoint } from "../shared/train.js";
import { FREE, WEAPON_ICONS, iconSprite, setIconSize, iconTexture, RichLine, type IconName, type Part } from "./icons.js";

/** The HUD's text face, and the display face of its big words (the same pair as the start screen). */
export const FONT = "'Barlow Semi Condensed', 'Arial Narrow', system-ui, sans-serif";
export const DISPLAY = "'Bebas Neue', Impact, 'Arial Narrow', sans-serif";
const INK = 0x2b2340;
/** The minimap's rings around what the server sends us. */
const VIEW_BLUE = 0x6fd3ff;

const style = (size: number, fill = 0xffffff, extra: Partial<TextStyleOptions> = {}): TextStyleOptions => ({
  fontFamily: FONT, fontSize: size, fill, fontWeight: "700",
  stroke: { color: INK, width: Math.max(3, size / 6), join: "round" },
  ...extra,
});

/**
 * How big the HUD is drawn: it grows and shrinks with the window, smoothly (1 at 1280×720).
 * A little less than in proportion: a bigger window shows more of the town, not just bigger
 * numbers.
 */
export function hudScale(w: number, h: number) {
  const k = Math.min(w / 1280, h / 720);
  return Math.min(2.2, Math.max(0.6, k ** 0.8));
}

/**
 * A soft dark shade with no edge, centred on (cx, cy): stacked ellipses, each a little
 * darker, instead of a panel (the HUD has no boxes; a blur filter would compile a new
 * shader the first time it shows).
 */
function shade(g: Graphics, cx: number, cy: number, rx: number, ry: number, alpha = 0.55) {
  // (enough layers that no ring shows)
  const n = 32;
  for (let i = 0; i < n; i++) {
    const k = 1 - i / n;
    g.ellipse(cx, cy, rx * k, ry * k).fill({ color: INK, alpha: 1 - (1 - alpha) ** (1 / n) });
  }
}

/** A name tag. `show`: how far it's faded in (0..1), toward 1 while they're `inSight`. */
interface Tag { root: Container; text: Text; hearts: Sprite[]; seen: boolean; label: string; hp: number; inSight: boolean; show: number }
/** How fast a name tag fades in or out (per second): an eighth of a second, so it doesn't flicker at a wall's edge. */
const TAG_FADE = 8;
interface Popup { line: RichLine; x: number; y: number; life: number }
/** A damage number: the popup, and how much it says. */
interface DamageNumber { pop: Popup; total: number }
/** Hits on the same raccoon within this long (s) of the last add to its number, not a new one. */
const DAMAGE_ADD_S = 0.5;
const POPUP_LIFE = 1.1;

/** A weapon in the bottom-left rack (`mark`: the sunny line under the one in your paws; `base`: its scale). */
interface Slot { root: Container; mark: Graphics; icon: Sprite; badge: Text; state: string; base: number }

/** A stink bomb's wind-up, by how far along it is: green, sunny, orange, then hot pink at full power. */
const CHARGE_RAMP: [number, number][] = [[0, 0x7cff6b], [0.45, 0xffd23f], [0.8, 0xff9f43], [1, 0xff5d8f]];

/** The wind-up's colour at `k` (0..1): the meter over the raccoon, and the aim arc and ring on the ground. */
export function chargeColor(k: number): number {
  k = Math.max(0, Math.min(1, k));
  let i = 1;
  while (i < CHARGE_RAMP.length - 1 && k > CHARGE_RAMP[i][0]) i++;
  const [k0, c0] = CHARGE_RAMP[i - 1], [k1, c1] = CHARGE_RAMP[i];
  const t = (k - k0) / (k1 - k0 || 1);
  const ch = (s: number) => Math.round(((c0 >> s) & 255) + (((c1 >> s) & 255) - ((c0 >> s) & 255)) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** The wind-up meter's size (HUD units). */
const METER_W = 92, METER_H = 16;

/** Extra minimap markers: gulls (out of the round), the sewer while you're down it, and Garbage Day's truck and dumpster. */
export interface MapExtras {
  gulls: { x: number; z: number }[];
  /** Down the sewer: the street whose pipe we're in (its pipes and manholes show). */
  sewer: { edge: number } | null;
  truck: { x: number; z: number } | null;
  /** Where the golden dumpster is (or is headed: `coming`), and whether it's open yet. */
  dumpster: { x: number; z: number; coming: boolean; open: boolean } | null;
}

/** A splat of goo on the screen (a gull got you): a blob, its drips, how long it's been there. */
interface Goo { g: Graphics; drips: { x: number; y: number; r: number; v: number }[]; life: number; x: number; y: number; s: number }
const GOO_LIFE = 3.6;

/** Ammo icon per weapon slot (fists need none). */
const AMMO_ICONS: (IconName | null)[] = [null, "cork", "cap", "junk", "wpn_grenade"];

export class Hud {
  readonly root = new Container();
  private tags = new Map<string, Tag>();
  private tagLayer = new Container();
  private popups: Popup[] = [];
  /** The damage number over each raccoon we're hitting (by session id). */
  private damageNumbers = new Map<string, DamageNumber>();
  private popupLayer = new Container();
  private feed: { line: RichLine; life: number }[] = [];
  private feedLayer = new Container();

  // over the raccoon winding up a stink bomb: how far it'll go
  private meter = new Container();
  private meterBar = new Graphics();
  private meterIcon = iconSprite("wpn_grenade", 30);
  private meterMax = new Text({ text: "MAX!", style: style(24, 0xff5d8f, { fontFamily: DISPLAY, fontWeight: "400", letterSpacing: 1.5 }) });
  /** How wound up (0..1), or -1: nobody is. */
  private meterK = -1;
  /** Popping in (0..1), and how long it's been at full power (s). */
  private meterIn = 0;
  private meterFull = 0;
  /** Leaving: thrown (it flies off after the bomb) or not (it shakes out red), and for how long (s). */
  private meterOut: "throw" | "cancel" | null = null;
  private meterOutT = 0;
  private meterEnd: "throw" | "cancel" = "cancel";
  /** The stink bomb slot bumps when one leaves (s left). */
  private bumpT = 0;

  // top left: who you are and how you're doing
  private avatar = iconSprite("raccoon", 46, 0);
  private nameText = new Text({ text: "", style: style(21) });
  private heart = iconSprite("heart", 30);
  private hpBar = new Graphics();
  private hpText = new Text({ text: "", style: style(15) });
  /** The zoomies' seconds left, beside the health bar. */
  private zoomLine = new RichLine(style(17, 0xffb35c), 28, 4);
  private zoomLeft = 0;
  /** Breath for the sewer, after the zoomies: shown while it isn't full, pulsing when it's nearly out. */
  private airLine = new RichLine(style(17, 0x9be37a), 28, 4);
  private airKey = "";
  private airLow = false;

  // bottom left: the weapon rack
  private weaponIcon = iconSprite("paw", 62);
  private weaponText = new Text({ text: "", style: style(26) });
  private ammoLine = new RichLine(style(19, 0xfff3b0), 24, 4);
  private slots: Slot[] = [];
  private rack = new Container();
  /** On a pad, LB / RB beside the rack (the number keys under the slots then hide). */
  private rackPad = new RichLine(style(14), 22, 2);
  /** The help and the rack show the pad's buttons. */
  private pad = false;

  // top right: score and connection
  private scoreLine = new RichLine(style(22, 0xffe066), 30, 6);
  private pingLine = new RichLine(style(14, 0xd9f2ff), 18, 4);
  private muted = false;

  private hint = new RichLine(style(18, 0xffffff), 30, 7);
  /** Top centre: the round (waiting / countdown / players left · fumes). */
  private roundLine = new RichLine(style(20, 0xffffff), 28, 6);
  /** Purple edge glow while you're in the fumes. */
  private fog = new Graphics();
  private fogK = 0;
  /** Inside a trash can: the screen is the gap under the lid (dark above and below). */
  private binEdge = new Graphics();
  private binK = 0;
  /** Down the sewer: dark, damp and green round the edges. */
  private sewerEdge = new Graphics();
  private sewerK = 0;
  /** Goo on the screen (a gull's direct hit), sliding down and fading. */
  private gooLayer = new Container();
  private goos: Goo[] = [];
  /** The golden dumpster's marker: over it on screen, or at the edge pointing the way. */
  private marker = new Container();
  private markerLine = new RichLine(style(19, 0xffe066), 28, 5);
  private markerArrow = new Graphics();
  private bigIcon = iconSprite("raccoon_dizzy", 110);
  private big = new Text({ text: "", style: style(96, 0xff5d8f, { fontFamily: DISPLAY, fontWeight: "400", letterSpacing: 2, stroke: { color: INK, width: 12, join: "round" } }) });
  private sub = new Text({ text: "", style: style(24) });
  private crosshair = new Graphics();
  /** The Blunderbuss's ring of pellets round the crosshair, and the radius it's drawn at (px). */
  private spread = new Graphics();
  private spreadR = 0;
  private hitmark = new Graphics();
  private hitmarkT = 0;
  private damage = new Graphics();
  private damageT = 0;

  private map = new Container();
  private mapStatic = new Graphics();
  /** What the map's frame clips (the fumes circle is bigger than the map early on). */
  private mapClip = new Container();
  /** The fumes, redrawn only when their circles change (`zoneAt`: what they were drawn for). */
  private mapZone = new Graphics();
  private zoneAt: number[] = [];
  /** What the server sends us: its two rings round its view's centre, drawn once and moved. */
  private mapView = new Graphics();
  private mapSeen = new Graphics();
  /** Down the sewer: the pipe network and manholes (drawn once), and the pipe we're in over it. */
  private mapSewer = new Container();
  private mapPipe = new Graphics();
  private pipeEdge = -1;
  private mapDyn = new Graphics();
  /** Us, drawn once pointing along +z, moved and turned. */
  private mapArrow = new Graphics();
  private mapIcons = new Container();
  private mapPool = new Map<IconName, Sprite[]>();
  private readonly mapSize = 200;

  private netPanel = new Text({ text: "", style: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12, fill: 0xd9f2ff, lineHeight: 15, stroke: { color: 0x1b1530, width: 3 } } });
  private help = new Container();
  private board = new Container();
  private boardKey = "";
  showNet = false;
  showHelp = true;

  constructor() {
    this.root.addChild(this.tagLayer, this.marker, this.meter, this.popupLayer, this.binEdge, this.sewerEdge, this.fog, this.gooLayer, this.damage, this.avatar, this.nameText, this.heart, this.hpBar, this.hpText, this.zoomLine, this.airLine,
      this.weaponIcon, this.weaponText, this.ammoLine, this.rack, this.scoreLine, this.pingLine, this.feedLayer, this.hint, this.roundLine,
      this.map, this.bigIcon, this.big, this.sub, this.netPanel, this.help, this.board, this.hitmark, this.spread, this.crosshair);
    this.big.anchor.set(0.5);
    this.sub.anchor.set(0.5);
    this.bigIcon.visible = false;
    this.nameText.anchor.set(0, 0.5);
    this.hpText.anchor.set(0, 0.5);
    this.weaponText.anchor.set(0, 0.5);
    this.map.addChild(this.mapStatic, this.mapClip, this.mapIcons);
    this.mapClip.addChild(this.mapZone, this.mapView, this.mapSeen, this.mapSewer, this.mapDyn, this.mapArrow);
    const mask = new Graphics().roundRect(0, 0, this.mapSize, this.mapSize, 14).fill(0xffffff);
    this.map.addChild(mask);
    this.mapClip.mask = mask;
    this.drawMapStatic();
    this.crosshair.circle(0, 0, 9).stroke({ width: 3, color: INK }).circle(0, 0, 9).stroke({ width: 1.5, color: 0xffffff })
      .circle(0, 0, 2).fill(0xffffff);
    this.hitmark.visible = false;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      this.hitmark.moveTo(dx * 6, dy * 6).lineTo(dx * 14, dy * 14);
    }
    this.hitmark.stroke({ width: 3.5, color: 0xffffff });
    this.meterIcon.position.set(-METER_W / 2 - 4, -METER_H / 2);
    this.meterMax.anchor.set(0.5, 1);
    this.meterMax.position.set(0, -METER_H - 8);
    this.meter.addChild(this.meterBar, this.meterIcon, this.meterMax);
    this.meter.visible = false;
    this.buildRack();
    this.buildHelp();
    this.markerArrow.poly([0, -11, 9, 8, 0, 3, -9, 8]).fill(0xffe066).stroke({ width: 3, color: INK, join: "round" });
    this.marker.addChild(this.markerLine, this.markerArrow);
    this.marker.visible = false;
  }

  // ------------------------------------------------------------------ static parts
  private buildRack() {
    for (let i = 0; i <= Weapon.Grenade; i++) {
      const root = new Container();
      const mark = new Graphics().roundRect(-14, 25, 28, 5, 2.5).fill(0xffd23f).stroke({ width: 2, color: INK });
      const icon = iconSprite(WEAPON_ICONS[i], 38);
      const badge = new Text({ text: String(i), style: style(13, 0xffffff, { stroke: { color: INK, width: 4, join: "round" } }) });
      badge.anchor.set(0.5);
      badge.position.set(17, 15);
      root.addChild(mark, icon, badge);
      root.position.set(23 + i * 52, 22);
      this.rack.addChild(root);
      this.slots.push({ root, mark, icon, badge, state: "", base: 1 });
    }
    this.rackPad.set([{ pad: "lb" }, { pad: "rb" }]);
    this.rackPad.position.set(23 + (Weapon.Grenade + 1) * 52 - 8, 24);
    this.rackPad.visible = false;
    this.rack.addChild(this.rackPad);
  }

  /** Every key, or on a pad every button. */
  private buildHelp() {
    this.help.removeChildren().forEach((c) => c.destroy(FREE));
    // (the pad is laid out like GTA V)
    const rows: Part[][] = this.pad ? [
      [{ pad: "ls" }, "move · steer", { pad: "a" }, "hold: run"],
      [{ pad: "rs" }, "look around and aim (it helps a little)", { pad: "rt" }, "shoot or slap"],
      [{ pad: "r3" }, "camera: behind your raccoon, or overhead"],
      [{ pad: "lt" }, "hold: wind up a stink bomb · let go: throw", { icon: "wpn_grenade" }],
      [{ pad: "lb" }, { pad: "rb" }, "switch weapons", { pad: "dud" }, "too"],
      [{ pad: "y" }, "steal / enter / exit a car"],
      [{ pad: "x" }, "jump · into a car, a train or a ledge: climb up", { icon: "ride" }],
      [{ icon: "coffee" }, "the zoomies: run into a wall to crawl up it,", { pad: "x" }, "to kick off"],
      [{ pad: "y" }, "by a trash can: hide in it", { icon: "bin" }, "· a hit on it pops you out"],
      [{ pad: "b" }, "taunt (or", { pad: "l3" }, ")"],
      [{ pad: "rt" }, "gas", { pad: "lt" }, "brake, then back up", { pad: "rb" }, "handbrake: drift!"],
      [{ pad: "lb" }, "drive-by", { pad: "l3" }, "honk / siren"],
      [{ pad: "y" }, "by a manhole: down the sewer", { icon: "manhole" }, { pad: "ls" }, "scurry", { pad: "x" }, "climb out"],
      [{ icon: "gull" }, "out? a seagull:", { pad: "rt" }, "poop", { pad: "y" }, "snatch", { pad: "x" }, { pad: "a" }, "up · down", { pad: "dup" }, "watch instead"],
      [{ pad: "view" }, "hold: scores", { pad: "menu" }, "help"],
    ] : [
      [{ key: "W" }, { key: "A" }, { key: "S" }, { key: "D" }, "move · drive (S brakes, then backs up)"],
      [{ icon: "mouse" }, "look around and aim · click (or", { key: "J" }, ") to shoot or slap"],
      [{ key: "C" }, "camera: behind your raccoon, or overhead"],
      [{ key: "G" }, "hold: wind up a stink bomb · let go: throw", { icon: "wpn_grenade" }],
      [{ key: "1" }, { key: "2" }, { key: "3" }, { key: "4" }, "junk", { key: "0" }, "paws · wheel cycles"],
      [{ key: "E" }, { key: "F" }, "steal / enter / exit a car"],
      [{ key: "Space" }, "jump · into a car, a train or a ledge: climb up", { icon: "ride" }],
      [{ icon: "coffee" }, "the zoomies: run into a wall to crawl up it,", { key: "Space" }, "to kick off"],
      [{ key: "E" }, "by a trash can: hide in it", { icon: "bin" }, "· a hit on it pops you out"],
      [{ key: "Space" }, "in a car: handbrake, drift!", { key: "Shift" }, "sprint"],
      [{ key: "T" }, "taunt", { key: "H" }, "honk / siren"],
      [{ key: "E" }, "by a manhole: down the sewer", { icon: "manhole" }, { key: "W" }, { key: "A" }, { key: "S" }, { key: "D" }, "scurry", { key: "Space" }, "climb out"],
      [{ icon: "gull" }, "out? a seagull:", { icon: "mouse" }, "poop", { key: "E" }, "snatch", { key: "Space" }, { key: "Shift" }, "up · down", { key: "V" }, "watch instead"],
      [{ key: "M" }, "mute", { key: "B" }, "next tune", { key: "N" }, "netcode", { key: "Tab" }, "scores", { key: "F1" }, "help"],
    ];
    // (rows close enough that the lot stays clear of the weapon rack at 720p)
    let y = 20;
    for (const parts of rows) {
      const line = new RichLine(style(16), 26, 5);
      line.set(parts);
      line.position.set(14, y);
      this.help.addChild(line);
      y += 31;
    }
  }

  /** Keys or pad buttons, in the help and beside the rack (the hints follow on their own). */
  setDevice(pad: boolean) {
    this.pad = pad;
    this.buildHelp();
    this.rackPad.set([{ pad: "lb" }, { pad: "rb" }]);
    this.rackPad.visible = pad;
    for (const sl of this.slots) sl.badge.visible = !pad;
  }

  private drawMapStatic() {
    const g = this.mapStatic;
    const s = this.mapSize / (MAP_HALF * 2);
    const m = (v: number) => (v + MAP_HALF) * s;
    g.roundRect(0, 0, this.mapSize, this.mapSize, 14).fill(0x8fd16a);
    // the town on its street graph: each district faintly in its own colour; streets, footpaths,
    // parks, lots, buildings (turned with their streets, in their own colours), the ruins, the sinkhole
    const poly = (pts: readonly { x: number; z: number }[]) => pts.flatMap((p) => [m(p.x), m(p.z)]);
    for (const d of DISTRICTS) g.poly(poly(d.poly)).fill(LOOKS[d.area].map);
    for (const p of CITY.parks) if (p.poly) g.poly(poly(p.poly)).fill(0x7cc35a);
    for (const l of CITY.lots) if (l.poly) g.poly(poly(l.poly)).fill(0x9aa0ae);
    g.rect(m(CITY.plaza.minX), m(CITY.plaza.minZ), (CITY.plaza.maxX - CITY.plaza.minX) * s, (CITY.plaza.maxZ - CITY.plaza.minZ) * s).fill(0xe9dfcf);
    for (const e of CITY.roads.edges) {
      const w = e.half > 0 ? 2 * e.half * s : 2.5;
      g.moveTo(m(e.pts[0].x), m(e.pts[0].z));
      for (let i = 1; i < e.pts.length; i++) g.lineTo(m(e.pts[i].x), m(e.pts[i].z));
      g.stroke({ width: w, color: e.half > 0 ? 0x6a7080 : 0xb7a68e, join: "round", cap: "round" });
    }
    for (const nd of CITY.roads.nodes) if (nd.kind === "culdesac") g.circle(m(nd.x), m(nd.z), nd.r * s).fill(0x6a7080);
    for (const p of CITY.pits) g.rect(m(p.minX), m(p.minZ), (p.maxX - p.minX) * s, (p.maxZ - p.minZ) * s).fill(0x3b3d52);
    for (const bl of CITY.buildings) {
      if (!bl.fade) continue;
      const c = Math.cos(bl.rot), sn = Math.sin(bl.rot), hx = bl.fade.hx, hz = bl.fade.hz;
      const k = (lx: number, lz: number) => ({ x: bl.x + lx * c + lz * sn, z: bl.z - lx * sn + lz * c });
      const ruin = bl.model === "bld_demolished" || bl.model === "bld_collapsed" || bl.model === "bld_shell";
      g.poly(poly([k(-hx, -hz), k(hx, -hz), k(hx, hz), k(-hx, hz)])).fill(ruin ? 0xc9a27e : bl.tint ?? 0xffb3c7).stroke({ width: 1, color: 0x4a3f55, alpha: 0.35 });
    }
    // stairs up: a yellow tick at the foot of every flight
    for (const r of CITY.ramps) if (r.stairs && r.h0 < 0.1) g.circle(m(r.cx - r.s * r.hz), m(r.cz - r.c * r.hz), 1.6).fill(0xffd23f);

    const p = { x: 0, z: 0, dx: 0, dz: 0 };
    trackPoint(0, p);
    g.moveTo(m(p.x), m(p.z));
    for (let t = 4; t <= TRACK_LENGTH + 4; t += 4) {
      trackPoint(t, p);
      g.lineTo(m(p.x), m(p.z));
    }
    g.stroke({ width: 2.5, color: 0x8a5a3c });

    // the parts that only move: the server's view rings (a solid one, a dashed one outside it)
    const v = this.mapView, r = AOI_OUT * s, n = 28;
    v.circle(0, 0, AOI_IN * s).stroke({ width: 3, color: INK, alpha: 0.35 });
    v.circle(0, 0, AOI_IN * s).stroke({ width: 1.5, color: VIEW_BLUE });
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      v.moveTo(Math.cos(a) * r, Math.sin(a) * r).arc(0, 0, r, a, a + Math.PI / n);
    }
    v.stroke({ width: 1.5, color: VIEW_BLUE, alpha: 0.8 });
    this.mapView.visible = false;
    this.mapArrow.poly([0, 7, -4.5, -3, 4.5, -3]).fill(0xffd23f).stroke({ width: 1.5, color: INK });
    this.mapArrow.visible = false;
    // the sewer: a glowing green network, and the manholes you can climb out of
    const pipes = new Graphics(), holes = new Graphics();
    CITY.roads.edges.forEach((e, i) => {
      if (!SEWER.piped[i]) return;
      pipes.moveTo(m(e.pts[0].x), m(e.pts[0].z));
      for (let k = 1; k < e.pts.length; k++) pipes.lineTo(m(e.pts[k].x), m(e.pts[k].z));
      pipes.stroke({ width: 1.4, color: 0x7dffa0, alpha: 0.6, join: "round", cap: "round" });
    });
    for (const mh of MANHOLES) holes.circle(m(mh.x), m(mh.z), 2.2).fill(0x1b3a28).stroke({ width: 1.2, color: 0x7dffa0 });
    this.mapSewer.addChild(pipes, this.mapPipe, holes);
    this.mapSewer.visible = false;
  }

  // ------------------------------------------------------------------ minimap
  private mapUsed = new Map<IconName, number>();

  /** A pooled minimap icon (reused frame to frame). */
  private mapIcon(name: IconName, px: number): Sprite {
    let pool = this.mapPool.get(name);
    if (!pool) this.mapPool.set(name, (pool = []));
    const i = this.mapUsed.get(name) ?? 0;
    this.mapUsed.set(name, i + 1);
    let s = pool[i];
    if (!s) {
      s = new Sprite(iconTexture(name));
      s.anchor.set(0.5);
      pool.push(s);
      this.mapIcons.addChild(s);
    }
    setIconSize(s, px);
    s.visible = true;
    return s;
  }

  /**
   * Dynamic minimap markers. `zone`: the fumes (shaded outside the safe circle, the next
   * circle as a thin ring); `pickups` kinds beyond the weapons are snacks; `seen`: the screen's
   * footprint on the street (x, z of its corners, clockwise from the top left); `view`: the
   * centre of the server's StateView for us.
   */
  drawMap(me: { x: number; z: number; yaw: number } | null, players: { x: number; z: number }[], cars: { x: number; z: number; wreck: boolean }[], trains: { x: number; z: number; loco: boolean }[], pickups: { x: number; z: number; kind: number }[], zone: { x: number; z: number; r: number; nx: number; nz: number; nr: number; final: boolean } | null = null, seen: number[] | null = null, view: { x: number; z: number } | null = null, extra: MapExtras | null = null) {
    const g = this.mapDyn;
    const s = this.mapSize / (MAP_HALF * 2);
    const m = (v: number) => (v + MAP_HALF) * s;
    g.clear();
    this.mapUsed.clear();
    const zoneAt = zone && zone.r < 200 ? [zone.x, zone.z, zone.r, zone.nx, zone.nz, zone.nr, +zone.final] : [];
    if (zoneAt.length !== this.zoneAt.length || zoneAt.some((v, i) => v !== this.zoneAt[i])) {
      this.zoneAt = zoneAt;
      const z = this.mapZone.clear();
      if (zone && zoneAt.length) {
        z.roundRect(0, 0, this.mapSize, this.mapSize, 14).fill({ color: 0x6b5a8e, alpha: 0.55 });
        if (zone.r > 0.5) z.circle(m(zone.x), m(zone.z), zone.r * s).cut();
        if (zone.r > 0.5) z.circle(m(zone.x), m(zone.z), zone.r * s).stroke({ width: 2, color: 0xffd23f });
        if (!zone.final && zone.nr < zone.r - 0.5) z.circle(m(zone.nx), m(zone.nz), Math.max(1, zone.nr * s)).stroke({ width: 1.5, color: 0xffffff, alpha: 0.85 });
      }
    }
    // what the server sends us (its StateView): things come in within AOI_IN (the solid ring)
    // and only leave past AOI_OUT (the dashed one)
    this.mapView.visible = !!view;
    if (view) this.mapView.position.set(m(view.x), m(view.z));
    // what's on screen (wider at the top: the camera looks north, so the far edge is further away)
    this.mapSeen.clear();
    if (seen) {
      const q = [m(seen[0]), m(seen[1]), m(seen[2]), m(seen[3]), m(seen[4]), m(seen[5]), m(seen[6]), m(seen[7])];
      this.mapSeen.poly(q).fill({ color: 0xffffff, alpha: 0.25 }).stroke({ width: 3, color: INK, alpha: 0.55 }).poly(q).stroke({ width: 1.5, color: 0xffffff });
    }
    // down the sewer, the pipe we're in glows
    this.mapSewer.visible = !!extra?.sewer;
    const edge = extra?.sewer ? extra.sewer.edge : -1;
    if (edge !== this.pipeEdge) {
      this.pipeEdge = edge;
      const e = CITY.roads.edges[edge], p = this.mapPipe.clear();
      if (e && SEWER.piped[edge]) {
        p.moveTo(m(e.pts[0].x), m(e.pts[0].z));
        for (let k = 1; k < e.pts.length; k++) p.lineTo(m(e.pts[k].x), m(e.pts[k].z));
        p.stroke({ width: 2.6, color: 0x7dffa0, join: "round", cap: "round" });
      }
    }
    for (const c of cars) g.rect(m(c.x) - 1.6, m(c.z) - 1.6, 3.2, 3.2).fill(c.wreck ? 0x333333 : 0xffffff);
    for (const t of trains) if (!t.loco) g.circle(m(t.x), m(t.z), 2.6).fill(0xff5a5f).stroke({ width: 1, color: INK });
    for (const c of pickups) this.mapIcon(c.kind === PICKUP_ZOOMIES ? "coffee" : WEAPON_ICONS[c.kind] ?? "food", 13).position.set(m(c.x), m(c.z));
    for (const t of trains) if (t.loco) this.mapIcon("train_loco", 17).position.set(m(t.x), m(t.z));
    for (const p of players) this.mapIcon("raccoon", 15).position.set(m(p.x), m(p.z));
    if (extra) {
      for (const q of extra.gulls) g.circle(m(q.x), m(q.z), 2.4).fill(0xffffff).stroke({ width: 1, color: INK });
      // Garbage Day: where the dumpster is headed (a pulsing gold ring), and the truck
      const d = extra.dumpster;
      if (d) {
        const pulse = 5 + 2.5 * Math.sin(performance.now() / 180);
        if (!d.open) g.circle(m(d.x), m(d.z), pulse + (d.coming ? 3 : 0)).stroke({ width: 2, color: 0xffd23f, alpha: 0.9 });
        if (!d.coming) this.mapIcon("dumpster_gold", 17).position.set(m(d.x), m(d.z));
      }
      if (extra.truck) this.mapIcon("car_garbage", 18).position.set(m(extra.truck.x), m(extra.truck.z));
    }
    for (const [name, pool] of this.mapPool) {
      for (let i = this.mapUsed.get(name) ?? 0; i < pool.length; i++) pool[i].visible = false;
    }
    // the arrow along our facing (map x = world x, map y = world z: a turn the other way)
    this.mapArrow.visible = !!me;
    if (me) {
      this.mapArrow.position.set(m(me.x), m(me.z));
      this.mapArrow.rotation = -me.yaw;
    }
  }

  // ------------------------------------------------------------------ layout
  /** The HUD's size, in its own (unscaled) units. */
  private w = 0;
  private h = 0;
  /** `hudScale`, and the resolution its text is drawn at (so scaled up, it stays sharp). */
  private s = 1;
  private res = 1;

  /** The screen's size (CSS px) and the renderer's resolution. */
  layout(screenW: number, screenH: number, resolution = 1) {
    // everything below is laid out in HUD units: the root's scale turns them into pixels
    const s = hudScale(screenW, screenH);
    this.s = s;
    this.res = resolution * s;
    this.root.scale.set(s);
    const w = screenW / s, h = screenH / s;
    this.w = w;
    this.h = h;
    this.avatar.position.set(18, 12);
    this.nameText.position.set(72, 30);
    this.heart.position.set(36, 82);
    this.hpBar.position.set(56, 72);
    this.hpText.position.set(264, 82);
    this.zoomLine.position.set(304, 82);
    this.placeAir();
    this.weaponIcon.position.set(54, h - 128);
    this.weaponText.position.set(96, h - 142);
    this.ammoLine.position.set(98, h - 110);
    this.rack.position.set(22, h - 74);
    this.scoreLine.position.set(w - 24, 32);
    this.pingLine.position.set(w - 24, 64);
    this.feedLayer.position.set(w - 24, 96);
    this.hint.position.set(w / 2, h - 34);
    this.roundLine.position.set(w / 2, 30);
    this.roundLine.x = (w - this.roundLine.lineWidth) / 2;
    this.fog.clear();
    // a purple frame that thickens toward the edges (three soft bands)
    for (const [inset, a] of [[0, 0.5], [28, 0.25], [64, 0.1]] as const) {
      this.fog.rect(0, 0, w, h).fill({ color: 0x7a4cff, alpha: a }).rect(inset + 30, inset + 30, w - 2 * (inset + 30), h - 2 * (inset + 30)).cut();
    }
    this.fog.alpha = this.fogK;
    // the lid above, the rim below, soft at the edges: peeking out of a can
    this.binEdge.clear();
    for (const [k, a] of [[0.2, 0.75], [0.13, 0.35], [0.07, 0.25]] as const) {
      this.binEdge.rect(0, 0, w, h * k).fill({ color: 0x14101f, alpha: a }).rect(0, h * (1 - k * 0.8), w, h * k * 0.8).fill({ color: 0x14101f, alpha: a });
    }
    for (const [inset, a] of [[0, 0.35], [40, 0.15]] as const) {
      this.binEdge.rect(0, 0, w, h).fill({ color: 0x14101f, alpha: a }).rect(inset + 40, inset + 40, w - 2 * (inset + 40), h - 2 * (inset + 40)).cut();
    }
    this.binEdge.alpha = this.binK;
    // the sewer: a damp green-black frame, heaviest at the bottom (water), drips along the top
    this.sewerEdge.clear();
    for (const [inset, a] of [[0, 0.55], [30, 0.3], [70, 0.15], [120, 0.08]] as const) {
      this.sewerEdge.rect(0, 0, w, h).fill({ color: 0x0c1a12, alpha: a }).rect(inset + 30, inset + 30, w - 2 * (inset + 30), h - 2 * (inset + 50)).cut();
    }
    for (let i = 0; i < 18; i++) {
      const x = ((i * 0.618) % 1) * w, l = 18 + ((i * 37) % 50);
      this.sewerEdge.roundRect(x, 0, 6 + (i % 3) * 2, l, 3).fill({ color: 0x0c1a12, alpha: 0.6 });
    }
    this.sewerEdge.alpha = this.sewerK;
    this.map.position.set(w - this.mapSize - 24, h - this.mapSize - 24);
    this.bigIcon.position.set(w / 2, h * 0.38 - 110);
    this.big.position.set(w / 2, h * 0.38);
    this.sub.position.set(w / 2, h * 0.38 + 70);
    this.netPanel.position.set(24, 110);
    this.help.position.set(18, 110);
    this.board.position.set(w / 2, 90);
    this.damage.clear().rect(0, 0, w, h).fill({ color: 0xff2d55, alpha: 1 });
    this.damage.alpha = 0;
    this.alignRight(this.scoreLine);
    this.alignRight(this.pingLine);
    this.hint.x = (w - this.hint.lineWidth) / 2;
  }

  private alignRight(line: RichLine) { line.x = this.w - 24 - line.lineWidth; }

  // ------------------------------------------------------------------ player panel
  setPlayer(name: string, hp: number, weapon: number, ammo: number[], score: number, kills: number) {
    this.gullPanel(false);
    this.nameText.text = name;
    const g = this.hpBar;
    g.clear();
    g.roundRect(0, 0, 200, 20, 10).fill({ color: INK, alpha: 0.8 });
    const f = Math.max(0, Math.min(1, hp / 100));
    if (f > 0) g.roundRect(3, 3, 194 * f, 14, 7).fill(f > 0.5 ? 0x7cff6b : f > 0.25 ? 0xffd23f : 0xff5d5d);
    this.hpText.text = String(Math.max(0, Math.round(hp)));

    this.weaponIcon.texture = iconTexture(WEAPON_ICONS[weapon]);
    setIconSize(this.weaponIcon, weapon === Weapon.Fists ? 54 : 62);
    this.weaponText.text = WEAPONS[weapon].name;
    const ammoIcon = AMMO_ICONS[weapon];
    this.ammoLine.set(ammoIcon ? [{ icon: ammoIcon }, `× ${ammo[weapon - 1]}`] : ["bonk bonk"]);

    // the rack: the one in your paws bigger and underlined, the empty ones faded
    for (let i = 0; i < this.slots.length; i++) {
      const sl = this.slots[i];
      const has = i === 0 || ammo[i - 1] > 0;
      const sel = i === weapon;
      const key = `${has}|${sel}`;
      if (key === sl.state) continue;
      sl.state = key;
      sl.mark.visible = sel;
      sl.icon.alpha = has ? 1 : 0.3;
      sl.base = sel ? 1.25 : 1;
      sl.root.scale.set(sl.base);
      sl.root.y = sel ? 18 : 22;
      sl.badge.alpha = has ? 1 : 0.5;
    }

    this.scoreLine.set([{ icon: "star" }, String(score), " ", { icon: "skull" }, String(kills)]);
    this.alignRight(this.scoreLine);
  }

  /**
   * Out of the round, flying about as a gull: the panel is the gull's (no health, no weapons),
   * its droppings (`ready` or not yet), and what it carries in its feet (a pickup kind, -1: nothing).
   */
  setGull(name: string, ready: boolean, carry: number) {
    this.gullPanel(true);
    this.nameText.text = name;
    this.weaponIcon.texture = iconTexture("splat");
    setIconSize(this.weaponIcon, 56);
    this.weaponText.text = "Droppings";
    const kindIcon = carry === PICKUP_ZOOMIES ? "coffee" : carry >= 0 ? WEAPON_ICONS[carry] ?? "food" : null;
    this.ammoLine.set(kindIcon ? [{ icon: kindIcon }, "in its feet"] : [ready ? "ready" : "…"]);
  }

  private gull = false;
  private gullPanel(on: boolean) {
    if (on === this.gull) return;
    this.gull = on;
    this.avatar.texture = iconTexture(on ? "gull" : "raccoon");
    setIconSize(this.avatar, 46);
    for (const n of [this.heart, this.hpBar, this.hpText, this.rack, this.zoomLine, this.airLine]) n.visible = !on;
  }

  /** The zoomies' whole seconds left (0: none). */
  setZoomies(seconds: number) {
    if (seconds === this.zoomLeft) return;
    this.zoomLeft = seconds;
    this.zoomLine.set(seconds > 0 ? [{ icon: "coffee" }, `ZOOMIES ${seconds}`] : []);
    this.placeAir();
  }

  /** Whole seconds of breath left (null: a full one, hidden); `low`: nearly out (it pulses). */
  setAir(seconds: number | null, low: boolean) {
    this.airLow = low;
    const key = seconds === null ? "" : String(seconds);
    if (key === this.airKey) return;
    this.airKey = key;
    this.airLine.set(seconds === null ? [] : [{ icon: "manhole" }, `AIR ${seconds}`]);
  }

  private placeAir() {
    this.airLine.position.set(304 + (this.zoomLeft > 0 ? this.zoomLine.lineWidth + 16 : 0), 82);
  }

  private pingKey = "";
  setPing(rtt: number, players: number) {
    const key = `${players}|${Math.round(rtt)}|${this.muted}`;
    if (key === this.pingKey) return;
    this.pingKey = key;
    this.pingLine.set([
      ...(this.muted ? [{ icon: "speaker_off" as const }, " "] : []),
      { icon: "raccoon" }, `${players} online`, " ", { icon: "signal" }, `${Math.round(rtt)} ms`,
    ]);
    this.alignRight(this.pingLine);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.pingKey = "";
  }

  setHint(parts: Part[]) {
    this.hint.set(parts);
    this.hint.x = (this.w - this.hint.lineWidth) / 2;
  }

  /** The round, top centre (empty: hidden). */
  setRound(parts: Part[]) {
    this.roundLine.set(parts);
    this.roundLine.x = (this.w - this.roundLine.lineWidth) / 2;
  }

  /** In the fumes: 0 (clear) .. 1 (deep in). */
  setFog(k: number) {
    this.fogK = k;
  }

  /** Hiding in a trash can (the edges of the screen go dark). */
  setHiding(on: boolean) {
    this.binK = on ? 1 : 0;
  }

  /** Down the sewer (the edges of the screen go dark and damp). */
  setSewer(on: boolean) {
    this.sewerK = on ? 1 : 0;
  }

  /** A gull got us: goo splats over the screen and slides down it for a few seconds. */
  goo() {
    const w = this.w, h = this.h;
    for (let n = 0; n < 2 + ((Math.random() * 2) | 0); n++) {
      // mostly off the middle (it's a joke, not a blindfold), one somewhere near it
      const near = n === 0;
      const x = near ? w * (0.32 + Math.random() * 0.36) : Math.random() < 0.5 ? w * (0.08 + Math.random() * 0.25) : w * (0.67 + Math.random() * 0.25);
      const y = near ? h * (0.2 + Math.random() * 0.25) : h * (0.15 + Math.random() * 0.55);
      const s = (near ? 0.75 : 1) * (70 + Math.random() * 60);
      const g = new Graphics();
      // a splat: a lumpy white blob, splashed out in spikes, specks flung round it, a few grey-green
      // streaks through it and a wet shine (bird poop, not an egg)
      const seed = Math.random() * 10;
      const blob = (k: number) => {
        const pts: number[] = [];
        for (let i = 0; i < 40; i++) {
          const a = (i / 40) * Math.PI * 2;
          const spike = Math.max(0, Math.sin(a * 5 + seed)) ** 6 * 0.45 + Math.max(0, Math.sin(a * 3 - seed * 2)) ** 8 * 0.3;
          const r = s * k * (0.5 + 0.12 * Math.sin(a * 4 + seed) + 0.07 * Math.sin(a * 9 + seed * 3) + spike);
          pts.push(Math.cos(a) * r, Math.sin(a) * r);
        }
        return pts;
      };
      g.poly(blob(1.05)).fill({ color: 0xd8dbc8, alpha: 0.92 });
      g.poly(blob(1)).fill({ color: 0xfbfbf3, alpha: 0.97 });
      for (let k = 0; k < 7; k++) {
        const a = seed + k * 0.9, d = s * (0.75 + (k % 3) * 0.12);
        g.circle(Math.cos(a) * d, Math.sin(a) * d, s * (0.04 + (k % 2) * 0.03)).fill({ color: 0xfbfbf3, alpha: 0.95 });
      }
      for (let k = 0; k < 3; k++) {
        const a = seed * 1.7 + k * 2.1, r0 = s * 0.08, r1 = s * (0.28 + k * 0.05);
        g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0).quadraticCurveTo(Math.cos(a + 0.5) * r1 * 0.7, Math.sin(a + 0.5) * r1 * 0.7, Math.cos(a + 0.2) * r1, Math.sin(a + 0.2) * r1)
          .stroke({ width: s * 0.07, color: k === 1 ? 0x8f9a6a : 0xa9ad98, alpha: 0.8, cap: "round" });
      }
      g.ellipse(-s * 0.18, -s * 0.2, s * 0.14, s * 0.07).fill({ color: 0xffffff, alpha: 0.95 });
      g.position.set(x, y);
      this.gooLayer.addChild(g);
      const drips = Array.from({ length: 3 + ((Math.random() * 3) | 0) }, () => ({ x: (Math.random() - 0.5) * s, y: s * 0.35, r: 6 + Math.random() * 9, v: 12 + Math.random() * 30 }));
      this.goos.push({ g, drips, life: GOO_LIFE, x, y, s });
    }
  }

  /**
   * The golden dumpster's marker: `parts` over it at screen (x, y) (CSS px; `ahead` false: it's
   * behind the camera, and its point is mirrored), clamped to the screen's edge with an arrow
   * pointing the way when it's off screen. Null hides it.
   */
  setMarker(parts: Part[] | null, x = 0, y = 0, ahead = true) {
    this.marker.visible = !!parts;
    if (!parts) return;
    this.markerLine.set(parts);
    let px = x / this.s, py = y / this.s;
    if (!ahead) { px = this.w - px; py = this.h - py; }
    const m = 46, cx = this.w / 2, cy = this.h / 2;
    const off = !ahead || px < m || py < m || px > this.w - m || py > this.h - m;
    if (off) {
      // to the edge, along the line from the middle (behind us: always all the way, or dead behind, the bottom)
      const dx = px - cx, dy = !ahead && Math.hypot(px - cx, py - cy) < 1 ? 1 : py - cy;
      const k = Math.min(Math.abs((cx - m) / (dx || 1e-6)), Math.abs((cy - m) / (dy || 1e-6)));
      const t = ahead ? Math.min(1, k) : k;
      px = cx + dx * t; py = cy + dy * t;
      this.markerArrow.visible = true;
      this.markerArrow.rotation = Math.atan2(dy, dx) + Math.PI / 2;
      this.markerArrow.position.set(0, 0);
    } else this.markerArrow.visible = false;
    this.marker.position.set(px, py);
    this.markerLine.position.set(-this.markerLine.lineWidth / 2, off ? 20 : -14);
  }

  /** The big centre banner. `low`: below the middle, leaving the top half to the scoreboard. */
  setBig(text: string, sub = "", icon: IconName | null = null, low = false) {
    this.big.text = text;
    this.sub.text = sub;
    this.bigIcon.visible = !!text && !!icon;
    if (icon) this.bigIcon.texture = iconTexture(icon);
    const y = this.h * (low ? 0.72 : 0.38);
    this.bigIcon.y = y - 110;
    this.big.y = y;
    this.sub.y = y + 70;
  }

  setNet(text: string | null) {
    this.netPanel.visible = this.showNet && !!text;
    if (text) this.netPanel.text = text;
    this.help.visible = this.showHelp && !this.showNet;
  }

  /**
   * Scoreboard rows (null hides it). `state`: "" (in), "out #3", "waiting"… shown dim
   * next to the name.
   */
  setBoard(rows: { name: string; state: string; wins: number; score: number; kills: number; deaths: number; me: boolean }[] | null, title = "SCOREBOARD") {
    this.board.visible = !!rows;
    if (!rows) return;
    const key = title + JSON.stringify(rows);
    if (key === this.boardKey) return;
    this.boardKey = key;
    this.board.removeChildren().forEach((c) => c.destroy(FREE));
    const cols = [0, 290, 360, 430, 500];
    const width = 560;
    const bg = new Graphics();
    this.board.addChild(bg);
    const head = new Text({ text: title, style: style(34, 0xffd23f, { fontFamily: DISPLAY, fontWeight: "400", letterSpacing: 1.5 }) });
    head.anchor.set(0.5, 0);
    head.position.set(0, 12);
    this.board.addChild(head);
    const x0 = -width / 2 + 24;
    (["crown", "star", "skull", "tombstone"] as const).forEach((n, i) => {
      const s = iconSprite(n, 30);
      s.position.set(x0 + cols[i + 1] + 14, 70);
      this.board.addChild(s);
    });
    let y = 104;
    rows.forEach((r, i) => {
      const color = r.me ? 0xffe066 : r.state ? 0xb8b0d0 : 0xffffff;
      const cells = [`${i + 1}. ${r.name}`, String(r.wins), String(r.score), String(r.kills), String(r.deaths)];
      cells.forEach((c, k) => {
        const t = new Text({ text: c, style: style(18, color) });
        t.anchor.set(k === 0 ? 0 : 0.5, 0.5);
        t.position.set(x0 + cols[k] + (k === 0 ? 0 : 14), y);
        this.board.addChild(t);
        if (k === 0 && r.state) {
          const st = new Text({ text: r.state, style: style(13, 0xb8b0d0) });
          st.anchor.set(0, 0.5);
          st.position.set(t.x + t.width + 8, y + 1);
          this.board.addChild(st);
        }
      });
      y += 30;
    });
    shade(bg, 0, (y + 6) / 2, width * 0.85, (y + 6) * 0.95, 0.8);
  }

  /** A kill-feed / event row: text and icons. */
  addFeed(parts: Part[]) {
    const line = new RichLine(style(16, 0xffffff), 26, 6);
    line.set(parts);
    line.pivot.x = line.lineWidth;
    this.feedLayer.addChild(line);
    this.feed.unshift({ line, life: 6 });
    while (this.feed.length > 6) this.feed.pop()!.line.destroy(FREE);
  }

  /** A rising word or two at a screen position (CSS px). */
  popup(parts: Part[], x: number, y: number, color = 0xffe066) {
    const line = new RichLine(style(26, color), 30, 4);
    line.set(parts);
    line.pivot.x = line.lineWidth / 2;
    this.popupLayer.addChild(line);
    this.popups.push({ line, x: x / this.s, y: y / this.s, life: POPUP_LIFE });
  }

  /**
   * How much we just hurt raccoon `key`, at screen (x, y) in CSS px: one number per raccoon, a
   * blast's pellets in one, and a burst adds up in it while the hits keep coming. A negative
   * `amount` takes back a hit the server didn't count.
   */
  damageNumber(key: string, amount: number, x: number, y: number) {
    const live = this.damageNumbers.get(key);
    const fresh = live && live.pop.life > POPUP_LIFE - DAMAGE_ADD_S && this.popups.includes(live.pop);
    if (!fresh && amount <= 0) return;
    if (!fresh) {
      this.popup([String(amount)], x, y, 0xffffff);
      this.damageNumbers.set(key, { pop: this.popups[this.popups.length - 1], total: amount });
      return;
    }
    live.total += amount;
    if (live.total <= 0) { live.pop.life = Math.min(live.pop.life, 0.12); return; }
    live.pop.line.set([String(live.total)]);
    live.pop.line.pivot.x = live.pop.line.lineWidth / 2;
    // (a pop as it grows, over where they are now)
    if (amount > 0) { live.pop.life = POPUP_LIFE; live.pop.x = x / this.s; live.pop.y = y / this.s; }
  }

  hitMarker() { this.hitmarkT = 0.18; }
  hurt() { this.damageT = 0.35; }

  /**
   * The stink-bomb wind-up meter, over a raccoon (yours, or the one you watch): `k` 0..1, how
   * wound up, with the meter's bottom middle at screen (x, y) in CSS px. Null: nobody is winding
   * up (it then flies off after the throw, or shakes out red; see `windupEnded`).
   */
  windup(k: number | null, x = 0, y = 0) {
    if (k === null) {
      if (this.meterK >= 0 && !this.meterOut) { this.meterOut = this.meterEnd; this.meterOutT = 0; }
      this.meterK = -1;
      this.meterEnd = "cancel";
      return;
    }
    if (this.meterK < 0) { this.meterIn = 0; this.meterFull = 0; this.meterOut = null; }
    this.meterK = Math.max(0, Math.min(1, k));
    this.meter.position.set(x / this.s, y / this.s);
  }

  /** The wind-up just ended in a throw (the meter flies off after it) or didn't (it shakes out). */
  windupEnded(how: "throw" | "cancel") {
    this.meterEnd = how;
    if (how === "throw") this.bumpT = 0.3;
  }

  /** Draw the meter at `k`, white-hot by `flash`, all in `tint` if given. */
  private drawMeter(k: number, flash: number, tint?: number) {
    const g = this.meterBar.clear();
    const w = METER_W, h = METER_H;
    g.roundRect(-w / 2 - 3, -h - 3, w + 6, h + 6, (h + 6) / 2).fill({ color: INK, alpha: 0.85 });
    if (k > 0.001) {
      const fw = Math.max(h - 2, (w - 2) * k);
      g.roundRect(-w / 2 + 1, -h + 1, fw, h - 2, (h - 2) / 2).fill(tint ?? chargeColor(k));
      if (flash > 0) g.roundRect(-w / 2 + 1, -h + 1, fw, h - 2, (h - 2) / 2).fill({ color: 0xffffff, alpha: flash });
      // a highlight along its top
      g.roundRect(-w / 2 + 5, -h + 3, Math.max(0, fw - 8), 3, 1.5).fill({ color: 0xffffff, alpha: 0.35 });
    }
    for (const q of [0.25, 0.5, 0.75]) g.rect(-w / 2 + (w - 2) * q, -h + 2, 2, h - 4).fill({ color: INK, alpha: 0.6 });
  }

  private updateMeter(dt: number) {
    const m = this.meter, t = performance.now() / 1000;
    if (this.meterK >= 0) {
      const k = this.meterK;
      m.visible = true;
      m.alpha = 1;
      this.meterIn = Math.min(1, this.meterIn + dt / 0.14);
      // pops in, overshooting a little
      const p = this.meterIn, pop = 1 + 0.25 * Math.sin(p * Math.PI) * (1 - p * 0.3);
      const full = k >= 1;
      this.meterFull = full ? this.meterFull + dt : 0;
      const pulse = full ? 1 + 0.06 * Math.sin(this.meterFull * 22) : 1;
      m.scale.set(p * pop * pulse);
      m.pivot.x = full ? Math.sin(t * 61) * 1.2 : 0;
      this.drawMeter(k, full ? 0.25 + 0.25 * Math.sin(this.meterFull * 22) : 0);
      this.meterIcon.rotation = Math.sin(t * (6 + 10 * k)) * (0.08 + 0.25 * k);
      this.meterMax.visible = full;
      if (full) this.meterMax.scale.set(1 + 0.7 * Math.max(0, 1 - this.meterFull / 0.15));
      return;
    }
    if (!this.meterOut) { m.visible = false; return; }
    this.meterOutT += dt;
    if (this.meterOut === "throw") {
      // it flies off after the stink bomb
      const p = Math.min(1, this.meterOutT / 0.25);
      m.pivot.set(0, 50 * p * (2 - p));
      m.scale.set(1 + 0.25 * p);
      m.alpha = 1 - p;
      if (p >= 1) this.meterOut = null;
    } else {
      // knocked over (or the server didn't throw it): it shakes out, red
      const p = Math.min(1, this.meterOutT / 0.3);
      m.pivot.set(Math.sin(this.meterOutT * 60) * 5 * (1 - p), 0);
      this.drawMeter(1, 0, 0xff4d4d);
      this.meterMax.visible = false;
      m.alpha = 1 - p;
      if (p >= 1) this.meterOut = null;
    }
    if (!this.meterOut) { m.visible = false; m.pivot.set(0, 0); }
  }

  /**
   * Name tag above a remote player (screen position in CSS px, or null when off-screen). Out
   * of our sight (behind a wall, a car), it fades out: it would give them away.
   */
  tag(id: string, name: string, hp: number, pos: { x: number; y: number } | null, inSight: boolean) {
    let t = this.tags.get(id);
    if (!t) {
      const root = new Container();
      const text = new Text({ text: name, style: style(15, 0xffffff) });
      text.anchor.set(0.5, 1);
      root.addChild(text);
      const hearts: Sprite[] = [];
      for (let i = 0; i < 4; i++) {
        const h = iconSprite("heart", 15);
        h.position.set((i - 1.5) * 13, -text.height - 6);
        root.addChild(h);
        hearts.push(h);
      }
      this.tagLayer.addChild(root);
      t = { root, text, hearts, seen: true, label: name, hp: -1, inSight, show: 0 };
      this.tags.set(id, t);
    }
    t.seen = true;
    t.inSight = inSight;
    t.root.visible = !!pos && (inSight || t.show > 0);
    if (!pos) return;
    t.root.position.set(pos.x / this.s, pos.y / this.s);
    if (t.label !== name) { t.label = name; t.text.text = name; }
    if (t.hp !== hp) {
      t.hp = hp;
      const n = hp < 100 ? Math.ceil(hp / 25) : 0;
      t.hearts.forEach((h, i) => { h.visible = i < n; });
      // centre the row of hearts that are left
      t.hearts.forEach((h, i) => { h.x = (i - (n - 1) / 2) * 13; });
    }
  }

  /**
   * Once a frame. The crosshair at (aimX, aimY) in CSS px: the mouse, or on a pad a point
   * along the aim ("lock": on whoever the aim helped onto, bigger), or hidden ("off").
   * `spread`: the radius (CSS px) of a ring of pellets to draw round it (0: none).
   */
  update(dt: number, aimX: number, aimY: number, reticle: "mouse" | "pad" | "lock" | "off" = "mouse", spread = 0) {
    this.sharpen(this.root);
    aimX /= this.s;
    aimY /= this.s;
    for (const [id, t] of this.tags) {
      if (!t.seen) { t.root.destroy({ children: true }); this.tags.delete(id); continue; }
      t.seen = false;
      t.show = Math.max(0, Math.min(1, t.show + (t.inSight ? dt : -dt) * TAG_FADE));
      t.root.alpha = t.show;
    }
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.life -= dt;
      p.y -= dt * 60;
      p.line.position.set(p.x, p.y);
      p.line.alpha = Math.min(1, p.life * 2);
      p.line.scale.set(1 + Math.max(0, p.life - 0.9) * 3);
      if (p.life <= 0) { p.line.destroy(FREE); this.popups.splice(i, 1); }
    }
    let y = 0;
    for (const f of this.feed) {
      f.life -= dt;
      f.line.alpha = Math.min(1, f.life);
      f.line.position.set(0, y + 14);
      y += 32;
    }
    while (this.feed.length && this.feed[this.feed.length - 1].life <= 0) this.feed.pop()!.line.destroy(FREE);

    this.crosshair.position.set(aimX, aimY);
    this.crosshair.visible = reticle !== "off";
    const k = reticle === "lock" ? 1.4 : 1;
    this.crosshair.scale.set(this.crosshair.scale.x + (k - this.crosshair.scale.x) * Math.min(1, dt * 18));
    // the ring: a dot where each of the outer pellets goes (redrawn only when its size changes)
    const r = reticle === "off" ? 0 : spread / this.s;
    this.spread.visible = r > 12;
    if (this.spread.visible) {
      this.spread.position.set(aimX, aimY);
      if (Math.abs(r - this.spreadR) > 0.5) {
        this.spreadR = r;
        this.spread.clear();
        for (let i = 0; i < 6; i++) this.spread.circle(Math.cos((i * Math.PI) / 3) * r, Math.sin((i * Math.PI) / 3) * r, 3.2);
        this.spread.fill(0xffffff).stroke({ width: 1.5, color: INK });
      }
    }
    this.hitmark.position.set(aimX, aimY);
    this.hitmarkT -= dt;
    this.hitmark.visible = this.hitmarkT > 0;
    this.updateMeter(dt);
    // the stink bomb slot bumps as one leaves
    if (this.bumpT > 0) {
      this.bumpT = Math.max(0, this.bumpT - dt);
      const sl = this.slots[Weapon.Grenade];
      sl.root.scale.set(sl.base * (1 + 0.4 * Math.sin((this.bumpT / 0.3) * Math.PI)));
    }
    this.damageT -= dt;
    this.damage.alpha = Math.max(0, this.damageT) * 0.6;
    this.damage.visible = this.damage.alpha > 0;
    // the fumes pulse, like coughing
    this.fog.alpha += (this.fogK * (0.75 + Math.sin(performance.now() / 260) * 0.25) - this.fog.alpha) * Math.min(1, dt * 6);
    this.fog.visible = this.fog.alpha > 0.01;
    this.binEdge.alpha += (this.binK - this.binEdge.alpha) * Math.min(1, dt * 8);
    this.sewerEdge.alpha += (this.sewerK - this.sewerEdge.alpha) * Math.min(1, dt * 6);
    this.sewerEdge.visible = this.sewerEdge.alpha > 0.01;
    this.airLine.alpha = this.airLow ? 0.6 + Math.sin(performance.now() / 90) * 0.4 : 1;
    // the goo slides down and fades, its drips running ahead of it
    for (let i = this.goos.length - 1; i >= 0; i--) {
      const q = this.goos[i];
      q.life -= dt;
      q.y += dt * (8 + (GOO_LIFE - q.life) * 10);
      q.g.position.set(q.x, q.y);
      q.g.alpha = Math.min(1, q.life / 0.8);
      if (q.drips.length) {
        // drips: a trickle down from the blob (redrawn as part of it)
        for (const d of q.drips) d.y += d.v * dt;
      }
      if (q.life <= 0) { q.g.destroy(); this.goos.splice(i, 1); continue; }
      if (Math.random() < dt * 4) {
        const d = q.drips[(Math.random() * q.drips.length) | 0];
        if (d) q.g.roundRect(d.x - d.r / 2, d.y - d.r, d.r, d.r * 2.2, d.r / 2).fill({ color: 0xfafaf2, alpha: 0.9 });
      }
    }
    // with no panels behind them, the help and the scoreboard would run into each other
    if (this.board.visible) this.help.visible = false;
    this.binEdge.visible = this.binEdge.alpha > 0.01;
    const pulse = 1 + Math.sin(performance.now() / 160) * 0.03;
    this.big.scale.set(pulse);
    if (this.bigIcon.visible) this.bigIcon.rotation = Math.sin(performance.now() / 300) * 0.12;
  }

  /** Every text drawn at the HUD's scale, not stretched to it (a cheap walk: it only redraws a text whose resolution changed). */
  private sharpen(node: Container) {
    if (node instanceof Text) {
      if (node.resolution !== this.res) node.resolution = this.res;
      return;
    }
    for (const c of node.children) this.sharpen(c);
  }
}
