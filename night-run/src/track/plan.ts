/**
 * A track's venue as data: which pieces and scenery go where, the walls, the floodlight towers, the light tunnel, the
 * TV cranes, the ground and where the attract race starts. Pure, so the venue, the bots' workers and the checks all
 * read the same plan.
 *
 * Night Run keeps its curated venue. Any other track's comes from rules on its route: grass sized to the road,
 * floodlight towers until every stretch of road is near a lamp's aim, a light tunnel over the longest straight with
 * room either side, TV cranes until every stretch of road is near one, and random trees round it all.
 */

import type { WallSpec } from '../Physics';
import type { PointOut, Route, RouteSpot } from '../race/route';
import { BASE_LAP_LENGTH, CELL, ROAD_Y } from '../race/route';
import {
  BASE_ATTRACT_START,
  BASE_FLICKER_GANTRY,
  BASE_GANTRY_S,
  BASE_GROUND,
  BASE_PIECES,
  BASE_SCENERY,
  BASE_TOWERS,
  BASE_TV_SPOTS,
} from './base';
import type { TrackDef } from './code';
import { rng } from './generate';
import { buildWallColliders, piecesFor } from './pieces';

/** A road piece's model. */
export type PieceKey = 'track-straight' | 'track-corner' | 'track-finish';
/** A scenery piece's model. */
export type SceneryKey = 'decoration-forest' | 'decoration-empty' | 'decoration-tents';
/** A piece's turn about the vertical, as the kit names it: 0, 16, 10 and 22 are 0, 90, 180 and 270 degrees. */
export type Orient = 0 | 10 | 16 | 22;

/** One kit piece on the grid. */
export interface Placement {
  readonly gx: number;
  readonly gz: number;
  readonly key: PieceKey | SceneryKey;
  readonly orient: Orient;
}

/** One floodlight tower: where it stands off the route, how tall, and where on the road it aims. */
export interface TowerSpec {
  /** Route distance it stands beside. */
  readonly s: number;
  /** Offset to the driver's right; negative is the driver's left. */
  readonly lateral: number;
  readonly height: number;
  /** Route distance and lateral offset of the point on the road the lamps aim at. */
  readonly aimS: number;
  readonly aimLateral: number;
  /** Share of the lamps' full intensity; less where the lamps stand close to something pale. */
  readonly power: number;
  /** `mast` stands on grass, as every one of Night Run's does; `divider` on the shared barrier between two lanes. */
  readonly kind: 'mast' | 'divider';
}

/** Everything a venue is built from. */
export interface VenuePlan {
  readonly pieces: readonly Placement[];
  /** Built after the pieces, in this order. */
  readonly scenery: readonly Placement[];
  readonly walls: readonly WallSpec[];
  readonly towers: readonly TowerSpec[];
  /** Route distance of each light-tunnel portal. */
  readonly gantries: readonly number[];
  /** Index into {@link VenuePlan.gantries} of the flickering one, or -1 with none. */
  readonly flickerGantry: number;
  /** TV crane positions, x, y and z. */
  readonly tvSpots: readonly (readonly [number, number, number])[];
  /** The grass: its centre, the physics slab's half extent and the plane's size. */
  readonly ground: { readonly x: number; readonly z: number; readonly half: number; readonly plane: number };
  /** Route distance the attract race's leader starts from. */
  readonly attractStart: number;
  /** Road samples, {@link SAMPLE_STEP} apart, that no tower's aim point reaches; the towers ran out first. */
  readonly dark: number;
}

/** The set's floodlights, as `look/set/Floodlights.ts` hangs them: pixi-3d spot lights with these settings. */
export const LAMP_INTENSITY = 650;
/** How far a lamp's light reaches, metres. */
export const LAMP_RANGE = 28;
/** Half-angle of a lamp's cone, in degrees. */
export const LAMP_CONE = 30;
/** The share of a lamp's cone that softens toward its edge. */
export const LAMP_PENUMBRA = 0.6;
/** How far a tower's lamp bank stands off its pole, level, toward where it aims. */
export const BANK_OFFSET = 1;
/** A spot light's radius in pixi-3d, which softens its falloff close up. */
const LAMP_RADIUS = 0.1;
const COS_OUTER = Math.cos((LAMP_CONE * Math.PI) / 180);
const COS_INNER = Math.cos((LAMP_CONE * (1 - LAMP_PENUMBRA) * Math.PI) / 180);

/** Road samples this far apart, along the centreline, are what the towers and cranes must reach. */
export const SAMPLE_STEP = 5;
/** A road sample is reached when a tower's aim point is this close, level; Night Run's worst is 11.2. */
export const COVER_M = 14;
/** A metre of road counts as lit at this much light: a quarter of Night Run's median. */
export const LIT_E = 0.29;
/** Towers go up until this share of the road is lit, as 68% of Night Run is. */
export const LIT_SHARE = 0.62;
/** Less than this share lit, and the towers are placed again without the corner and straight rules. */
export const LIT_FLOOR = 0.55;
/** A road sample is on camera when a TV crane is this close, level. */
export const CRANE_REACH = 32;
/** Neon's tunnel posts stand this far either side of the centreline, just outside the barriers. */
export const GANTRY_LATERAL = 4.15;
/** A tunnel post keeps at least this far from every other road's centreline. */
export const POST_CLEARANCE = 3.9;
/** At most this many floodlight towers; only the set's six spot lights are ever lit. */
export const MAX_TOWERS = 24;
/** At most this many scenery pieces round a track. */
export const MAX_SCENERY = 360;

const BASE_PLAN: VenuePlan = {
  pieces: BASE_PIECES,
  scenery: BASE_SCENERY,
  walls: buildWallColliders(BASE_PIECES),
  towers: BASE_TOWERS,
  gantries: BASE_GANTRY_S,
  flickerGantry: BASE_FLICKER_GANTRY,
  tvSpots: BASE_TV_SPOTS,
  ground: BASE_GROUND,
  attractStart: BASE_ATTRACT_START,
  dark: 0,
};

const HALF = CELL / 2;
/** Quarter turns, as orient codes. */
const QUARTER_ORIENTS: readonly Orient[] = [0, 16, 10, 22];
/** Cells of trees round the road, counted out from the nearest road cell. */
const TREE_BAND = 3;
/**
 * What grows on a cell, by its distance in cells from the road: the chance of tents, of a three-tree clump and of a
 * seven-tree forest; the rest is bare grass. Thin beside the road, so the cameras see down it; thick further out.
 */
const TREE_ODDS: Readonly<Record<number, readonly [number, number, number]>> = {
  1: [0.08, 0.52, 0],
  2: [0, 0.4, 0.45],
  3: [0, 0.25, 0.75],
};
/** The grass reaches this far past the road's box, and the physics slab past the trees and a respawn's margin. */
const PLANE_MARGIN = 100;
const SLAB_MARGIN = 30;
/** The smallest plane, Night Run's. */
const MIN_PLANE = 200;
/** Towers and cranes stand at least this far inside the plane's edge. */
const PLANE_INSET = 5;

/** A mast stands this far out from the road it lights, its foot this clear of every road, this far from any other. */
const MAST_LATERAL = 7.5;
const FOOT_CLEARANCE = 5.5;
const MAST_SPACING = 12;
/** The coverage pass's masts may stand further out too, when the near spot is taken. */
const MAST_FAR_LATERAL = 11;
/** How far out the arch's mast stands: its lamps stay clear of the logos on the arch, and a TV crane fits inside it. */
const ARCH_MAST_LATERAL = 15;
/** A lane divider's mast stands on the shared cell edge between two parallel straights, this far from any other. */
const DIVIDER_LATERAL = HALF;
const DIVIDER_SPACING = 8;
/** A divider's lamps aim this far along the barrier, either way, so the cone falls on both lanes. */
const DIVIDER_THROW = 12;
const DIVIDER_HEIGHT = 10;
/** Bringing one more road sample near an aim point outweighs any amount of light. */
const DARK_WEIGHT = 1e4;
/** A straight run needs this many cells to get a tower of its own. */
const TOWER_RUN = 4;

/** TV cranes: inside a corner, outside it, and either side of a straight, with their heights. */
const CRANE_INSIDE = 9;
const CRANE_INSIDE_HEIGHT = 6.5;
const CRANE_OUTSIDE = 12;
const CRANE_OUTSIDE_HEIGHT = 8.5;
const CRANE_SIDE = 11;
const CRANE_SIDE_HEIGHT = 7.5;
/** A straight run needs this many cells to get cranes of its own. */
const CRANE_RUN = 3;
const CRANE_CLEARANCE = 6;
const CRANE_FROM_FOOT = 3;
/** Over packed lanes, a camera rides this high above the barrier between them, clear of the lamps. */
const CRANE_OVER_HEIGHT = 12;
const MIN_CRANES = 4;
const MAX_CRANES = 12;

/** The tunnel's five portals, this far apart along the road, and the one whose tube fails. */
const PORTALS = 5;
const PORTAL_GAP = 3;
const FLICKER_PORTAL = 3;

const _p = { x: 0, y: 0, z: 0 };
const _q = { x: 0, y: 0, z: 0 };
const _spot: RouteSpot = { s: 0, lateral: 0, heading: 0 };

/** A floodlight's lamp worked out once: where it hangs, the axis it shines down, and how bright. */
export interface Lamp {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit axis from the lamp to its aim point on the road. */
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly power: number;
}

/**
 * Where a tower's lamp hangs and points: on the bank, its foot raised to its height and moved toward its aim.
 * @param tower - The tower.
 * @param route - The route it stands beside.
 * @returns The lamp.
 */
export function towerLamp(tower: TowerSpec, route: Route): Lamp {
  route.point(tower.s, tower.lateral, _p);
  route.point(tower.aimS, tower.aimLateral, _q);

  const flat = Math.hypot(_q.x - _p.x, _q.z - _p.z);
  const x = _p.x + ((_q.x - _p.x) / flat) * BANK_OFFSET;
  const z = _p.z + ((_q.z - _p.z) / flat) * BANK_OFFSET;
  const y = ROAD_Y + tower.height;
  const dx = _q.x - x;
  const dy = ROAD_Y - y;
  const dz = _q.z - z;
  const length = Math.hypot(dx, dy, dz);

  return { x, y, z, ax: dx / length, ay: dy / length, az: dz / length, power: tower.power };
}

/**
 * How brightly a lamp lights a point on the road, with pixi-3d's spot falloff worked on the CPU: the cone's soft edge,
 * the range window and the inverse square, times how squarely the light falls on the road.
 * @param lamp - The lamp, from {@link towerLamp}.
 * @param x - Road point, x.
 * @param z - Road point, z.
 * @returns The light's intensity there.
 */
export function lampLightAt(lamp: Lamp, x: number, z: number): number {
  const vx = x - lamp.x;
  const vy = ROAD_Y - lamp.y;
  const vz = z - lamp.z;
  const d2 = vx * vx + vy * vy + vz * vz;

  if (d2 >= LAMP_RANGE * LAMP_RANGE) return 0;

  const d = Math.sqrt(d2);
  const cos = (vx * lamp.ax + vy * lamp.ay + vz * lamp.az) / d;

  if (cos <= COS_OUTER) return 0;

  const edge = Math.min(1, (cos - COS_OUTER) / (COS_INNER - COS_OUTER));
  const fade = 1 - (d2 * d2) / LAMP_RANGE ** 4;

  return (
    (((LAMP_INTENSITY * lamp.power * edge * edge * fade * fade) / Math.sqrt(d2 * d2 + LAMP_RADIUS ** 4)) * -vy) / d
  );
}

/**
 * How brightly one tower lights a point on the road: {@link lampLightAt} for its lamp.
 * @param tower - The tower.
 * @param route - The route it stands beside.
 * @param x - Road point, x.
 * @param z - Road point, z.
 * @returns The light's intensity there.
 */
export function lampLight(tower: TowerSpec, route: Route, x: number, z: number): number {
  return lampLightAt(towerLamp(tower, route), x, z);
}

/**
 * The venue for a track. Night Run's is its curated one, the same object every time. Any other's follows from its
 * route, so every player's is the same but for the trees, which `treeSeed` scatters.
 * @param def - The track.
 * @param route - Its route.
 * @param treeSeed - Seeds a custom track's random trees.
 * @returns The plan.
 */
export function planVenue(def: TrackDef, route: Route, treeSeed: number): VenuePlan {
  if (def.builtIn) return BASE_PLAN;

  const pieces = piecesFor(def.cells);
  const layout = new Layout(def, route);
  const candidates = towerCandidates(layout);
  let placed = placeTowers(layout, candidates, true);

  // Packed lanes leave little grass by the corners, and masts there light little road; the barriers do better.
  if (placed.dark > 0 || placed.lit < LIT_FLOOR) {
    const barriers = placeTowers(layout, candidates, false);

    if (barriers.dark < placed.dark || (barriers.dark === placed.dark && barriers.lit > placed.lit)) placed = barriers;
  }

  const { towers, dark } = placed;
  const tunnel = placeTunnel(layout);
  const tvSpots = placeCranes(layout, towers);
  const cranes = new Set(tvSpots.map(([x, , z]) => cellKey(Math.floor(x / CELL), Math.floor(z / CELL))));
  const reserved = new Set([...tunnel.sides, ...cranes]);

  for (const tower of towers) {
    route.point(tower.s, tower.lateral, _p);
    reserved.add(cellKey(Math.floor(_p.x / CELL), Math.floor(_p.z / CELL)));
  }

  return {
    pieces,
    scenery: plantTrees(layout, reserved, cranes, rng(treeSeed)),
    walls: buildWallColliders(pieces),
    towers,
    gantries: tunnel.gantries,
    flickerGantry: tunnel.gantries.length > 0 ? FLICKER_PORTAL : -1,
    tvSpots,
    ground: layout.ground,
    attractStart: BASE_ATTRACT_START * (route.lapLength / BASE_LAP_LENGTH),
    dark,
  };
}

/** A tower's spot, with the road it reaches and lights. */
interface Candidate {
  readonly spec: TowerSpec;
  /** Its foot. */
  readonly x: number;
  readonly z: number;
  /** The road samples within {@link COVER_M} of its aim point. */
  readonly reach: readonly number[];
  /** The metres of road its lamp lights, and how brightly. */
  readonly glow: { readonly metres: readonly number[]; readonly light: readonly number[] };
}

/** A track's road as the rules read it: each cell's place on the route and the ground round it. */
class Layout {
  public readonly route: Route;
  public readonly turns: string;
  public readonly n: number;
  /** Route distance where each cell starts and how long it is; the finish cell starts half a cell before the line. */
  public readonly start: readonly number[];
  public readonly length: readonly number[];
  /** Each cell's travel direction, as a grid step, where it's entered. */
  public readonly dir: readonly (readonly [number, number])[];
  public readonly ground: VenuePlan['ground'];
  /** Points along the centreline, {@link SAMPLE_STEP} apart from the line: x then z. */
  public readonly samples: Float64Array;
  /** Points along the centreline a metre apart, where the light is judged: x then z. */
  public readonly metres: Float64Array;
  private readonly _index = new Map<string, number>();

  constructor(def: TrackDef, route: Route) {
    const { cells, turns } = def;
    const n = cells.length;
    const lap = route.lapLength;

    this.route = route;
    this.turns = turns;
    this.n = n;
    this.start = cells.map((_, i) => (i === 0 ? lap - HALF : route.segments[i].s));
    this.length = cells.map((_, i) => (i === 0 ? CELL : route.segments[i].length));
    this.dir = cells.map(([x, z], i) => {
      const [px, pz] = cells[(i - 1 + n) % n];

      return [x - px, z - pz] as const;
    });
    cells.forEach(([x, z], i) => this._index.set(cellKey(x, z), i));

    const { minX, maxX, minZ, maxZ } = route.box;
    const x0 = minX * CELL;
    const x1 = (maxX + 1) * CELL;
    const z0 = minZ * CELL;
    const z1 = (maxZ + 1) * CELL;
    const half = Math.max(x1 - x0, z1 - z0) / 2;

    this.ground = {
      x: (x0 + x1) / 2,
      z: (z0 + z1) / 2,
      half: half + SLAB_MARGIN,
      plane: Math.max(MIN_PLANE, 2 * (half + PLANE_MARGIN)),
    };

    const count = Math.ceil(lap / SAMPLE_STEP);

    this.samples = new Float64Array(count * 2);

    for (let k = 0; k < count; k++) {
      route.point(k * SAMPLE_STEP, 0, _p);
      this.samples[k * 2] = _p.x;
      this.samples[k * 2 + 1] = _p.z;
    }

    this.metres = new Float64Array(Math.ceil(lap) * 2);

    for (let j = 0; j < this.metres.length / 2; j++) {
      route.point(j, 0, _p);
      this.metres[j * 2] = _p.x;
      this.metres[j * 2 + 1] = _p.z;
    }
  }

  /** How many road samples there are. */
  public get sampleCount(): number {
    return this.samples.length / 2;
  }

  /** The road cell at grid x and z, or -1. */
  public cellAt(gx: number, gz: number): number {
    return this._index.get(cellKey(gx, gz)) ?? -1;
  }

  /** The road cell a world point lies in, or -1. */
  public cellUnder(point: PointOut): number {
    return this.cellAt(Math.floor(point.x / CELL), Math.floor(point.z / CELL));
  }

  public straight(i: number): boolean {
    return this.turns[i] === 'S';
  }

  /** Route distance halfway along a run of cells. */
  public middle(run: readonly number[]): number {
    let length = 0;

    for (const i of run) length += this.length[i];

    return this.route.wrap(this.start[run[0]] + length / 2);
  }

  /** How far a world point is from the middle of the nearest road. */
  public clearance(x: number, z: number): number {
    return Math.abs(this.route.project(x, z, _spot).lateral);
  }

  /** Whether a world point is at least {@link PLANE_INSET} inside the grass. */
  public onGrass(x: number, z: number): boolean {
    const { ground } = this;
    const reach = ground.plane / 2 - PLANE_INSET;

    return Math.abs(x - ground.x) <= reach && Math.abs(z - ground.z) <= reach;
  }

  /** The road samples within `radius` of a point, level. */
  public reach(x: number, z: number, radius: number): number[] {
    const samples = this.samples;
    const found: number[] = [];

    for (let k = 0; k < samples.length / 2; k++) {
      if (Math.hypot(samples[k * 2] - x, samples[k * 2 + 1] - z) <= radius) found.push(k);
    }

    return found;
  }

  /**
   * The track's corners in groups: a U-turn (two corners of one hand in a row) or a single corner, at the group's
   * middle. A U-turn is never longer, since a third corner of the same hand would cross the road.
   */
  public cornerGroups(): { s: number; turn: 1 | -1; uTurn: boolean }[] {
    const groups: { s: number; turn: 1 | -1; uTurn: boolean }[] = [];
    const turns = this.turns;

    // The finish cell and the cells either side of it are straight, so no group wraps past the line.
    for (let i = 0; i < this.n; i++) {
      if (turns[i] === 'S') continue;

      const turn = turns[i] === 'R' ? 1 : -1;

      if (turns[i + 1] === turns[i]) {
        groups.push({ s: this.start[i + 1], turn, uTurn: true });
        i++;
      } else {
        groups.push({ s: this.start[i] + this.length[i] / 2, turn, uTurn: false });
      }
    }

    return groups;
  }

  /** Maximal runs, in route order, of the cells `member` takes; a run may wrap past the finish. */
  public runs(member: (i: number) => boolean): number[][] {
    const n = this.n;
    let outside = 0;

    while (outside < n && member(outside)) outside++;

    const runs: number[][] = [];
    let run: number[] = [];

    for (let k = 1; k <= n; k++) {
      const i = (outside + k) % n;

      if (member(i)) {
        run.push(i);
      } else if (run.length > 0) {
        runs.push(run);
        run = [];
      }
    }

    if (run.length > 0) runs.push(run);

    return runs;
  }

  /**
   * Whether the cell edge `side` of the road at `s` is a shared barrier between two parallel straights: a metre either
   * way along, this road and the one across the edge are both straights running the same way, neither the finish.
   */
  public sharedBarrier(s: number, side: number): boolean {
    for (const along of [-1, 1]) {
      this.route.point(s + along, side * (HALF - 1), _p);
      this.route.point(s + along, side * (HALF + 1), _q);

      const own = this.cellUnder(_p);
      const across = this.cellUnder(_q);

      if (own <= 0 || across <= 0 || !this.straight(own) || !this.straight(across)) return false;

      const ownAlongX = this.dir[own][0] !== 0;
      const acrossAlongX = this.dir[across][0] !== 0;

      if (ownAlongX !== acrossAlongX) return false;
    }

    return true;
  }
}

/**
 * Floodlight towers by the rules, in priority order: past the finish line, outside every corner group (U-turns
 * first), beside every long straight. Then, while any road sample is further than {@link COVER_M} from every aim point
 * or less than {@link LIT_SHARE} of the road gets {@link LIT_E}, the spot that reaches or lights the most road: a mast
 * beside the road, or, where packed lanes leave no grass near enough, one on the shared barrier between two parallel
 * lanes, aimed down the barrier so it lights both.
 */
function placeTowers(
  layout: Layout,
  candidates: readonly Candidate[],
  rules: boolean,
): { towers: TowerSpec[]; dark: number; lit: number } {
  const { route } = layout;
  const towers: TowerSpec[] = [];
  const feet: { x: number; z: number }[] = [];
  /** Road samples near an aim point, and the light at every metre of road. */
  const reached = new Uint8Array(layout.sampleCount);
  const lux = new Float64Array(layout.metres.length / 2);
  const litGoal = Math.ceil(LIT_SHARE * lux.length);
  let dark = reached.length;
  let lit = 0;

  const fits = (x: number, z: number, spacing: number): boolean =>
    feet.every((foot) => Math.hypot(foot.x - x, foot.z - z) >= spacing);
  const accept = (candidate: Candidate): void => {
    towers.push(candidate.spec);
    feet.push({ x: candidate.x, z: candidate.z });

    for (const k of candidate.reach) {
      if (!reached[k]) dark--;

      reached[k] = 1;
    }

    const { metres, light } = candidate.glow;

    for (let i = 0; i < metres.length; i++) {
      const before = lux[metres[i]];

      lux[metres[i]] += light[i];
      if (before < LIT_E && lux[metres[i]] >= LIT_E) lit++;
    }
  };
  /** A mast on one side, else the other; none when neither has room. */
  const mast = (s: number, lateral: number, height: number, aimS: number, aimLateral: number, power: number): void => {
    for (const side of [lateral, -lateral]) {
      route.point(s, side, _p);

      if (
        layout.clearance(_p.x, _p.z) >= FOOT_CLEARANCE &&
        layout.onGrass(_p.x, _p.z) &&
        fits(_p.x, _p.z, MAST_SPACING)
      ) {
        accept(towerCandidate(layout, { s, lateral: side, height, aimS, aimLateral, power, kind: 'mast' }));

        return;
      }
    }
  };

  // Night Run's first tower: beside the arch, lighting the line, far enough out to stay clear of the logos on top.
  mast(2, -ARCH_MAST_LATERAL, 9.5, 1, 0, 0.8);

  const groups = rules ? layout.cornerGroups() : [];

  for (const { s, turn } of [...groups.filter((g) => g.uTurn), ...groups.filter((g) => !g.uTurn)]) {
    mast(s, -turn * MAST_LATERAL, 10, s, -turn * 0.5, 1);
  }

  for (const run of rules ? layout.runs((i) => layout.straight(i)) : []) {
    if (run.length < TOWER_RUN) continue;

    const s = layout.middle(run);

    mast(s, -MAST_LATERAL, 9.5, s + 3, 0, 1);
  }

  while (towers.length < MAX_TOWERS && (dark > 0 || lit < litGoal)) {
    let best: Candidate | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const divider = candidate.spec.kind === 'divider';

      if (!fits(candidate.x, candidate.z, divider ? DIVIDER_SPACING : MAST_SPACING)) continue;

      // Road samples it brings near an aim point first, then metres of road it brings into the light.
      let score = 0;

      if (dark > 0) for (const k of candidate.reach) if (!reached[k]) score += DARK_WEIGHT;

      if (lit < litGoal) {
        const { metres, light } = candidate.glow;

        for (let i = 0; i < metres.length; i++) {
          if (lux[metres[i]] < LIT_E && lux[metres[i]] + light[i] >= LIT_E) score++;
        }
      }

      // Ties go to masts, then to the earliest spot; the candidates are in route order.
      if (score > bestScore || (score === bestScore && score > 0 && best?.spec.kind === 'divider' && !divider)) {
        best = candidate;
        bestScore = score;
      }
    }

    if (!best) break;

    accept(best);
  }

  return { towers, dark, lit: lit / lux.length };
}

/**
 * Every spot the fill may put a tower: masts either side of the road at every road sample, near and further out, and
 * on every shared barrier between two parallel lanes, aimed down it either way.
 */
function towerCandidates(layout: Layout): Candidate[] {
  const { route } = layout;
  const candidates: Candidate[] = [];

  for (let k = 0; k < layout.sampleCount; k++) {
    const s = k * SAMPLE_STEP;

    for (const lateral of [MAST_LATERAL, -MAST_LATERAL, MAST_FAR_LATERAL, -MAST_FAR_LATERAL]) {
      route.point(s, lateral, _p);

      if (layout.clearance(_p.x, _p.z) < FOOT_CLEARANCE || !layout.onGrass(_p.x, _p.z)) continue;

      candidates.push(
        towerCandidate(layout, { s, lateral, height: 10, aimS: s + 2, aimLateral: 0, power: 1, kind: 'mast' }),
      );
    }

    for (const side of [1, -1]) {
      if (!layout.sharedBarrier(s, side)) continue;

      const lateral = side * DIVIDER_LATERAL;

      for (const throwS of [DIVIDER_THROW, -DIVIDER_THROW]) {
        const spec: TowerSpec = {
          s,
          lateral,
          height: DIVIDER_HEIGHT,
          aimS: s + throwS,
          aimLateral: lateral,
          power: 1,
          kind: 'divider',
        };

        candidates.push(towerCandidate(layout, spec));
      }
    }
  }

  return candidates;
}

/** A tower's spot: its foot, the road samples near its aim point, and the light it puts on every metre of road. */
function towerCandidate(layout: Layout, spec: TowerSpec): Candidate {
  const { route, metres } = layout;

  route.point(spec.s, spec.lateral, _p);

  const { x, z } = _p;

  route.point(spec.aimS, spec.aimLateral, _q);

  const lamp = towerLamp(spec, route);
  const near: number[] = [];
  const light: number[] = [];

  for (let j = 0; j < metres.length / 2; j++) {
    const mx = metres[j * 2];
    const mz = metres[j * 2 + 1];

    const e = lampLightAt(lamp, mx, mz);

    if (e > 0) {
      near.push(j);
      light.push(e);
    }
  }

  return { spec, x, z, reach: layout.reach(_q.x, _q.z, COVER_M), glow: { metres: near, light } };
}

/**
 * The light tunnel: five portals over the longest straight run of two cells or more, away from the finish cell and
 * its neighbours, whose sides are clear of other roads; ties go to the run farthest from the line. None when no run
 * has room.
 * @returns The portals' route distances, and the cells beside the run, kept clear of trees.
 */
function placeTunnel(layout: Layout): { gantries: number[]; sides: string[] } {
  const { route, n } = layout;
  const lap = route.lapLength;
  let best: { run: number[]; s: number; away: number } | null = null;

  for (const run of layout.runs((i) => layout.straight(i) && i > 1 && i < n - 1)) {
    if (run.length < 2) continue;

    const s = layout.middle(run);
    const away = Math.min(s, lap - s);

    if (best && (run.length < best.run.length || (run.length === best.run.length && away <= best.away))) continue;
    if (!tunnelFits(layout, run, s)) continue;

    best = { run, s, away };
  }

  if (!best) return { gantries: [], sides: [] };

  const gantries: number[] = [];
  const sides: string[] = [];

  for (let i = 0; i < PORTALS; i++) gantries.push(route.wrap(best.s + (i - (PORTALS - 1) / 2) * PORTAL_GAP));

  for (const i of best.run) {
    const [gx, gz] = route.cells[i];
    const [dx, dz] = layout.dir[i];

    sides.push(cellKey(gx - dz, gz + dx), cellKey(gx + dz, gz - dx));
  }

  return { gantries, sides };
}

/** Whether a run has no road either side of it and every portal's posts stand clear of other roads. */
function tunnelFits(layout: Layout, run: readonly number[], middle: number): boolean {
  for (const i of run) {
    const [gx, gz] = layout.route.cells[i];
    const [dx, dz] = layout.dir[i];

    if (layout.cellAt(gx - dz, gz + dx) >= 0 || layout.cellAt(gx + dz, gz - dx) >= 0) return false;
  }

  for (let i = 0; i < PORTALS; i++) {
    for (const side of [-1, 1]) {
      layout.route.point(middle + (i - (PORTALS - 1) / 2) * PORTAL_GAP, side * GANTRY_LATERAL, _p);

      if (layout.clearance(_p.x, _p.z) < POST_CLEARANCE) return false;
    }
  }

  return true;
}

/**
 * TV cranes by greedy cover: from spots inside and outside every corner group and either side of every straight run of
 * three cells or more, clear of the road and the towers' feet, take the one that brings the most road samples within
 * {@link CRANE_REACH}, then the one nearest the most samples, until every sample is covered and there are at least
 * {@link MIN_CRANES}, or there are {@link MAX_CRANES}. Road those spots can't reach gets spots beside any sample of
 * road, and where packed lanes leave no grass that near, a camera high over the barrier between two lanes.
 */
function placeCranes(layout: Layout, towers: readonly TowerSpec[]): [number, number, number][] {
  const { route, samples } = layout;
  const feet = towers.map((tower) => {
    route.point(tower.s, tower.lateral, _p);

    return { x: _p.x, z: _p.z };
  });
  const covered = new Uint8Array(layout.sampleCount);
  /** Distance from each sample to its nearest crane so far. */
  const nearest = new Float64Array(layout.sampleCount).fill(Infinity);
  const spots: [number, number, number][] = [];
  let open = covered.length;

  /** A crane spot, unless it's on the road, too near a tower's foot or off the grass. */
  const spot = (s: number, lateral: number, height: number, clearance = CRANE_CLEARANCE): CraneSpot | null => {
    route.point(s, lateral, _p);

    const { x, z } = _p;

    if (layout.clearance(x, z) < clearance || !layout.onGrass(x, z)) return null;
    if (feet.some((foot) => Math.hypot(foot.x - x, foot.z - z) < CRANE_FROM_FOOT)) return null;

    return { height, x, z, reach: layout.reach(x, z, CRANE_REACH) };
  };
  const cover = (candidates: CraneSpot[], enough: number): void => {
    while (spots.length < MAX_CRANES && candidates.length > 0 && (open > 0 || spots.length < enough)) {
      let best = -1;
      let bestCover = -1;
      let bestCloser = -1;

      for (let c = 0; c < candidates.length; c++) {
        const { x, z, reach } = candidates[c];
        let gain = 0;
        let closer = 0;

        for (const k of reach) if (!covered[k]) gain++;

        for (let k = 0; k < covered.length; k++) {
          if (Math.hypot(samples[k * 2] - x, samples[k * 2 + 1] - z) < nearest[k]) closer++;
        }

        if (gain > bestCover || (gain === bestCover && closer > bestCloser)) {
          best = c;
          bestCover = gain;
          bestCloser = closer;
        }
      }

      if (open > 0 && bestCover === 0 && spots.length >= enough) return;

      const [{ height, x, z, reach }] = candidates.splice(best, 1);

      spots.push([x, height, z]);

      for (const k of reach) {
        if (!covered[k]) open--;

        covered[k] = 1;
      }

      for (let k = 0; k < covered.length; k++) {
        nearest[k] = Math.min(nearest[k], Math.hypot(samples[k * 2] - x, samples[k * 2 + 1] - z));
      }
    }
  };
  const rules: (CraneSpot | null)[] = [];

  for (const { s, turn } of layout.cornerGroups()) {
    rules.push(spot(s, turn * CRANE_INSIDE, CRANE_INSIDE_HEIGHT), spot(s, -turn * CRANE_OUTSIDE, CRANE_OUTSIDE_HEIGHT));
  }

  for (const run of layout.runs((i) => layout.straight(i))) {
    if (run.length < CRANE_RUN) continue;

    const s = layout.middle(run);

    rules.push(spot(s, CRANE_SIDE, CRANE_SIDE_HEIGHT), spot(s, -CRANE_SIDE, CRANE_SIDE_HEIGHT));
  }

  cover(rules.filter(isSpot), MIN_CRANES);

  if (open === 0) return spots;

  const beside: (CraneSpot | null)[] = [];
  const over: (CraneSpot | null)[] = [];

  for (let k = 0; k < covered.length; k++) {
    const s = k * SAMPLE_STEP;

    for (const lateral of [CRANE_SIDE, -CRANE_SIDE]) beside.push(spot(s, lateral, CRANE_SIDE_HEIGHT));

    for (const side of [1, -1]) {
      if (layout.sharedBarrier(s, side)) over.push(spot(s, side * DIVIDER_LATERAL, CRANE_OVER_HEIGHT, 0));
    }
  }

  // Ties go to the spots on the grass, listed first.
  cover([...beside, ...over].filter(isSpot), 0);

  return spots;
}

/** A TV crane's spot: its camera's height, where it stands and the road samples it reaches. */
interface CraneSpot {
  readonly height: number;
  readonly x: number;
  readonly z: number;
  readonly reach: readonly number[];
}

function isSpot(spot: CraneSpot | null): spot is CraneSpot {
  return spot !== null;
}

/**
 * Random trees on every free cell within {@link TREE_BAND} of the road, thin beside it and thick further out, each a
 * random quarter turn: none on a tower's foot, a crane's cell or beside the tunnel, and no forest next to a crane, so
 * its view out isn't walled in. Past {@link MAX_SCENERY}, random pieces furthest out go first.
 */
function plantTrees(
  layout: Layout,
  reserved: ReadonlySet<string>,
  cranes: ReadonlySet<string>,
  random: () => number,
): Placement[] {
  const { minX, maxX, minZ, maxZ } = layout.route.box;
  const planted: { placement: Placement; d: number }[] = [];

  for (let gz = minZ - TREE_BAND; gz <= maxZ + TREE_BAND; gz++) {
    for (let gx = minX - TREE_BAND; gx <= maxX + TREE_BAND; gx++) {
      if (layout.cellAt(gx, gz) >= 0 || reserved.has(cellKey(gx, gz))) continue;

      const d = roadDistance(layout, gx, gz);

      if (d > TREE_BAND) continue;

      const [tents, empty, forest] = TREE_ODDS[d];
      const roll = random();
      let key: SceneryKey;

      if (roll < tents) key = 'decoration-tents';
      else if (roll < tents + empty) key = 'decoration-empty';
      else if (roll < tents + empty + forest) key = 'decoration-forest';
      else continue;

      if (key === 'decoration-forest' && besideCrane(cranes, gx, gz)) key = 'decoration-empty';

      planted.push({ placement: { gx, gz, key, orient: QUARTER_ORIENTS[Math.floor(random() * 4)] }, d });
    }
  }

  let over = planted.length - MAX_SCENERY;

  for (let d = TREE_BAND; d > 1 && over > 0; d--) {
    const ring = planted.filter((tree) => tree.d === d);

    // A partial shuffle picks which of this ring go.
    for (let i = 0; i < ring.length && over > 0; i++, over--) {
      const j = i + Math.floor(random() * (ring.length - i));

      [ring[i], ring[j]] = [ring[j], ring[i]];
      ring[i].d = -1;
    }
  }

  return planted.filter((tree) => tree.d > 0).map((tree) => tree.placement);
}

/** Cells from the nearest road cell, counting diagonals as one: 1 beside the road, up to {@link TREE_BAND} + 1. */
function roadDistance(layout: Layout, gx: number, gz: number): number {
  for (let d = 1; d <= TREE_BAND; d++) {
    for (let dz = -d; dz <= d; dz++) {
      for (let dx = -d; dx <= d; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) === d && layout.cellAt(gx + dx, gz + dz) >= 0) return d;
      }
    }
  }

  return TREE_BAND + 1;
}

function besideCrane(cranes: ReadonlySet<string>, gx: number, gz: number): boolean {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) if (cranes.has(cellKey(gx + dx, gz + dz))) return true;
  }

  return false;
}

function cellKey(gx: number, gz: number): string {
  return `${gx},${gz}`;
}
