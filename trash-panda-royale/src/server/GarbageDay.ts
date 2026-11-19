import {
  CAR_GARBAGE, CAR_MAX_HP, CAR_TYPES, CarLight, DUMPSTER_H, DUMPSTER_HD, DUMPSTER_HW, GARBAGE_AT_S, GARBAGE_BEEP_S, GARBAGE_LOCK_MS, GARBAGE_LOOT,
  GARBAGE_LOOT_R, GARBAGE_LOWER_MS, GARBAGE_SPEED, GarbagePhase, LANE_OFFSET, LOOSE_FLIGHT_MS, MAP_HALF, Mode, NEAR_EVENTS, RoundPhase,
} from "../shared/constants.js";
import { lineAt, makeLine, subLine, type Line, type P2 } from "../shared/geom.js";
import { EDGE_SPOKE } from "../shared/layout.js";
import { joinLines, LANES, offsetLine, trim } from "../shared/lanes.js";
import { circleObb, CITY, groundHeight, mulberry32, roomAt } from "../shared/map.js";
import type { Car } from "../shared/schema.js";
import { crateOf, dumpSpot } from "../shared/garbage.js";
import { collideCarStatic, wrapAngle, type SeenCar } from "../shared/sim.js";
import { TRAIN_SLOTS, trainCarPose, type CarPose } from "../shared/train.js";
import type { GameRoom } from "./GameRoom.js";
import { nearestOn } from "./Traffic.js";

/** The truck comes in from, and goes off at, this far inside the map's edge (m). */
const EDGE_IN = 5;
/** Where the truck waits while it isn't Garbage Day: far off the map, out of everyone's view. */
const TRUCK_HOME = { x: 0, z: -900 };
const _p = { x: 0, z: 0, dx: 0, dz: 0 };
const _n = { x: 0, z: 0, depth: 0 };
const _tp: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };

/** A spoke road out of town: its lane in (from the map's edge to the ring road) and its lane out, and the ring road junction it meets. */
interface Spoke { ring: number; laneIn: Line; laneOut: Line }

/** Where the truck is going and how: the way there, how far along it is, and where the level crossings on it are. */
interface Drive { route: Line; s: number; crossings: number[]; speed: number; blockedFor: number; honkAt: number; progressAt: number; progressS: number; leaving: boolean }

/** Every spoke road (the edges of town the truck comes in by and leaves by). */
function buildSpokes(): Spoke[] {
  const { nodes, edges } = CITY.roads;
  const out: Spoke[] = [];
  for (const e of edges) {
    if (!(e.flags & EDGE_SPOKE)) continue;
    const outer = nodes[e.b].kind === "edge" ? e.b : e.a, ring = outer === e.b ? e.a : e.b;
    const inward = outer === e.a ? e.pts : [...e.pts].reverse();
    const r = nodes[ring].r;
    const lIn = makeLine(offsetLine(inward, LANE_OFFSET));
    const lOut = makeLine(offsetLine([...inward].reverse(), LANE_OFFSET));
    // (from, and to, a little inside the map's edge: past it, its walls would hold the truck back)
    const inside = (l: Line, s: number) => { const q = lineAt(l, s); return Math.max(Math.abs(q.x), Math.abs(q.z)) <= MAP_HALF - EDGE_IN; };
    let s0 = 0;
    while (s0 < lIn.len && !inside(lIn, s0)) s0 += 0.5;
    let s1 = lOut.len;
    while (s1 > 0 && !inside(lOut, s1)) s1 -= 0.5;
    out.push({ ring, laneIn: makeLine(trim(lIn, s0, lIn.len - r)), laneOut: makeLine(trim(lOut, r, s1)) });
  }
  return out;
}

/** Points of `b` after those of `a`, without repeating the joint. */
function concat(a: P2[], b: P2[]): P2[] {
  const out = a.slice();
  for (const q of b) {
    const l = out[out.length - 1];
    if (!l || (l.x - q.x) ** 2 + (l.z - q.z) ** 2 > 1e-4) out.push({ x: q.x, z: q.z });
  }
  return out;
}

/**
 * Cheapest way through the lanes from any of `starts` (lane index → cost to reach its start) to the
 * end condition `goal` (lane index → extra cost to finish from its start, or Infinity). Returns the
 * lane indices, in order.
 */
function cheapest(starts: Map<number, number>, goal: (lane: number) => number): number[] | null {
  const dist = new Map<number, number>(starts), prev = new Map<number, number>();
  const open = new Set<number>(starts.keys());
  let best = Infinity, bestLane = -1;
  while (open.size) {
    let u = -1, du = Infinity;
    for (const k of open) { const d = dist.get(k)!; if (d < du) { du = d; u = k; } }
    open.delete(u);
    if (du >= best) break;
    const g = goal(u);
    if (du + g < best) { best = du + g; bestLane = u; }
    const len = LANES[u].line.len;
    for (const v of LANES[u].next) {
      const dv = du + len + 6;
      if (dv < (dist.get(v) ?? Infinity)) { dist.set(v, dv); prev.set(v, u); open.add(v); }
    }
  }
  if (bestLane < 0) return null;
  const path = [bestLane];
  while (prev.has(path[0])) path.unshift(prev.get(path[0])!);
  return path;
}

/** The lanes `path` driven end to end, joined through their junctions (the first from `s0`, the last to `s1`). */
function laneRoute(path: number[], s0: number, s1: number): P2[] {
  let pts: P2[] = [];
  path.forEach((li, k) => {
    const l = LANES[li].line;
    const part = subLine(l, k === 0 ? s0 : 0, k === path.length - 1 ? s1 : l.len);
    if (k > 0) pts = concat(pts, joinLines(LANES[path[k - 1]].line, l).pts);
    pts = concat(pts, part);
  });
  return pts;
}

/**
 * Garbage Day: once a round, the garbage truck brings the golden dumpster to town.
 *
 * Some way into the round (GARBAGE_AT_S) the server picks a spot by a lane inside the NEXT circle
 * (so it's still safe when it gets there), near its middle, and announces it: everyone's minimap
 * shows the truck and where it's headed. The truck drives in from the edge of the map (waiting at
 * the level crossing for the trains), pulls up, beeps, and its side-loader puts the dumpster down by
 * the kerb. Padlocked for a while (everyone heads there), it then bursts open: a fountain of loose
 * loot. The truck drives off out of town. Steal it on the way and the dumpster tips off right there.
 *
 * All the clients get is `state.garbage` (the phase and the spot) and the truck as a car: the
 * lowering, the countdown and the burst are drawn from the phase and its time.
 */
export class GarbageDay {
  private spokes = buildSpokes();
  private startAt = 0;
  private drive: Drive | null = null;
  /** The lane and arc length the truck pulls up at. */
  private stop: { lane: number; s: number } | null = null;
  private rand = mulberry32(0x6a7ba6e);

  constructor(private room: GameRoom) {}

  get g() { return this.room.state.garbage; }

  private truck(): Car | undefined {
    return this.room.carsById.get(this.g.truck);
  }

  /** The truck, made once when the room is (its id never changes), waiting off the map. */
  ensureTruck() {
    if (this.truck()?.kind === CAR_GARBAGE) return;
    const car = this.room.newCar(CAR_GARBAGE, TRUCK_HOME.x, TRUCK_HOME.z, 0);
    this.g.truck = car.id;
    this.room.bodies.get(car.id)!.truck = true;
    this.park();
  }

  /** Whoever drives the truck or rides its roof is put off it (it's going somewhere they can't follow). */
  private evict(car: Car) {
    for (const q of this.room.state.players.values()) {
      if ((q.mode === Mode.Driving || q.mode === Mode.Roof) && q.veh === car.id) {
        q.mode = Mode.Foot; q.veh = -1; q.vy = 0; q.grounded = false;
        q.y = Math.max(q.y, 0);
        q.life = (q.life + 1) & 0xffff;
      }
    }
  }

  /** The truck off the map again, mended, and nothing moves it there. */
  private park() {
    const car = this.truck();
    const body = car ? this.room.bodies.get(car.id) : undefined;
    if (!car || !body) return;
    this.evict(car);
    body.home = true;
    car.x = TRUCK_HOME.x; car.z = TRUCK_HOME.z; car.y = 0; car.yaw = 0;
    car.vx = 0; car.vz = 0; car.steer = 0; car.lights = 0;
    car.driver = ""; car.state = 0; car.hp = CAR_MAX_HP; car.siren = false;
    body.sirenUntil = 0;
    body.vy = 0; body.yawRate = 0; body.ai = null; body.idleSince = this.room.now;
    body.burnUntil = 0; body.wreckUntil = 0; body.lastHitBy = "";
    this.drive = null;
  }

  /** The golden dumpster as the shared step sees it (solid, stood on), once it's down on the street. */
  crate(): SeenCar | null {
    const g = this.g;
    if (g.phase !== GarbagePhase.Locked && g.phase !== GarbagePhase.Open) return null;
    return crateOf(g);
  }

  /** The round went live (at `goAt`): Garbage Day comes this long after. */
  onGo(goAt: number, pace: number) {
    this.startAt = goAt + (GARBAGE_AT_S * 1000) / (pace || 1);
  }

  /** A new round, or warmup: no truck in town, no dumpster. */
  reset() {
    this.startAt = 0;
    this.stop = null;
    const g = this.g;
    g.phase = GarbagePhase.None;
    g.x = 0; g.z = 0; g.yaw = 0; g.at = 0;
    // (someone driving it gets out first: `resetWorld` released every car)
    this.park();
  }

  /** Dev hook: Garbage Day now. */
  startNow() {
    if (this.g.phase === GarbagePhase.None) this.begin();
  }

  step(dt: number) {
    const g = this.g, now = this.room.now;
    if (g.phase === GarbagePhase.None) {
      if (this.room.state.round.phase === RoundPhase.Live && this.startAt > 0 && now >= this.startAt) {
        this.startAt = 0;
        this.begin();
      }
    }
    const car = this.truck();
    if (!car) return;
    const body = this.room.bodies.get(car.id)!;
    // (no Garbage Day on, and it isn't home: a dev-mode restore, say. Off it goes)
    if (g.phase === GarbagePhase.None && !body.home) { this.park(); return; }
    const ours = car.driver === "npc" && car.state === 0;

    switch (g.phase) {
      case GarbagePhase.Coming: {
        // stolen, wrecked or hopelessly stuck on the way: the dumpster tips off right where it is
        if (!ours) { this.dropHere(car); break; }
        if (this.driveOn(car, dt)) {
          g.phase = GarbagePhase.Lowering;
          g.at = now;
          this.room.interest.broadcastNear("garbage", { e: "beep" }, car.x, car.z, NEAR_EVENTS * 1.5);
        } else if (this.drive && now - this.drive.progressAt > 15000) this.dropHere(car);
        break;
      }
      case GarbagePhase.Lowering:
        if (ours) this.holdStill(car);
        if (now >= g.at + GARBAGE_BEEP_S * 1000 + GARBAGE_LOWER_MS) {
          g.phase = GarbagePhase.Locked;
          g.at = now + GARBAGE_LOCK_MS;
          // whoever stands where it came down is shoved out of its way by their own step (it's solid now)
        }
        break;
      case GarbagePhase.Locked:
        if (now >= g.at) this.burst();
        break;
    }

    // after the drop: off out of town, then off the map (or, stuck for good somewhere, home as
    // soon as nobody's near enough to see it go)
    if (g.phase >= GarbagePhase.Locked && ours) {
      if (!this.drive?.leaving) this.planExit(car);
      const d = this.drive;
      if (d && this.driveOn(car, dt)) {
        const ridden = [...this.room.state.players.values()].some((q) => q.mode === Mode.Roof && q.veh === car.id);
        if (!ridden) this.park();
      } else if (d && now - d.progressAt > 20000 && this.unseen(car.x, car.z)) this.park();
    }
    // a wreck that burnt out, out of everyone's way: home
    if (car.state === 2 && now >= body.wreckUntil && !this.hasRiders(car.id)) this.park();
  }

  /** Nobody in the round within sight of (x, z). */
  private unseen(x: number, z: number) {
    for (const [sid, q] of this.room.state.players) {
      if (q.mode === Mode.Dead || !this.room.br.isPlaying(sid)) continue;
      if ((q.x - x) ** 2 + (q.z - z) ** 2 < 70 * 70) return false;
    }
    return true;
  }

  private hasRiders(id: number) {
    for (const q of this.room.state.players.values()) if ((q.mode === Mode.Roof || q.mode === Mode.Driving) && q.veh === id) return true;
    return false;
  }

  // ------------------------------------------------------------------ the plan
  /** Garbage Day: where the dumpster goes, the truck's way there, and it's off. */
  private begin() {
    const target = this.pickStop();
    const car = this.truck();
    if (!target || !car) return;
    // in by the spoke road whose way to the stop is shortest
    let best: { route: P2[]; cost: number } | null = null;
    for (const sp of this.spokes) {
      const starts = new Map<number, number>();
      LANES.forEach((l, i) => { if (l.from === sp.ring) starts.set(i, joinLines(sp.laneIn, l.line).len); });
      const path = cheapest(starts, (li) => (li === target.lane ? target.s : Infinity));
      if (!path) continue;
      const cost = sp.laneIn.len + [...path.slice(0, -1)].reduce((a, li) => a + LANES[li].line.len, 0) + target.s;
      if (best && cost >= best.cost) continue;
      const first = LANES[path[0]].line;
      best = { cost, route: concat(concat(sp.laneIn.pts, joinLines(sp.laneIn, first).pts), laneRoute(path, 0, target.s)) };
    }
    if (!best) return;
    this.stop = target;
    const route = makeLine(best.route);
    this.startDrive(route, false);
    // the truck at the start of its way in (nobody still in it or on it)
    this.evict(car);
    lineAt(route, 0, _p);
    const body = this.room.bodies.get(car.id)!;
    body.home = false;
    car.x = _p.x; car.z = _p.z; car.y = 0; car.yaw = Math.atan2(_p.dx, _p.dz);
    car.vx = 0; car.vz = 0; car.state = 0; car.hp = CAR_MAX_HP; car.driver = "npc";
    // its beacons going round the whole way
    car.siren = true;
    body.sirenUntil = Infinity;
    body.vy = 0; body.yawRate = 0; body.ai = null;
    // where it'll come down, for the minimap
    const g = this.g;
    lineAt(LANES[target.lane].line, target.s, _p);
    const spot = dumpSpot(_p.x, _p.z, Math.atan2(_p.dx, _p.dz));
    setSpot(g, spot);
    g.phase = GarbagePhase.Coming;
    g.at = this.room.now;
    this.room.broadcast("feed", { text: "GARBAGE DAY! The truck's bringing the golden dumpster", i: "car_garbage" });
  }

  /**
   * Where the truck pulls up: by a lane well inside the next circle (and the one it's in now), near
   * the next circle's middle, on a straight bit of a full-width street, with room by the kerb.
   */
  private pickStop(): { lane: number; s: number } | null {
    const z = this.room.state.round.zone;
    const cx = z.x1, cz = z.z1, r = z.r1 > 0 ? z.r1 : z.r0;
    const zone = this.room.br.zone;
    // a random point in the inner part of the next circle, and the best spot near it
    const a = this.rand() * Math.PI * 2, d = Math.sqrt(this.rand()) * r * 0.35;
    const ax = cx + Math.cos(a) * d, az = cz + Math.sin(a) * d;
    let best: { lane: number; s: number } | null = null, bestD = Infinity;
    LANES.forEach((l, li) => {
      if (CITY.roads.edges[l.edge].half < 5 || l.line.len < 24) return;
      for (let s = 8; s <= l.line.len - 8; s += 3) {
        lineAt(l.line, s, _p);
        const x = _p.x, zz = _p.z;
        if (Math.hypot(x - cx, zz - cz) > r - Math.min(30, r * 0.5)) continue;
        if (Math.hypot(x - zone.x, zz - zone.z) > zone.r - 25) continue;
        // straight here (the truck and the dumpster both lie along it)
        const yaw = Math.atan2(_p.dx, _p.dz);
        lineAt(l.line, s - 6, _p); const y0 = Math.atan2(_p.dx, _p.dz);
        lineAt(l.line, s + 6, _p); const y1 = Math.atan2(_p.dx, _p.dz);
        if (Math.abs(wrapAngle(y1 - y0)) > 0.12) continue;
        const spot = dumpSpot(x, zz, yaw);
        if (!roomAt(CITY, spot.x, spot.z, 0, 1.25) || Math.abs(groundHeight(spot.x, spot.z, 1)) > 0.3) continue;
        if (CITY.crossings.some((c) => Math.hypot(c.x - x, c.z - zz) < 14)) continue;
        const dd = (x - ax) ** 2 + (zz - az) ** 2;
        if (dd < bestD) { bestD = dd; best = { lane: li, s }; }
      }
    });
    return best;
  }

  /** Out of town from where the truck stopped (or the lane nearest it): along it, by the nearest spoke road, to the map's edge. */
  private planExit(car: Car) {
    const stop = this.stop ?? nearestLane(car.x, car.z, car.yaw);
    if (!stop) { this.park(); return; }
    const starts = new Map<number, number>([[stop.lane, -stop.s]]);
    const ends = new Map<number, Spoke>();
    for (const sp of this.spokes) LANES.forEach((l, i) => { if (l.to === sp.ring && !ends.has(i)) ends.set(i, sp); });
    const path = cheapest(starts, (li) => (ends.has(li) ? LANES[li].line.len + ends.get(li)!.laneOut.len : Infinity));
    if (!path) return;
    const sp = ends.get(path[path.length - 1])!;
    const last = LANES[path[path.length - 1]].line;
    const pts = concat(concat(laneRoute(path, stop.s, last.len), joinLines(last, sp.laneOut).pts), sp.laneOut.pts);
    this.startDrive(makeLine(pts), true);
  }

  private startDrive(route: Line, leaving: boolean) {
    // the level crossings on the way (the truck waits there for the trains)
    const crossings: number[] = [];
    for (const c of CITY.crossings) {
      const s = nearestOn(route, c.x, c.z, 0, route.len);
      lineAt(route, s, _p);
      if (Math.hypot(_p.x - c.x, _p.z - c.z) < 4) crossings.push(s);
    }
    this.drive = { route, s: 0, crossings, speed: 0, blockedFor: 0, honkAt: 0, progressAt: this.room.now, progressS: 0, leaving };
  }

  // ------------------------------------------------------------------ driving
  /**
   * The truck on along its way (pure pursuit, slower round bends, stopping for whatever's in front
   * of it, a while, then nudging through: it's the biggest thing on the road). True once it's there.
   */
  private driveOn(car: Car, dt: number): boolean {
    const d = this.drive;
    if (!d) return false;
    const now = this.room.now;
    const route = d.route;
    d.s = nearestOn(route, car.x, car.z, d.s - 3, d.s + 8);
    if (d.s - d.progressS > 2) { d.progressS = d.s; d.progressAt = now; }
    const left = route.len - d.s;
    if (left < 0.4 && d.speed < 0.6) { this.holdStill(car); return true; }

    const a = lineAt(route, d.s + 2, { x: 0, z: 0, dx: 0, dz: 0 }), b = lineAt(route, d.s + 16, { x: 0, z: 0, dx: 0, dz: 0 });
    const bend = Math.abs(wrapAngle(Math.atan2(b.dx, b.dz) - Math.atan2(a.dx, a.dz)));
    const c = lineAt(route, Math.min(route.len, d.s + (bend > 0.5 ? 5 : 8)), _p);
    const desired = left < 1.5 ? Math.atan2(c.dx, c.dz) : Math.atan2(c.x - car.x, c.z - car.z);
    const err = wrapAngle(desired - car.yaw);
    let target = Math.abs(err) > 0.4 ? 4 : bend > 0.5 ? 6 : GARBAGE_SPEED;
    // pulling up: easing to a stop right there
    target = Math.min(target, Math.sqrt(2 * 2.5 * Math.max(0, left - 0.2)) + 0.2);
    // a train coming through the crossing ahead: wait for it
    if (d.crossings.some((cs) => cs > d.s && cs - d.s < 22) && !this.crossingClear(route, d)) target = 0;
    // something in the way: stop and honk; after a while, crawl on through it
    const blocker = this.blocked(car);
    if (blocker) {
      d.blockedFor += dt;
      if (now > d.honkAt) {
        this.room.interest.broadcastNear("honk", { id: car.id }, car.x, car.z, NEAR_EVENTS);
        d.honkAt = now + 1800 + this.room.rand() * 1500;
      }
      target = Math.min(target, d.blockedFor > 3 ? 1.5 : 0);
    } else d.blockedFor = 0;

    const acc = target > d.speed ? 3 : 7;
    car.lights = target < d.speed - 0.5 ? CarLight.Brake : 0;
    d.speed += Math.max(-acc * dt, Math.min(acc * dt, target - d.speed));
    const maxTurn = 1.4 * dt * Math.min(1, d.speed / 3);
    car.yaw += Math.max(-maxTurn, Math.min(maxTurn, err));
    car.vx = Math.sin(car.yaw) * d.speed;
    car.vz = Math.cos(car.yaw) * d.speed;
    car.x += car.vx * dt;
    car.z += car.vz * dt;
    car.y = 0;
    car.steer = Math.max(-1, Math.min(1, err * 2));
    // (out on the spokes past the map's edge it's open country: no walls to keep to)
    if (Math.abs(car.x) < MAP_HALF - 2 && Math.abs(car.z) < MAP_HALF - 2) collideCarStatic(car, car.kind, null, this.room.poles);
    return false;
  }

  private holdStill(car: Car) {
    if (this.drive) this.drive.speed = 0;
    car.vx = 0; car.vz = 0; car.steer = 0;
    car.lights = CarLight.Brake;
  }

  /** No train near the level crossings just ahead, now or in the next few seconds. */
  private crossingClear(route: Line, d: Drive): boolean {
    for (const cs of d.crossings) {
      if (cs <= d.s || cs - d.s > 22) continue;
      lineAt(route, cs, _p);
      const x = _p.x, z = _p.z;
      for (let t = 0; t <= 5000; t += 500) {
        for (let slot = 0; slot < TRAIN_SLOTS; slot++) {
          const tp = trainCarPose(slot, this.room.now + t, _tp);
          if (Math.hypot(tp.x - x, tp.z - z) < tp.halfL + 9) return false;
        }
      }
    }
    return true;
  }

  /** Is something (a raccoon on foot, a car, a townsperson) just in front of the truck? */
  private blocked(car: Car): boolean {
    const t = CAR_TYPES[car.kind];
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    const ahead = (x: number, z: number) => {
      const dx = x - car.x, dz = z - car.z, a = dx * fx + dz * fz, l = dx * -fz + dz * fx;
      return a > t.halfL - 0.5 && a < t.halfL + 6 && Math.abs(l) < t.halfW + 0.6;
    };
    for (const p of this.room.state.players.values()) {
      if (p.mode === Mode.Dead || p.mode === Mode.Gull || p.mode === Mode.Sewer || p.y > 2.5) continue;
      if ((p.mode === Mode.Driving || p.mode === Mode.Roof) && p.veh === car.id) continue;
      if (ahead(p.x, p.z)) return true;
    }
    for (const o of this.room.carsById.values()) if (o !== car && ahead(o.x, o.z)) return true;
    for (const n of this.room.state.npcs.values()) if (n.state <= 1 && ahead(n.x, n.z)) return true;
    return false;
  }

  // ------------------------------------------------------------------ the dumpster
  /** The truck didn't make it to the stop (stolen, wrecked, stuck): the dumpster comes off where it is, by the kerb if there's room. */
  private dropHere(car: Car) {
    const g = this.g;
    let spot = dumpSpot(car.x, car.z, car.yaw);
    if (!roomAt(CITY, spot.x, spot.z, 0, 1.2) || Math.abs(groundHeight(spot.x, spot.z, 1)) > 0.3) {
      // behind it, then
      const bx = car.x - Math.sin(car.yaw) * (CAR_TYPES[car.kind].halfL + 1.4), bz = car.z - Math.cos(car.yaw) * (CAR_TYPES[car.kind].halfL + 1.4);
      spot = { x: bx, z: bz, yaw: car.yaw + Math.PI / 2 };
      if (!roomAt(CITY, bx, bz, 0, 1.2)) spot = { x: g.x, z: g.z, yaw: g.yaw };
    }
    setSpot(g, spot);
    // (no beeping: it just falls off)
    g.phase = GarbagePhase.Lowering;
    g.at = this.room.now - GARBAGE_BEEP_S * 1000;
    this.drive = null;
    this.stop = null;
    this.room.broadcast("feed", { text: "The golden dumpster fell off the truck!", i: "dumpster_gold" });
  }

  /** Padlock off: the loot fountains out of it, into a ring round it. */
  private burst() {
    const g = this.g, now = this.room.now;
    g.phase = GarbagePhase.Open;
    g.at = now;
    const from = { x: g.x, y: DUMPSTER_H + 0.2, z: g.z };
    const n = GARBAGE_LOOT.length;
    const turn = this.rand() * Math.PI * 2;
    GARBAGE_LOOT.forEach((kind, k) => {
      let spot: { x: number; y: number; z: number } | null = null;
      for (let tries = 0; tries < 10 && !spot; tries++) {
        const a = turn + (k / n) * Math.PI * 2 + (this.rand() - 0.5) * 0.5 + tries * 0.7;
        const r = GARBAGE_LOOT_R[0] + (GARBAGE_LOOT_R[1] - GARBAGE_LOOT_R[0]) * (tries > 4 ? 0.2 : this.rand());
        const x = g.x + Math.cos(a) * r, z = g.z + Math.sin(a) * r;
        if (Math.abs(x) > MAP_HALF - 4 || Math.abs(z) > MAP_HALF - 4) continue;
        if (!roomAt(CITY, x, z, 0.2, 0.45) || circleObb(x, z, 0.5, g.x, g.z, g.yaw, DUMPSTER_HW, DUMPSTER_HD)) continue;
        const y = groundHeight(x, z, 0.5);
        if (y > 0.5) continue;
        spot = { x, y, z };
      }
      if (!spot) spot = { x: g.x + Math.cos(turn + k) * 1.6, y: 0, z: g.z + Math.sin(turn + k) * 1.6 };
      this.room.loot.add(kind, from, spot, now + LOOSE_FLIGHT_MS + k * 70);
    });
    this.room.broadcast("feed", { text: "The golden dumpster burst open!", i: "dumpster_gold" });
  }

  /** A car (AI or free) that ran into the dumpster: out of it again (the shared step does the same for drivers). */
  pushOut(car: Car) {
    const c = this.crate();
    if (!c || car.y > c.roof) return;
    const t = CAR_TYPES[car.kind], off = t.halfL - t.halfW;
    for (const sgn of [1, -1]) {
      const cx = car.x + Math.sin(car.yaw) * off * sgn, cz = car.z + Math.cos(car.yaw) * off * sgn;
      if (!circleObb(cx, cz, t.halfW, c.x, c.z, c.yaw, c.halfW, c.halfL, _n)) continue;
      car.x += _n.x * _n.depth; car.z += _n.z * _n.depth;
      const vn = car.vx * _n.x + car.vz * _n.z;
      if (vn < 0) { car.vx -= 1.3 * vn * _n.x; car.vz -= 1.3 * vn * _n.z; }
    }
  }

  /** Is the dumpster just in front of a car at (x, z) facing `yaw` (so AI traffic waits behind it)? */
  inTheWay(x: number, z: number, yaw: number, halfL: number): boolean {
    const c = this.crate();
    if (!c) return false;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const px = x + fx * (halfL + 2.5), pz = z + fz * (halfL + 2.5);
    return circleObb(px, pz, 1.3, c.x, c.z, c.yaw, c.halfW, c.halfL);
  }
}

/** The dumpster's spot, at float32: what every client decodes, so the box they stand on is the server's. */
function setSpot(g: { x: number; z: number; yaw: number }, s: { x: number; z: number; yaw: number }) {
  g.x = Math.fround(s.x); g.z = Math.fround(s.z); g.yaw = Math.fround(s.yaw);
}

/** The lane nearest (x, z) heading about `yaw` (within 6 m), and how far along it. */
function nearestLane(x: number, z: number, yaw: number): { lane: number; s: number } | null {
  let best: { lane: number; s: number } | null = null, bestD = 36;
  LANES.forEach((l, i) => {
    const s = nearestOn(l.line, x, z, 0, l.line.len);
    lineAt(l.line, s, _p);
    const d = (_p.x - x) ** 2 + (_p.z - z) ** 2;
    if (d < bestD && Math.cos(Math.atan2(_p.dx, _p.dz) - yaw) > 0.3) { bestD = d; best = { lane: i, s }; }
  });
  return best;
}
