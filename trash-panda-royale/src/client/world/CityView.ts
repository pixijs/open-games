import { BatchedMesh3D, Container3D, CubeGeometry, Material3D, Matrix4, Mesh3D, PointLight, Quaternion, RenderPassBit, SphereGeometry } from "@pixi/3d";
import {
  CITY, SolidTag, makeBox, mulberry32, placeParts, segmentHitsBox, segmentHitsRamp, thin, type Box, type Crossing, type Pit, type Placement,
  type Ramp,
} from "../../shared/map.js";
import { areaAt, lookAt, pickAt, type AreaKey, type Look } from "../../shared/districts.js";
import { KIT } from "../../shared/kit.js";
import { distPointLine, distPointPoly, inPoly, lineAt, makeLine } from "../../shared/geom.js";
import { EDGE_ALLEY, EDGE_SPOKE } from "../../shared/layout.js";
import { buildRoadGround, cobbledStreets, HEIGHTS, type GroundLayers } from "./Ground.js";
import { RAIL_HALF, TRACK_LENGTH, trackPoint, trainEta, type PathPoint } from "../../shared/train.js";
import { fadeClone, find, forEachMesh, groundTexture, instance, materialName, type GROUND_TEXTURES } from "../assets.js";
import { billboardTexture } from "../gfx/Billboard.js";
import { decal, decalAtlas, decalCell, type DecalCell } from "../gfx/Decals.js";
import { MeshBuilder } from "../gfx/MeshBuilder.js";
import type { Texture } from "pixi.js";
import { sfx } from "../Sfx.js";

const C = {
  grass: 0x8fd16a,
  grassDark: 0x7cc35a,
  asphalt: 0x4f5566,
  asphaltDark: 0x535867,
  sidewalk: 0xe2cfb4,
  curb: 0xc9b597,
  paving: 0xecd9bd,
  plaza: 0xf6d7b0,
  plazaTile: 0xefc89a,
  lane: 0xfff6d5,
  stripe: 0xffffff,
  yellow: 0xffcf3f,
  ballast: 0xb4a796,
  sleeper: 0x8a5a3c,
  rail: 0x9aa3b5,
  lot: 0x6a6f7e,
};

/** What can go up on a wall: posters and graffiti. */
const POSTERS: DecalCell[] = ["poster_wanted", "poster_lost_sandwich", "poster_beware", "poster_donut_day", "poster_yard_sale", "poster_vote_bandit"];
const GRAFFITI: DecalCell[] = [
  "graffiti_trash_is_life", "graffiti_raccoons_rule", "graffiti_paws", "graffiti_nom", "graffiti_heart", "graffiti_crown", "graffiti_bandit", "graffiti_wow",
];
const WALL_DECALS: DecalCell[] = [...POSTERS, ...GRAFFITI];
/**
 * Each district's walls: what goes up on them and how much of the free wall gets something
 * (Raccoon Run is covered in graffiti; Maple Close has a yard sale poster or two).
 */
const WALLS_BY_AREA: Record<AreaKey, { cells: DecalCell[]; fill: number }> = {
  maple: { cells: ["poster_yard_sale", "poster_lost_sandwich", "poster_vote_bandit"], fill: 0.25 },
  oldtown: { cells: POSTERS, fill: 0.4 },
  downtown: { cells: [...POSTERS, "graffiti_wow", "graffiti_crown"], fill: 0.5 },
  plaza: { cells: WALL_DECALS, fill: 0.55 },
  run: { cells: GRAFFITI, fill: 0.9 },
  mill: { cells: [...GRAFFITI, "poster_wanted", "poster_beware"], fill: 0.65 },
};
/** Oil drums' paint (the mill yard's own are in kit.json). */
const DRUMS = [0x3d6fb0, 0xc0452f, 0x5a8f4a, 0xd9a62e];
/** Which material is a model's foliage (painted per district). */
const FOLIAGE: Record<string, string> = { tree_round: "Leaves", tree_pine: "PineLeaves", bush: "Bush" };
/** Bunting's flags, in turn. */
const FLAGS = [0xff5a5a, 0xffd23f, 0x3fa9ff, 0x5ad16a, 0xff7fc4, 0xffffff];
/** A roof's colour in a district: shingles on the pitched ones, the tar's tint on the flat ones (the donut keeps its own). */
function roofTint(model: string, look: Look, x: number, z: number): number | undefined {
  if (model === "bld_house" || model === "bld_collapsed" || model === "bld_demolished" || model === "lm_clocktower") return pickAt(look.shingles, x, z, 3);
  if (model === "bld_shop" || model === "bld_apartment" || model === "bld_tower") return look.tar;
  return undefined;
}

/** How see-through a building gets while it hides the player. */
const FADE_ALPHA = 0.1;
/** How far under its roof (a frame's sink, a landing at roof level) someone still counts as on it, m. */
const ON_ROOF_SLACK = 0.25;
/** Top of a station's canopy (bld_station). */
const STATION_CANOPY_TOP = 4.22;
/** Half a turn about a node's own Z axis. */
const HALF_TURN_Z = new Quaternion().setFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI);

interface Occluder {
  node: Container3D;
  model: string;
  minX: number; minZ: number; maxX: number; maxZ: number; top: number;
  /** Up off the ground (a billboard's panel): its underside, where its shadow proxy starts. */
  base?: number;
  /** Turned (a building facing a street off the axes): its footprint in its own frame. */
  rot?: { cx: number; cz: number; hx: number; hz: number; c: number; s: number };
  /**
   * What can hide the player: its walls, roof, awnings, landings (its colliders, not its
   * bounds, so the air in a roofless ruin or over a gable's eaves hides nobody).
   */
  boxes: Box[];
  ramps: Ramp[];
  /** Where you stand on its roof: on it (or jumping over it), it's the floor and stays solid. */
  roof?: number;
  /** Current opacity (1 = solid). */
  alpha: number;
  /** Seconds left before a building that stopped hiding the player turns solid again. */
  hold: number;
  /** Shadow proxy slot, active while the real building is see-through. */
  slot: number;
  faded: boolean;
  /** Each mesh's shared opaque material and its see-through copy (built on first fade). */
  swap: { mesh: Mesh3D; opaque: Material3D; clear: Material3D; cast: boolean }[] | null;
  clears: Material3D[];
}

/** Does the segment a→b pass through any of the occluder's pieces? */
function segmentHitsOccluder(ax: number, ay: number, az: number, bx: number, by: number, bz: number, o: Occluder): boolean {
  for (const b of o.boxes) if (segmentHitsBox(b, ax, ay, az, bx, by, bz)) return true;
  for (const r of o.ramps) if (segmentHitsRamp(r, ax, ay, az, bx, by, bz)) return true;
  return false;
}

/** Is (x, z) over the occluder's footprint? */
function overFootprint(o: Occluder, x: number, z: number): boolean {
  const r = o.rot;
  if (!r) return x >= o.minX && x <= o.maxX && z >= o.minZ && z <= o.maxZ;
  const dx = x - r.cx, dz = z - r.cz;
  return Math.abs(dx * r.c - dz * r.s) <= r.hx && Math.abs(dx * r.s + dz * r.c) <= r.hz;
}

/** A building's own colliders that can hide someone: not the planters by its door, a chimney, a post. */
function hidingParts(parts: { boxes: Box[]; ramps: Ramp[] }) {
  return { boxes: parts.boxes.filter((b) => b.tag !== SolidTag.Prop && !thin(b)), ramps: parts.ramps.filter((r) => r.solid) };
}

interface CrossingView {
  c: Crossing;
  arms: Container3D[];
  lights: { mat: Material3D; side: number }[];
  /** A red glow that pulses on the asphalt while a train is due (readable from above). */
  glow: PointLight;
  open: number;
}

export class CityView {
  readonly root = new Container3D({ label: "city" });
  private crossings: CrossingView[] = [];
  private occluders: Occluder[] = [];
  /** The colliders of whatever is see-through right now: what's behind them is in sight. */
  readonly seeThrough = new Set<Box | Ramp>();
  private shadowProxies!: BatchedMesh3D;
  private time = 0;
  /** Models not (yet) baked: their set pieces are drawn from their colliders instead. */
  private missing = new Set<string>();
  /** The crane's swaying jib and wrecking ball (if its model has them). */
  private crane: { jib: Container3D | null; ball: Container3D | null } | null = null;
  /** Each lamp post's top (the part a car knocks over), by index into `CITY.poles`. */
  readonly lampPosts: (Container3D | null)[] = [];
  /** Every prop's node, by index into `CITY.props` (street furniture gets knocked about: `KnockView`). */
  readonly props: Container3D[] = [];
  /** The billboards' faces (the poster). */
  private adMaterial: Material3D | null = null;
  /** The landmarks' moving parts: the clock's hands, the mast's light, the sign's neon, the swing, the chimney's smoke. */
  private hands: { node: Container3D; rest: Quaternion; spin: Quaternion; hour: boolean }[] = [];
  private beacons: Material3D[] = [];
  private neon: { mat: Material3D; phase: number; strength: number }[] = [];
  private swing: { node: Container3D; rest: Quaternion; tilt: Quaternion } | null = null;
  private smoke: { x: number; y: number; z: number; puffs: { mesh: Mesh3D; mat: Material3D; t: number }[] } | null = null;

  constructor() {
    this.buildRoadGround();
    this.buildRoadDecals();
    this.buildRails();
    this.placeModels();
    this.buildKit();
    this.buildDressing();
    this.buildBunting();
    this.buildShadowProxies();
  }

  /** The ground of the town on a street graph (see Ground.ts). */
  private buildRoadGround() {
    const L: GroundLayers = {
      grass: new MeshBuilder(3), paving: new MeshBuilder(4), plaza: new MeshBuilder(3), lot: new MeshBuilder(6), asphalt: new MeshBuilder(5), dirt: new MeshBuilder(1.5),
    };
    buildRoadGround(L);
    // station ramps
    for (const r of CITY.ramps) if (!r.model && !r.solid) L.paving.slope(r, C.curb);
    // the layers drawn top first: the ground under them is hidden by the depth test before it's shaded
    this.addLayer(L.asphalt, "asphalt");
    this.addLayer(L.lot, "lot");
    this.addLayer(L.plaza, "plaza");
    this.addLayer(L.dirt, "ballast");
    this.addLayer(L.paving, "paving");
    this.addLayer(L.grass, "grass");
  }

  /**
   * Pictures on the ground, from the decal sheet in one blended layer (only the paint shows), laid
   * along the street graph (seeded: every client paints the same town; none overlaps another, the
   * markings that mean something going down first): patches, oil, drains at the kerb, lane
   * arrows before junctions, RACCOON XING, paw trails on the sidewalks, TRASH ZONE in the lots,
   * soot round the burnt-out shell. No painted manholes: every manhole on a street is a real one
   * you can go down (SewerView).
   */
  private buildRoadDecals() {
    const b = new MeshBuilder(1);
    const rand = mulberry32(0x7a5c1e);
    const wanted: { x: number; z: number; yaw: number; h: number; w: number; y: number; c: DecalCell; keep: boolean; tint?: number }[] = [];
    const add = (p: { x: number; z: number }, yaw: number, h: number, w: number, y: number, c: DecalCell, keep = false, tint?: number) =>
      wanted.push({ x: p.x, z: p.z, yaw, h, w, y, c, keep, tint });
    const { edges, nodes } = CITY.roads;
    const pt = { x: 0, z: 0, dx: 0, dz: 0 };
    const A = HEIGHTS.asphaltDecal;
    const cobbled = cobbledStreets();
    edges.forEach((e, ei) => {
      if (e.flags & EDGE_ALLEY || e.half < 3.5) return;
      const line = makeLine(e.pts);
      const s0 = nodes[e.a].r + 2, s1 = e.len - nodes[e.b].r - 2;
      if (s1 - s0 < 6) return;
      const at = (s: number, off: number) => {
        lineAt(line, s, pt);
        return { x: pt.x - pt.dz * off, z: pt.z + pt.dx * off, yaw: Math.atan2(pt.dx, pt.dz) };
      };
      const segs = Math.max(1, Math.round((s1 - s0) / 30));
      // (no asphalt patches on cobbles; Millside's streets are the most patched and oil-stained)
      const mid = at((s0 + s1) / 2, 0), side = e.half + e.walk + 1;
      const mill = areaAt(mid.x + Math.cos(mid.yaw) * side, mid.z - Math.sin(mid.yaw) * side) === "mill" || areaAt(mid.x - Math.cos(mid.yaw) * side, mid.z + Math.sin(mid.yaw) * side) === "mill";
      const worn = cobbled[ei] ? 0 : mill ? 2 : 1;
      for (let k = 0; k < segs; k++) {
        const a = s0 + ((s1 - s0) * k) / segs, z = s0 + ((s1 - s0) * (k + 1)) / segs;
        for (let w = 0; w < worn; w++) {
          if (rand() < 0.4) { const p = at(a + rand() * (z - a), (rand() < 0.5 ? -1 : 1) * 2.5); add(p, rand() * 6.28, 2.2, 2.2, A, "decal_patch"); }
          if (rand() < 0.35) { const p = at(a + rand() * (z - a), (rand() < 0.5 ? -1 : 1) * 2.4); add(p, rand() * 6.28, 1.6, 1.6, A, "decal_oil"); }
        }
        if (rand() < 0.5) { const p = at(a + 2 + rand() * Math.max(0, z - a - 4), (rand() < 0.5 ? -1 : 1) * (e.half - 0.45)); add(p, p.yaw + Math.PI / 2, 0.7, 1.4, A, "decal_drain", true); }
      }
      if (e.flags & EDGE_SPOKE) return;
      // a lane arrow before a junction, pointing the way its lane drives (right-hand traffic)
      if (rand() < 0.45 && nodes[e.b].edges.length >= 3) { const p = at(s1 - 3, 2.5); add(p, p.yaw + Math.PI, 2.2, 1.1, A, "decal_arrow", true); }
      if (rand() < 0.45 && nodes[e.a].edges.length >= 3) { const p = at(s0 + 3, -2.5); add(p, p.yaw, 2.2, 1.1, A, "decal_arrow", true); }
      if (rand() < 0.12) { const p = at(s1 - 8, 2.5); add(p, 0, 2.4, 2.4, A, "decal_raccoon_xing", true); }
    });
    // paw-print trails across the sidewalks (Raccoon Run's are covered in them)
    const runNav = CITY.nav.filter((n) => areaAt(n.x, n.z) === "run");
    for (let k = 0; k < 80; k++) {
      const pool = k < 50 || !runNav.length ? CITY.nav : runNav;
      const node = pool[Math.floor(rand() * pool.length)];
      add({ x: node.x + (rand() - 0.5) * 2, z: node.z + (rand() - 0.5) * 2 }, rand() * 6.28, 1.8, 1.8, HEIGHTS.pawDecal, "decal_paw_trail");
    }
    // TRASH ZONE stencils in the parking lots
    for (const l of CITY.lots) {
      const cx = (l.minX + l.maxX) / 2, cz = (l.minZ + l.maxZ) / 2;
      add({ x: cx, z: cz }, l.yaw ?? 0, 3.2, 3.2, HEIGHTS.lotDecal, "decal_trash_zone", true);
      add({ x: cx + (rand() - 0.5) * 6, z: cz + (rand() - 0.5) * 6 }, rand() * 6.28, 1.6, 1.6, HEIGHTS.lotDecal, "decal_oil");
    }
    // soot round the burnt-out shell and the demolition site (stains, tinted dark)
    for (const sp of CITY.setPieces) {
      if (sp.kind !== "shell" && sp.kind !== "demolition" && sp.kind !== "millyard") continue;
      for (let k = 0; k < 7; k++) {
        const a = rand() * 6.28, d = 4 + rand() * 4;
        add({ x: sp.x + Math.cos(a) * d, z: sp.z + Math.sin(a) * d }, rand() * 6.28, 2.6, 2.6, HEIGHTS.pawDecal, "decal_oil", false, 0x2b2340);
      }
    }
    // what lies at the kerb's height (paw trails, soot) stays off the streets and the lots: they'd
    // hide the half of it that reaches them
    const lines = edges.map((e) => makeLine(e.pts));
    const lots = CITY.lots.map((l) => l.poly ?? [{ x: l.minX, z: l.minZ }, { x: l.maxX, z: l.minZ }, { x: l.maxX, z: l.maxZ }, { x: l.minX, z: l.maxZ }]);
    const underfoot = (x: number, z: number, r: number) =>
      edges.some((e, i) => !(e.flags & EDGE_ALLEY) && e.half > 0 && distPointLine(x, z, lines[i]) < e.half + r)
      || lots.some((poly) => inPoly(poly, x, z) || distPointPoly(poly, x, z) < r);
    const placed: { x: number; z: number; r: number }[] = [];
    for (const d of [...wanted.filter((d) => d.keep), ...wanted.filter((d) => !d.keep)]) {
      const r = Math.hypot(d.w, d.h) / 2;
      if (d.y === HEIGHTS.pawDecal && underfoot(d.x, d.z, r)) continue;
      if (placed.some((o) => (o.x - d.x) ** 2 + (o.z - d.z) ** 2 < (o.r + r) ** 2)) continue;
      placed.push({ x: d.x, z: d.z, r });
      b.decal(d.x, d.z, d.yaw, d.h, d.w, d.y, decalCell(d.c), d.tint);
    }
    this.addLayer(b, decalAtlas(), true);
  }

  /**
   * The steel stairs and fire escapes (from their ramps), their landings, the planks between roofs
   * (from their boxes), and, for a mishap whose model isn't baked, its colliders as plain blocks.
   */
  private buildKit() {
    const steel = new MeshBuilder(1), wood = new MeshBuilder(1), rough = new MeshBuilder(1.5);
    const STEEL = 0x3f4655, RAIL = 0x2c313d, PLANK = 0x9b6a42, RUBBLE = 0xa89c8e;
    for (const r of CITY.ramps) {
      if (!r.stairs) continue;
      // treads every ~22 cm of rise, each with a riser plate at its sides
      const rise = r.h1 - r.h0, n = Math.max(2, Math.round(Math.abs(rise) / 0.22)), run = (2 * r.hz) / n;
      const yaw = Math.atan2(r.s, r.c);
      const at = (lx: number, lz: number) => ({ x: r.cx + lx * r.c + lz * r.s, z: r.cz - lx * r.s + lz * r.c });
      for (let i = 0; i < n; i++) {
        const lz = -r.hz + (i + 0.5) * run, top = r.h0 + (rise * (i + 1)) / n;
        const p = at(0, lz);
        steel.obox(p.x, p.z, yaw, r.hx - 0.06, run / 2 + 0.01, top - 0.05, top, STEEL);
        for (const sd of [-1, 1]) {
          const q = at(sd * (r.hx - 0.03), lz);
          steel.obox(q.x, q.z, yaw, 0.03, run / 2 + 0.01, Math.max(r.h0, top - 0.32) - 0.02, top + 0.02, RAIL);
          // a handrail post every other step, the rail along their tops
          if (i % 2 === 0) steel.obox(q.x, q.z, yaw, 0.025, 0.025, top, top + 0.95, RAIL);
          steel.obox(q.x, q.z, yaw, 0.03, run / 2 + 0.02, top + 0.9, top + 0.96, RAIL);
        }
      }
    }
    // (a building's own landings, the apartments' balconies, are in its model)
    const modelled = new Set(CITY.buildings.flatMap((bl) => bl.parts?.boxes ?? []));
    for (const b of CITY.boxes) {
      const yaw = b.rot ? Math.atan2(b.rot.s, b.rot.c) : 0;
      const cx = b.rot ? b.rot.cx : (b.minX + b.maxX) / 2, cz = b.rot ? b.rot.cz : (b.minZ + b.maxZ) / 2;
      const hx = b.rot ? b.rot.hx : (b.maxX - b.minX) / 2, hz = b.rot ? b.rot.hz : (b.maxZ - b.minZ) / 2;
      if (b.tag === SolidTag.Plank) {
        // boards along it, with battens across
        const along = hx > hz, len = Math.max(hx, hz), w = Math.min(hx, hz);
        for (const o of [-w * 0.62, 0, w * 0.62]) {
          const ox = along ? 0 : o, oz = along ? o : 0;
          const p = { x: cx + ox * Math.cos(yaw) + oz * Math.sin(yaw), z: cz - ox * Math.sin(yaw) + oz * Math.cos(yaw) };
          // (a few cm over the collider: where it rests on a roof, not level with the roof's own surface)
          wood.obox(p.x, p.z, yaw, along ? len : w * 0.3, along ? w * 0.3 : len, b.top - 0.03, b.top + 0.04, PLANK);
        }
        for (const t of [-0.7, 0.7]) {
          const ox = along ? t * (len - 0.5) : 0, oz = along ? 0 : t * (len - 0.5);
          const p = { x: cx + ox * Math.cos(yaw) + oz * Math.sin(yaw), z: cz - ox * Math.sin(yaw) + oz * Math.cos(yaw) };
          wood.obox(p.x, p.z, yaw, along ? 0.08 : w, along ? w : 0.08, b.top - 0.08, b.top - 0.02, 0x6e4a2e);
        }
      } else if (b.tag === SolidTag.Landing && b.base !== undefined && b.top - b.base < 0.25 && !modelled.has(b)) {
        // a fire escape's (or a flight's) landing: a steel grating with a rail round its open sides
        steel.obox(cx, cz, yaw, hx, hz, b.top - 0.06, b.top, STEEL);
        for (const [lx, lz] of [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz]]) {
          const p = { x: cx + lx * Math.cos(yaw) + lz * Math.sin(yaw), z: cz - lx * Math.sin(yaw) + lz * Math.cos(yaw) };
          steel.obox(p.x, p.z, yaw, 0.03, 0.03, b.top - 1.2, b.top + 0.95, RAIL);
        }
      }
    }
    // mishaps whose models aren't there: their colliders, plainly
    const tags = new Set<number>([SolidTag.Rubble, SolidTag.Slab, SolidTag.Wall, SolidTag.Debris, SolidTag.Crane, SolidTag.Barrier]);
    const anyMissing = ["bld_demolished", "bld_collapsed", "bld_shell", "sinkhole", "crane"].some((m) => this.missing.has(m));
    if (anyMissing) {
      for (const b of CITY.boxes) {
        if (b.tag === undefined || !tags.has(b.tag)) continue;
        const yaw = b.rot ? Math.atan2(b.rot.s, b.rot.c) : 0;
        const cx = b.rot ? b.rot.cx : (b.minX + b.maxX) / 2, cz = b.rot ? b.rot.cz : (b.minZ + b.maxZ) / 2;
        const hx = b.rot ? b.rot.hx : (b.maxX - b.minX) / 2, hz = b.rot ? b.rot.hz : (b.maxZ - b.minZ) / 2;
        rough.obox(cx, cz, yaw, hx, hz, b.base ?? 0, b.top, b.tag === SolidTag.Crane ? 0xf2c230 : b.tag === SolidTag.Barrier ? 0xe8573f : RUBBLE);
      }
      for (const r of CITY.ramps) if (r.solid && !r.stairs && (r.tag === SolidTag.Rubble || r.tag === SolidTag.Slab)) rough.slope(r, RUBBLE);
    }
    // a landmark whose model isn't there: its colliders, plainly (brick-ish)
    for (const sp of CITY.setPieces) {
      const kit = KIT.setpieces[sp.kind];
      if (!kit?.models?.some((m) => m.model.startsWith("lm_") && this.missing.has(m.model))) continue;
      const own = { boxes: [] as Box[], ramps: [] as Ramp[], pits: [] as Pit[] };
      placeParts(kit, sp.x, sp.z, sp.yaw, own);
      for (const b of own.boxes) {
        const yaw = b.rot ? Math.atan2(b.rot.s, b.rot.c) : 0;
        const cx = b.rot ? b.rot.cx : (b.minX + b.maxX) / 2, cz = b.rot ? b.rot.cz : (b.minZ + b.maxZ) / 2;
        const hx = b.rot ? b.rot.hx : (b.maxX - b.minX) / 2, hz = b.rot ? b.rot.hz : (b.maxZ - b.minZ) / 2;
        rough.obox(cx, cz, yaw, hx, hz, b.base ?? 0, b.top, b.tag === SolidTag.Sign ? 0xd36fe3 : 0xc8846a);
      }
    }
    // a pit whose model isn't there: its walls and floor (the ground has a hole in it)
    if (this.missing.has("sinkhole")) {
      for (const q of CITY.pits) {
        const t = 0.3;
        rough.rect(q.minX, q.minZ, q.maxX, q.maxZ, q.floor, 0x6b5640);
        rough.obox(q.cx, q.minZ - t / 2, 0, (q.maxX - q.minX) / 2 + t, t / 2, q.floor, 0.02, 0x8a6e52);
        rough.obox(q.cx, q.maxZ + t / 2, 0, (q.maxX - q.minX) / 2 + t, t / 2, q.floor, 0.02, 0x8a6e52);
        rough.obox(q.minX - t / 2, q.cz, 0, t / 2, (q.maxZ - q.minZ) / 2, q.floor, 0.02, 0x8a6e52);
        rough.obox(q.maxX + t / 2, q.cz, 0, t / 2, (q.maxZ - q.minZ) / 2, q.floor, 0.02, 0x8a6e52);
      }
    }
    this.addLayer(steel, null, false, true);
    this.addLayer(wood, "wood", false, true);
    this.addLayer(rough, "ballast", false, true);
  }

  /**
   * One invisible box per building that only draws into the shadow map. It stands in for
   * the building while the camera sees through it (blended meshes cast no shadow), so
   * the world's shadows never change because of a camera aid.
   */
  private buildShadowProxies() {
    const cube = new CubeGeometry({ width: 1, height: 1, depth: 1 });
    const mat = new Material3D({ baseColor: 0x000000 });
    const m = new Matrix4(), t = new Matrix4();
    this.shadowProxies = new BatchedMesh3D({ size: this.occluders.length });
    const q = new Quaternion();
    for (const o of this.occluders) {
      this.shadowProxies.setGeometryAt(o.slot, cube);
      this.shadowProxies.setMaterialAt(o.slot, mat);
      const y0 = o.base ?? 0, h = o.top - y0;
      if (o.rot) {
        m.makeTranslation(o.rot.cx, y0 + h / 2, o.rot.cz);
        m.multiply(t.makeRotationFromQuaternion(q.setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.atan2(o.rot.s, o.rot.c))));
        m.multiply(t.makeScale(o.rot.hx * 2 - 0.1, h, o.rot.hz * 2 - 0.1));
      } else {
        m.makeTranslation((o.minX + o.maxX) / 2, y0 + h / 2, (o.minZ + o.maxZ) / 2);
        m.multiply(t.makeScale(o.maxX - o.minX - 0.1, h, o.maxZ - o.minZ - 0.1));
      }
      this.shadowProxies.setMatrixAt(o.slot, m);
      this.shadowProxies.setPassesAt(o.slot, RenderPassBit.SHADOW);
      this.shadowProxies.setVisibleAt(o.slot, false);
    }
    this.root.addChild(this.shadowProxies);
  }

  /**
   * Swap a building to its see-through materials (or back). Only the few buildings
   * between the camera and the player ever swap; the rest of the city keeps its shared,
   * batched opaque materials. The clones are cached per building, so fading again is
   * just a swap.
   */
  private setFaded(o: Occluder, on: boolean) {
    if (o.faded === on) return;
    o.faded = on;
    for (const p of [...o.boxes, ...o.ramps]) {
      if (on) this.seeThrough.add(p);
      else this.seeThrough.delete(p);
    }
    if (!o.swap) {
      const clones = new Map<Material3D, Material3D>();
      o.swap = [];
      forEachMesh(o.node, (mesh) => {
        if (!(mesh.material instanceof Material3D)) return;
        let clear = clones.get(mesh.material);
        if (!clear) clones.set(mesh.material, (clear = fadeClone(mesh.material)));
        o.swap!.push({ mesh, opaque: mesh.material, clear, cast: mesh.castShadow });
      });
      o.clears = [...clones.values()];
    }
    for (const s of o.swap) {
      s.mesh.material = on ? s.clear : s.opaque;
      // (blended meshes cast no shadow: the proxy box casts it instead)
      s.mesh.castShadow = on ? false : s.cast;
    }
    this.shadowProxies.setVisibleAt(o.slot, on);
  }

  /**
   * One vertex-coloured, textured layer of the ground: every layer shares one shader
   * program (vertex colours × a repeating detail texture), so splitting the ground by
   * surface costs a few draw calls, not shader compiles.
   */
  private addLayer(b: MeshBuilder, tex: (typeof GROUND_TEXTURES)[number] | Texture | null, blend = false, castShadow = false) {
    if (!b.vertexCount) return;
    const map = tex === null ? undefined : typeof tex === "string" ? groundTexture(tex) : tex;
    const material = new Material3D({ baseColor: 0xffffff, roughness: 0.95, metallic: 0, baseColorTexture: map, alphaMode: blend ? "blend" : "opaque", vertexColors: true });
    this.root.addChild(new Mesh3D({ geometry: b.build(), material, castShadow, receiveShadow: true }));
  }

  /**
   * Posters and graffiti on the buildings: each model marks the free bits of its walls with
   * `decal_slot_*` nodes (+Z out of the wall, scaled to the free area); about half of them
   * get a picture. Children of the building, so they fade with it.
   */
  private placeWallDecals(node: Container3D, seed: number, area: AreaKey | null) {
    const rand = mulberry32(seed);
    const slots: Container3D[] = [];
    const scan = (n: Container3D) => { if ((n.label ?? "").startsWith("decal_slot")) slots.push(n); for (const c of n.children) scan(c as Container3D); };
    scan(node);
    const { cells, fill } = area ? WALLS_BY_AREA[area] : { cells: WALL_DECALS, fill: 0.55 };
    for (const slot of slots) {
      if (rand() > fill) continue;
      const cell = cells[Math.floor(rand() * cells.length)];
      const c = decalCell(cell);
      // fit inside the slot (its scale is the free area in metres), keeping the picture's shape
      const sw = slot.scale.x, sh = slot.scale.y;
      const hgt = Math.min(sh, sw / c.aspect) * (0.75 + rand() * 0.25);
      const d = decal(cell, 1);
      d.scale.set((hgt * c.aspect) / sw, hgt / sh, 1);
      d.rotation.set(0, 0, (rand() - 0.5) * 0.12); // stuck on a bit crooked
      slot.addChild(d);
    }
  }

  /**
   * Ads painted on a roof (`roofad_*` nodes: +Z out of the roof, +Y the text's up) read
   * right way up from the north-up camera: one whose text would point down the screen
   * (toward +Z) turns half a turn in place. The same model sits at several rotations.
   */
  private uprightRoofAds(node: Container3D) {
    const ads: Container3D[] = [];
    const scan = (n: Container3D) => { if ((n.label ?? "").startsWith("roofad_")) ads.push(n); for (const c of n.children) scan(c as Container3D); };
    scan(node);
    for (const ad of ads) {
      const o = ad.toGlobal({ x: 0, y: 0, z: 0 }), up = ad.toGlobal({ x: 0, y: 1, z: 0 });
      if (up.z - o.z > 0.01) ad.quaternion.multiply(HALF_TURN_Z);
    }
  }

  /** A shop model carries several signs (`shopsign_*`) in the same spot: each shop shows one. */
  private pickShopSign(node: Container3D, seed: number) {
    const signs: Container3D[] = [];
    const scan = (n: Container3D) => { if ((n.label ?? "").startsWith("shopsign_")) signs.push(n); for (const c of n.children) scan(c as Container3D); };
    scan(node);
    if (!signs.length) return;
    const keep = Math.floor(mulberry32(seed)() * signs.length);
    signs.forEach((s, i) => { s.visible = i === keep; });
  }

  private buildRails() {
    const ballast = new MeshBuilder(1.5), sleepers = new MeshBuilder(1), rails = new MeshBuilder(1);
    const p: PathPoint = { x: 0, z: 0, dx: 0, dz: 0 };
    const seg = 2;
    for (let s = 0; s < TRACK_LENGTH; s += seg) {
      trackPoint(s + seg / 2, p);
      const yaw = Math.atan2(p.dx, p.dz);
      ballast.quad(p.x, p.z, yaw, seg + 0.05, 3.4, 0.06, C.ballast);
      // two rails
      const lx = Math.cos(yaw), lz = -Math.sin(yaw);
      for (const side of [-0.75, 0.75]) {
        rails.box(p.x + lx * side, p.z + lz * side, yaw, seg + 0.04, 0.12, 0.14, 0.3, C.rail);
      }
    }
    for (let s = 0; s < TRACK_LENGTH; s += 1.1) {
      trackPoint(s, p);
      sleepers.box(p.x, p.z, Math.atan2(p.dx, p.dz), 0.32, 2.5, 0.06, 0.15, C.sleeper);
    }
    this.addLayer(ballast, "ballast");
    this.addLayer(sleepers, "wood");
    this.addLayer(rails, null);
  }

  private placeModels() {
    for (const bl of CITY.buildings) {
      const look = lookAt(bl.x, bl.z);
      const recolor: Record<string, number> = { Wall: bl.tint ?? 0xffffff };
      const roof = look ? roofTint(bl.model, look, bl.x, bl.z) : undefined;
      if (roof !== undefined) recolor.Roof = roof;
      const m = instance(bl.model, { recolor });
      m.position.set(bl.x, 0, bl.z);
      m.rotation.set(0, bl.rot, 0);
      this.root.addChild(m);
      this.placeWallDecals(m, Math.round(bl.x * 7919 + bl.z * 104729), areaAt(bl.x, bl.z));
      this.pickShopSign(m, Math.round(bl.x * 104729 + bl.z * 7919));
      if (bl.model === "lm_clocktower") this.clockHands(m);
      if (bl.model === "lm_millyard") this.chimneySmoke(m);
      if (bl.box) {
        const turned = bl.fade && Math.abs(Math.sin(bl.rot * 2)) > 1e-6;
        // (round the middle of its footprint, which can be off the model's origin: the old mill's boiler house)
        const cx = (bl.box.minX + bl.box.maxX) / 2, cz = (bl.box.minZ + bl.box.maxZ) / 2;
        const rot = turned ? { cx, cz, hx: bl.fade!.hx, hz: bl.fade!.hz, c: Math.cos(bl.rot), s: Math.sin(bl.rot) } : undefined;
        // (no colliders recorded: its bounds, a column from the ground)
        const parts = hidingParts(bl.parts ?? { boxes: [bl.box], ramps: [] });
        this.occluders.push({
          node: m, model: bl.model, ...bl.box, rot, ...parts, roof: bl.roof,
          alpha: 1, hold: 0, slot: this.occluders.length, faded: false, swap: null, clears: [],
        });
      }
      if (m.label?.endsWith("-missing")) this.missing.add(bl.model);
    }
    for (const st of CITY.stations) {
      const m = instance("bld_station");
      m.position.set(st.x, 0, st.z);
      m.rotation.set(0, st.rot, 0);
      this.root.addChild(m);
      this.uprightRoofAds(m);
      // the canopy hides whoever waits on the platform: it fades like a building (the
      // platform stays solid underfoot), and the ads painted on it fade along
      const canopy = find(m, "canopy");
      if (canopy) {
        for (const ad of [...(canopy.parent?.children ?? [])]) if ((ad.label ?? "").startsWith("roofad_")) canopy.reparentChild(ad as Container3D);
        const column: Box = { minX: st.minX, minZ: st.minZ, maxX: st.maxX, maxZ: st.maxZ, top: STATION_CANOPY_TOP };
        this.occluders.push({
          node: canopy, model: "bld_station", ...column, boxes: [column], ramps: [],
          alpha: 1, hold: 0, slot: this.occluders.length, faded: false, swap: null, clears: [],
        });
      }
    }

    // crossing furniture is animated: group it per crossing
    const crossingOf = (x: number, z: number) => {
      let best: CrossingView | null = null, bd = Infinity;
      for (const cv of this.crossings) {
        const d = (cv.c.x - x) ** 2 + (cv.c.z - z) ** 2;
        if (d < bd) { bd = d; best = cv; }
      }
      return best!;
    };
    for (const c of CITY.crossings) {
      const glow = new PointLight({ color: 0xff2d2d, intensity: 0, range: 9 });
      glow.visible = false; // lit only while a train is due (a dark light still costs per pixel)
      glow.position.set(c.x, 2.2, c.z);
      this.root.addChild(glow);
      this.crossings.push({ c, arms: [], lights: [], glow, open: 1 });
    }

    const props = this.props;
    for (const pr of CITY.props) {
      const unique = pr.model === "crossing_sign";
      // trees and bushes in their district's colours (Maple Close's turning, Raccoon Run's in blossom), each oil drum in its own paint
      const foliage = FOLIAGE[pr.model], look = foliage ? lookAt(pr.x, pr.z) : null;
      const leaf = !look ? undefined : pr.model === "tree_pine" ? look.pine : pickAt(look.leaves, pr.x, pr.z, 7);
      const recolor = leaf !== undefined ? { [foliage]: leaf } : pr.model === "drum" ? { DrumPaint: pr.tint ?? pickAt(DRUMS, pr.x, pr.z, 5) } : undefined;
      const m = instance(pr.model, { unique, castShadow: pr.model !== "flowerbed", ...(recolor ? { recolor } : {}) });
      if (m.label?.endsWith("-missing")) this.missing.add(pr.model);
      m.position.set(pr.x, pr.y ?? 0, pr.z);
      m.rotation.set(0, pr.rot, 0);
      if (pr.scale) m.scale.set(pr.scale);
      this.root.addChild(m);
      props.push(m);

      if (pr.model === "billboard" || pr.model === "billboard_roof") {
        this.dressBillboard(m, pr);
      } else if (pr.model === "lm_maple" || pr.model === "lm_racsign" || pr.model === "lm_mast") {
        this.dressLandmark(m, pr);
      } else if (pr.model === "crossing_barrier") {
        const arm = find(m, "barrier_arm");
        if (arm) crossingOf(pr.x, pr.z).arms.push(arm);
      } else if (pr.model === "crossing_sign") {
        const cv = crossingOf(pr.x, pr.z);
        forEachMesh(m, (mesh) => {
          const n = materialName(mesh.material);
          if ((n === "LightL" || n === "LightR") && mesh.material instanceof Material3D) {
            cv.lights.push({ mat: mesh.material, side: n === "LightL" ? 0 : 1 });
          }
        });
      }
    }
    for (const q of CITY.poles) this.lampPosts.push(find(props[q.prop], "lamp_post"));
    const crane = CITY.props.findIndex((p) => p.model === "crane");
    if (crane >= 0) this.crane = { jib: find(props[crane], "jib"), ball: find(props[crane], "ball") };
  }

  /**
   * The landmarks among the props: the big maple's canopy and the raccoon sign's board fade out of
   * the camera's way like a billboard's panel; the swing sways, the neon and the mast's light blink.
   */
  private dressLandmark(m: Container3D, pr: Placement) {
    const fadeAs = (node: Container3D | null, box: Box) => {
      if (!node) return;
      const r = box.rot;
      this.occluders.push({
        node, model: pr.model, minX: box.minX, minZ: box.minZ, maxX: box.maxX, maxZ: box.maxZ, top: box.top, base: box.base,
        rot: r ? { cx: r.cx, cz: r.cz, hx: r.hx, hz: r.hz, c: r.c, s: r.s } : undefined, boxes: [box], ramps: [],
        alpha: 1, hold: 0, slot: this.occluders.length, faded: false, swap: null, clears: [],
      });
    };
    if (pr.model === "lm_maple") {
      // (what hides someone under it: the crown's middle, not its ragged edge)
      fadeAs(find(m, "canopy"), makeBox(pr.x, pr.z, 0, 4.6, 4.6, 14.5, { base: 5.3 }));
      const sw = find(m, "swing");
      if (sw) this.swing = { node: sw, rest: new Quaternion().copyFrom(sw.quaternion), tilt: new Quaternion() };
    } else if (pr.model === "lm_racsign") {
      fadeAs(find(m, "board"), makeBox(pr.x, pr.z, pr.rot, 3.2, 0.35, 14, { base: 8.5 }));
    }
    forEachMesh(m, (mesh) => {
      const n = materialName(mesh.material);
      if (!(mesh.material instanceof Material3D) || !mesh.material.emissive) return;
      if (n === "Beacon") this.beacons.push(mesh.material);
      else if (n === "NeonA" || n === "NeonB" || n === "Bulbs") this.neon.push({ mat: mesh.material, phase: n === "NeonA" ? 0 : n === "NeonB" ? 1 : 2, strength: mesh.material.emissive.strength });
    });
  }

  /** The clock tower's hands (one pair per face): set from the real time of day in `update`. */
  private clockHands(m: Container3D) {
    const scan = (n: Container3D) => {
      const l = n.label ?? "";
      if (l.startsWith("hand_h_") || l.startsWith("hand_m_")) this.hands.push({ node: n, rest: new Quaternion().copyFrom(n.quaternion), spin: new Quaternion(), hour: l.startsWith("hand_h_") });
      for (const c of n.children) scan(c as Container3D);
    };
    scan(m);
  }

  /** The old mill's chimney smokes: a few puffs rising, swelling and thinning out, over and over. */
  private chimneySmoke(m: Container3D) {
    const top = find(m, "smoke");
    if (!top) return;
    const o = top.toGlobal({ x: 0, y: 0, z: 0 });
    const geo = new SphereGeometry({ radius: 1, widthSegments: 10, heightSegments: 7 });
    const puffs: { mesh: Mesh3D; mat: Material3D; t: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const mat = new Material3D({ baseColor: 0xe4ded6, roughness: 1, metallic: 0, alphaMode: "blend", alpha: 0.5 });
      const mesh = new Mesh3D({ geometry: geo, material: mat, castShadow: false, receiveShadow: false });
      this.root.addChild(mesh);
      puffs.push({ mesh, mat, t: i / 6 });
    }
    this.smoke = { x: o.x, y: o.y, z: o.z, puffs };
  }

  /**
   * The districts' street dressing (CITY.dressing; the solid ones are colliders too): Maple
   * Close's picket fences and hedges, Millside's crates and pallets, Downtown's
   * concrete planters, the Plaza's flag poles. A layer per surface, so a few draw calls.
   */
  private buildDressing() {
    const wood = new MeshBuilder(1), leafy = new MeshBuilder(2), metal = new MeshBuilder(1), stone = new MeshBuilder(2);
    for (const d of CITY.dressing) {
      const c = Math.cos(d.yaw), sn = Math.sin(d.yaw);
      const at = (lx: number, lz: number) => ({ x: d.x + lx * c + lz * sn, z: d.z - lx * sn + lz * c });
      const y0 = d.y ?? 0;
      switch (d.kind) {
        case "fence": {
          // pickets along its length, two rails, a post at each end
          const len = d.hx >= d.hz ? d.hx : d.hz, alongX = d.hx >= d.hz;
          const pos = (t: number, o = 0) => (alongX ? at(t, o) : at(o, t));
          const PAINT = 0xf6f3ea;
          for (let t = -len + 0.08; t <= len - 0.05; t += 0.17) { const p = pos(t); wood.obox(p.x, p.z, d.yaw, alongX ? 0.045 : 0.015, alongX ? 0.015 : 0.045, y0, y0 + d.h - ((Math.round((t + len) / 0.17) % 2) * 0.05), PAINT); }
          for (const h of [0.28, 0.64]) { const p = pos(0, -0.03); wood.obox(p.x, p.z, d.yaw, alongX ? len : 0.02, alongX ? 0.02 : len, y0 + h, y0 + h + 0.07, PAINT); }
          for (const t of [-len, len]) { const p = pos(t); wood.obox(p.x, p.z, d.yaw, 0.06, 0.06, y0, y0 + d.h + 0.08, PAINT); }
          break;
        }
        case "hedge": {
          const g = 0x3f9a4a + ((d.seed % 3) - 1) * 0x020502;
          leafy.obox(d.x, d.z, d.yaw, d.hx, d.hz, y0, y0 + d.h - 0.18, g);
          leafy.obox(d.x, d.z, d.yaw, d.hx - 0.07, d.hz - 0.07, y0 + d.h - 0.18, y0 + d.h, 0x4aa856);
          break;
        }
        case "crate": {
          // a crate per 1.2 m of height, each a little askew, with dark corner posts and bands
          const n = Math.max(1, Math.round(d.h / 1.2)), ch = d.h / n;
          for (let k = 0; k < n; k++) {
            const yaw = d.yaw + (k ? (((d.seed >> k) % 7) - 3) * 0.03 : 0), b0 = y0 + k * ch;
            const kc = Math.cos(yaw), ks = Math.sin(yaw);
            wood.obox(d.x, d.z, yaw, d.hx - 0.02, d.hz - 0.02, b0, b0 + ch - 0.01, 0xc08a52);
            for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
              const px = d.x + lx * (d.hx - 0.05) * kc + lz * (d.hz - 0.05) * ks, pz = d.z - lx * (d.hx - 0.05) * ks + lz * (d.hz - 0.05) * kc;
              // (a centimetre proud of the lid: level with it, the two would fight)
              wood.obox(px, pz, yaw, 0.07, 0.07, b0, b0 + ch, 0x8a5a32);
            }
            for (const h of [0.06, ch - 0.12]) wood.obox(d.x, d.z, yaw, d.hx, d.hz, b0 + h, b0 + h + 0.07, 0x9a6638);
          }
          break;
        }
        case "pallets": {
          for (let y = y0; y < y0 + d.h - 0.01; y += 0.15) {
            for (const o of [-d.hz + 0.08, 0, d.hz - 0.08]) { const p = at(0, o); wood.obox(p.x, p.z, d.yaw, d.hx, 0.06, y, y + 0.1, 0xb08a52); }
            wood.obox(d.x, d.z, d.yaw, d.hx, d.hz, y + 0.1, y + 0.14, 0xc9a46a);
          }
          break;
        }
        case "planter": {
          // a concrete trough (four walls) with soil in it; its tree is a prop standing on top
          const t = 0.1;
          for (const [lx, lz, hx, hz] of [[0, -d.hz + t / 2, d.hx, t / 2], [0, d.hz - t / 2, d.hx, t / 2], [-d.hx + t / 2, 0, t / 2, d.hz - t], [d.hx - t / 2, 0, t / 2, d.hz - t]]) {
            const p = at(lx, lz);
            stone.obox(p.x, p.z, d.yaw, hx, hz, y0, y0 + d.h, 0xc9cdd3);
          }
          stone.obox(d.x, d.z, d.yaw, d.hx - t, d.hz - t, y0, y0 + d.h - 0.07, 0x5e4632);
          break;
        }
        case "flagpole":
          metal.cylinder(d.x, d.z, 0.06, y0, y0 + d.h, 0xf4f4f8, 8);
          metal.cylinder(d.x, d.z, 0.14, y0 + d.h, y0 + d.h + 0.22, 0xffcf3f, 8);
          break;
        case "path":
          break; // (on the ground: Ground.ts)
      }
    }
    this.addLayer(wood, "wood", false, true);
    this.addLayer(leafy, "grass", false, true);
    this.addLayer(metal, null, false, true);
    this.addLayer(stone, "paving", false, true);
  }

  /**
   * Bunting: strings of little flags across Old Town's and the Plaza's streets, from a building's
   * front to the one facing it, and round the plaza between its flag poles.
   */
  private buildBunting() {
    const b = new MeshBuilder(1);
    const string = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, seed: number) => {
      const len = Math.hypot(bx - ax, bz - az), sag = 0.3 + len * 0.05;
      const n = Math.max(2, Math.floor(len / 0.55));
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      for (let i = 0; i < n; i++) {
        const t0 = (i + 0.15) / n, t1 = (i + 0.85) / n, tm = (t0 + t1) / 2;
        const y = (t: number) => ay + (by - ay) * t - sag * 4 * t * (1 - t);
        const p0 = [ax + (bx - ax) * t0, y(t0), az + (bz - az) * t0] as const, p1 = [ax + (bx - ax) * t1, y(t1), az + (bz - az) * t1] as const;
        const tip = [ax + (bx - ax) * tm + uz * 0.02, y(tm) - 0.42, az + (bz - az) * tm - ux * 0.02] as const;
        b.tri(p0, p1, tip, FLAGS[(i + seed) % FLAGS.length], true);
      }
    };
    // across the streets: a building and the one facing it, 10–30 m away, not too far along
    const anchor: Record<string, number> = { bld_house: 4.6, bld_shop: 4.5, bld_apartment: 4.6, bld_donut: 3.9, bld_tower: 4.6 };
    const fronts = CITY.buildings
      .filter((bl) => bl.fade && anchor[bl.model] !== undefined && (areaAt(bl.x, bl.z) === "oldtown" || areaAt(bl.x, bl.z) === "plaza"))
      .map((bl) => {
        const fx = Math.sin(bl.rot), fz = Math.cos(bl.rot);
        return { bl, fx, fz, x: bl.x + fx * (bl.fade!.hz + 0.05), z: bl.z + fz * (bl.fade!.hz + 0.05), y: anchor[bl.model], used: false };
      });
    for (const a of fronts) {
      if (a.used) continue;
      let best: (typeof fronts)[number] | null = null, bd = Infinity;
      for (const o of fronts) {
        if (o === a || o.used || a.fx * o.fx + a.fz * o.fz > -0.95) continue;
        const dx = o.x - a.x, dz = o.z - a.z, along = dx * a.fx + dz * a.fz, side = Math.abs(dx * a.fz - dz * a.fx);
        if (along < 10 || along > 30 || side > 6) continue;
        if (along + side < bd) { bd = along + side; best = o; }
      }
      if (!best) continue;
      a.used = best.used = true;
      string(a.x, a.y, a.z, best.x, best.y, best.z, Math.round(a.x * 7 + a.z * 3) & 7);
    }
    // round the plaza, pole to pole
    const poles = CITY.dressing.filter((d) => d.kind === "flagpole");
    for (let i = 0; i < poles.length; i++) {
      const p = poles[i], q = poles[(i + 1) % poles.length];
      string(p.x, p.h - 0.4, p.z, q.x, q.h - 0.4, q.z, i);
    }
    this.addLayer(b, null, false, true);
  }

  /**
   * A billboard: the poster on both faces (one material for every board: one texture, and the
   * program the GLBs' textured materials already use), and its panel fades out of the camera's
   * way like a building when it hides the player.
   */
  private dressBillboard(m: Container3D, pr: Placement) {
    this.adMaterial ??= new Material3D({ baseColor: 0xffffff, baseColorTexture: billboardTexture(), roughness: 0.8, metallic: 0, doubleSided: true });
    forEachMesh(m, (mesh) => { if (materialName(mesh.material) === "Ad") mesh.material = this.adMaterial!; });
    const panel = pr.parts?.boxes[0];
    if (!panel) return;
    const r = panel.rot;
    this.occluders.push({
      node: m, model: pr.model, minX: panel.minX, minZ: panel.minZ, maxX: panel.maxX, maxZ: panel.maxZ, top: panel.top, base: panel.base,
      rot: r ? { cx: r.cx, cz: r.cz, hx: r.hx, hz: r.hz, c: r.c, s: r.s } : undefined, boxes: [panel], ramps: [],
      alpha: 1, hold: 0, slot: this.occluders.length, faded: false, swap: null, clears: [],
    });
  }

  /**
   * Whatever stands between the camera and the player turns see-through (and solid
   * again once we're clear) so we never lose sight of the action. Only what's really in
   * the way: a wall, a roof, an awning overhead, not the air in a roofless ruin. And never
   * the building they stand on (`py`: their feet), even if something on its roof is.
   */
  updateOcclusion(dt: number, cx: number, cy: number, cz: number, px: number, py: number, pz: number) {
    const minX = Math.min(cx, px) - 2, maxX = Math.max(cx, px) + 2, minZ = Math.min(cz, pz) - 2, maxZ = Math.max(cz, pz) + 2;
    for (const o of this.occluders) {
      let hit = false, onTop = false;
      if (!(o.maxX < minX || o.minX > maxX || o.maxZ < minZ || o.minZ > maxZ)) {
        onTop = o.roof !== undefined && py > o.roof - ON_ROOF_SLACK && overFootprint(o, px, pz);
        hit = !onTop && (segmentHitsOccluder(cx, cy, cz, px, py + 0.9, pz, o) || segmentHitsOccluder(cx, cy, cz, px, py + 2.0, pz, o));
      }
      // a little hysteresis so a building at the edge of the line of sight doesn't pump (up
      // on its roof, it turns solid at once)
      o.hold = hit ? 0.6 : onTop ? 0 : Math.max(0, o.hold - dt);
      const clear = hit || o.hold > 0;
      if (!clear && !o.faded) continue;
      if (clear) this.setFaded(o, true);
      const target = clear ? FADE_ALPHA : 1;
      o.alpha += (target - o.alpha) * (1 - Math.exp(-dt * (clear ? 10 : 6)));
      if (!clear && o.alpha > 0.995) {
        o.alpha = 1;
        this.setFaded(o, false);
        continue;
      }
      for (const m of o.clears) m.alpha = o.alpha;
    }
  }

  /**
   * Loading-screen warm-up: one building of each model shown see-through for a frame,
   * so their materials (and, on WebGPU, the blended pipelines) exist before the first
   * real fade. Returns the undo.
   */
  prewarm(): () => void {
    const warmed: Occluder[] = [];
    const models = new Set<string>();
    for (const o of this.occluders) {
      if (models.has(o.model)) continue;
      models.add(o.model);
      warmed.push(o);
      this.setFaded(o, true);
      o.alpha = FADE_ALPHA;
      for (const m of o.clears) m.alpha = FADE_ALPHA;
    }
    return () => {
      for (const o of warmed) {
        o.alpha = 1;
        o.hold = 0;
        this.setFaded(o, false);
      }
    };
  }

  /** Crossing barriers + flashing lights + bells, all from the train timetable; the crane sways. */
  update(dt: number, timeMs: number, listenerX: number, listenerZ: number) {
    this.time += dt;
    if (this.crane) {
      if (this.crane.jib) this.crane.jib.rotation.set(0, Math.sin(this.time / 9) * 0.12, 0);
      if (this.crane.ball) this.crane.ball.rotation.set(Math.sin(this.time * 1.3) * 0.05, 0, Math.sin(this.time * 0.9) * 0.07);
    }
    this.updateLandmarks(dt);
    for (const cv of this.crossings) {
      const eta = trainEta(cv.c.s, timeMs, 12);
      const closing = eta < 7;
      const target = closing ? 0 : 1;
      cv.open += (target - cv.open) * Math.min(1, dt * 2.5);
      for (const arm of cv.arms) arm.rotation.set(0, 0, cv.open * 1.35);
      const blink = Math.floor(this.time * 3) % 2;
      for (const l of cv.lights) {
        if (!l.mat.emissive) continue;
        l.mat.emissive.strength = closing && l.side === blink ? 8 : 0.15;
      }
      cv.glow.intensity = closing ? (blink ? 14 : 5) : 0;
      cv.glow.visible = closing;
      if (closing && (cv.c.x - listenerX) ** 2 + (cv.c.z - listenerZ) ** 2 < 60 * 60 && Math.floor(this.time * 3) !== Math.floor((this.time - dt) * 3)) {
        sfx.bell(cv.c.x, cv.c.z);
      }
    }
    void RAIL_HALF;
  }

  /** The clock tells the real time; the mast's light blinks; the neon flickers; the swing sways; the chimney smokes. */
  private updateLandmarks(dt: number) {
    if (this.hands.length) {
      const now = new Date(), min = now.getMinutes() + now.getSeconds() / 60, hr = (now.getHours() % 12) + min / 60;
      for (const h of this.hands) {
        // (clockwise seen from the front: the hand's +Z points out of its face)
        const a = -(h.hour ? hr / 12 : min / 60) * Math.PI * 2;
        h.spin.setFromAxisAngle({ x: 0, y: 0, z: 1 }, a);
        h.node.quaternion.copyFrom(h.rest).multiply(h.spin);
      }
    }
    const on = this.time % 1.6 < 0.25;
    for (const m of this.beacons) if (m.emissive) m.emissive.strength = on ? 9 : 0.2;
    // the neon's two colours take turns now and then, and stutter
    const beat = Math.floor(this.time * 2.5), stutter = Math.sin(this.time * 37) > 0.93;
    for (const n of this.neon) {
      if (!n.mat.emissive) continue;
      const lit = n.phase === 2 ? beat % 2 === 0 : beat % 8 < 6 || (beat + n.phase) % 2 === 0;
      n.mat.emissive.strength = lit && !(stutter && n.phase === 0) ? n.strength : n.strength * 0.08;
    }
    if (this.swing) {
      this.swing.tilt.setFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.sin(this.time * 1.7) * 0.22);
      this.swing.node.quaternion.copyFrom(this.swing.rest).multiply(this.swing.tilt);
    }
    if (this.smoke) {
      const sm = this.smoke;
      for (const p of sm.puffs) {
        p.t = (p.t + dt / 7) % 1;
        const t = p.t, r = 0.9 + t * 2.6;
        p.mesh.position.set(sm.x + t * 5 + Math.sin(t * 6 + p.mat.alpha) * 0.4, sm.y + 0.6 + t * 9, sm.z - t * 2.5);
        p.mesh.scale.set(r, r * 0.85, r);
        p.mat.alpha = Math.min(1, t * 6) * (1 - t) * 0.55;
      }
    }
  }
}
