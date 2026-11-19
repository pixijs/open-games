/**
 * The sewer: manholes in the middle of the town's streets, and the pipes under them. Built once from
 * the street graph (`CITY.roads`), like the traffic lanes: every street but the spokes out of town
 * has a pipe along its centre line, and the pipes meet under the junctions. A raccoon down a
 * manhole scurries along them (`stepSewer` in sim.ts), choosing its way at the junctions, and can
 * only climb out where there's a manhole. Pure and deterministic: the server and every client build
 * the same sewer.
 *
 * The covers sit on the centre line, between the two lanes: a car passes either side of one, and a
 * raccoon popping out of it lands between them.
 */
import { RoundPhase } from "./constants.js";
import { lineAt } from "./geom.js";
import { EDGE_SPOKE } from "./layout.js";
import { CITY, roomAt, type City, type RoadEdge } from "./map.js";
import { trackDistance } from "./train.js";
import { ZONE_STAGES } from "./zone.js";

/** A manhole: where its cover is, which street's pipe it's on (`edge`) and how far along it from the street's `a` end (`s`). */
export interface ManholeSpot { x: number; z: number; edge: number; s: number; yaw: number }

export interface Sewer {
  manholes: ManholeSpot[];
  /** Per street (index into `CITY.roads.edges`): whether there's a pipe under it. */
  piped: boolean[];
  /** Per street: its manholes (indices into `manholes`), in order along it from its `a` end. */
  onEdge: number[][];
  /** Per junction (index into `CITY.roads.nodes`): the piped streets that meet there. */
  atNode: number[][];
}

/** The radius of a manhole's cover (m). */
export const MANHOLE_R = 0.45;

const _pt = { x: 0, z: 0, dx: 0, dz: 0 };

/**
 * Where the manholes go: one in the middle of each piped street long enough for one clear of its
 * junctions' paving, two along the long ones, each slid along the street (up to 6 m) until it's clear
 * of anything solid, the parking spots, the level crossings and the loot.
 */
export function buildSewer(city: City): Sewer {
  const { nodes, edges } = city.roads;
  const piped = edges.map((e) => !(e.flags & EDGE_SPOKE));
  const manholes: ManholeSpot[] = [];
  const onEdge: number[][] = edges.map((): number[] => []);
  const atNode: number[][] = nodes.map((): number[] => []);
  edges.forEach((e, i) => {
    if (!piped[i]) return;
    atNode[e.a].push(i);
    atNode[e.b].push(i);
  });

  const clear = (x: number, z: number) => {
    if (!roomAt(city, x, z, 0, 0.7)) return false;
    if (Math.abs(trackDistance(x, z)) < 9) return false;
    const near = (q: { x: number; z: number }, d: number) => (q.x - x) ** 2 + (q.z - z) ** 2 < d * d;
    return !city.parking.some((q) => near(q, 3.5)) && !city.pickups.some((q) => near(q, 2.5))
      && !city.bins.some((q) => near(q, 2)) && !city.crossings.some((q) => near(q, 9))
      && !manholes.some((q) => near(q, 14));
  };
  edges.forEach((e, i) => {
    if (!piped[i]) return;
    // clear of both junctions' paving (a bend's node has none)
    const s0 = nodes[e.a].r + 2.5, s1 = e.len - nodes[e.b].r - 2.5;
    const room = s1 - s0;
    const at = room >= 56 ? [0.28, 0.72] : room >= 3 ? [0.5] : [];
    for (const f of at) {
      const want = s0 + room * f;
      for (let k = 0; k <= 24; k++) {
        // 0, +0.5, -0.5, +1, -1… up to 6 m either way
        const s = want + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.5;
        if (s < s0 || s > s1) continue;
        lineAt(e, s, _pt);
        const x = Math.round(_pt.x * 100) / 100, z = Math.round(_pt.z * 100) / 100;
        if (!clear(x, z)) continue;
        onEdge[i].push(manholes.length);
        // (`s` at float32, as a raccoon's `lx` travels: it stops exactly under it)
        manholes.push({ x, z, edge: i, s: Math.fround(s), yaw: Math.atan2(_pt.dx, _pt.dz) });
        break;
      }
    }
  });
  return { manholes, piped, onEdge, atNode };
}

export const SEWER: Sewer = buildSewer(CITY);
export const MANHOLES = SEWER.manholes;

/** The manhole whose cover (x, z) is within `reach` of, the nearest (-1: none). */
export function nearestManhole(x: number, z: number, reach: number): number {
  let best = -1, bestD = reach * reach;
  for (let i = 0; i < MANHOLES.length; i++) {
    const m = MANHOLES[i];
    const d = (m.x - x) ** 2 + (m.z - z) ** 2;
    if (d <= bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * The sewer floods for the showdown: once the last circle is closing in, or a round that began
 * with more than two is down to its last two. Nobody gets down a manhole (`WorldView.manhole`
 * finds none), and the server washes out whoever is down there.
 */
export function sewerFlooded(r: { phase: number; entrants: number; alive: number; zone: { stage: number } }): boolean {
  return r.phase === RoundPhase.Live && (r.zone.stage >= ZONE_STAGES.length - 1 || (r.entrants > 2 && r.alive <= 2));
}

/** Which way street `e` leaves junction `n` (a unit vector along its first stretch from there). */
export function leaving(e: RoadEdge, n: number, out: { x: number; z: number }) {
  const fromA = e.a === n;
  lineAt(e, fromA ? 0.5 : e.len - 0.5, _pt);
  out.x = fromA ? _pt.dx : -_pt.dx;
  out.z = fromA ? _pt.dz : -_pt.dz;
  return out;
}

const _d = { x: 0, z: 0 };

/**
 * Arriving at junction `n` along street `from`, heading (hx, hz): the piped street to go on along.
 * The one the stick (mx, mz, unit or 0) points down most, if it points somewhere; otherwise the one
 * straightest on. Back the way we came only at a dead end (returns `from`).
 */
export function nextPipe(n: number, from: number, hx: number, hz: number, mx: number, mz: number): number {
  const roads = CITY.roads.edges;
  const stick = mx * mx + mz * mz > 0.09;
  let best = from, score = -Infinity;
  for (const e of SEWER.atNode[n]) {
    if (e === from) continue;
    leaving(roads[e], n, _d);
    const sc = stick ? _d.x * mx + _d.z * mz : _d.x * hx + _d.z * hz;
    if (sc > score) { score = sc; best = e; }
  }
  return best;
}
