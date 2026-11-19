import { AI_TRAFFIC, CAR_MAX_HP, CAR_TYPES, CarLight, Mode, NEAR_EVENTS, PARKED_CARS, PlayerStatus } from "../shared/constants.js";
import { lineAt, type Line } from "../shared/geom.js";
import { connector, LANES } from "../shared/lanes.js";
import { CITY } from "../shared/map.js";
import type { Car, Npc, Player } from "../shared/schema.js";
import { coastCar, collideCarStatic, wrapAngle } from "../shared/sim.js";
import type { GameRoom } from "./GameRoom.js";
import { Spots } from "./Spots.js";

export interface AiState {
  /** The lane we're on (index into LANES), and how far along it (m). */
  lane: number;
  s: number;
  /** The lane we'll turn into at its end, and whether we're on the curve into it yet (`s` then runs along that). */
  next: number;
  turning: boolean;
  speed: number;
  blockedFor: number;
  ignoreUntil: number;
  honkAt: number;
  /** Where we were a few seconds ago, and how long we've hardly moved (unstuck by putting us elsewhere). */
  checkX: number; checkZ: number; checkAt: number; stuckFor: number;
}

export interface CarBody {
  vy: number;
  yawRate: number;
  ai: AiState | null;
  idleSince: number;
  burnUntil: number;
  wreckUntil: number;
  lastHitBy: string;
  sirenUntil: number;
  /** The garbage truck: Garbage Day drives it (`GarbageDay`), never the traffic AI. */
  truck?: boolean;
  /** …and while it waits off the map between days, nothing moves it at all. */
  home?: boolean;
}

const _p = { x: 0, z: 0, dx: 0, dz: 0 };

export class Traffic {
  // (this step's positions, for `blocked`)
  private readonly cars = new Spots<Car>();
  private readonly people = new Spots<Player>();
  private readonly walkers = new Spots<Npc>();

  constructor(private room: GameRoom) {}

  populate() {
    const r = this.room.rand;
    for (let i = 0; i < AI_TRAFFIC; i++) {
      const kind = i % 7 === 3 ? 2 : i % 5 === 1 ? 1 : i % 9 === 4 ? 3 : 0;
      const car = this.room.newCar(kind, 0, 0, 0);
      this.placeOnLane(car, i * 7 + Math.floor(r() * 5));
    }
    const spots = [...CITY.parking];
    for (let i = 0; i < Math.min(PARKED_CARS, spots.length); i++) {
      const s = spots[i];
      const kind = i % 6 === 2 ? 3 : i % 4 === 1 ? 1 : 0;
      this.room.newCar(kind, s.x, s.z, s.yaw);
    }
  }

  /**
   * A new round: AI cars back onto the lanes, parked cars back home (repaired, wrecks
   * repainted). Car ids, and so the synced entities, stay the same.
   */
  resetAll() {
    for (const car of this.room.carsById.values()) {
      const body = this.room.bodies.get(car.id)!;
      // (the garbage truck goes home with Garbage Day's reset)
      if (body.truck) continue;
      if (car.state === 2) car.paint = CAR_TYPES[car.kind].paint[Math.floor(this.room.rand() * CAR_TYPES[car.kind].paint.length)];
      car.siren = false;
      body.sirenUntil = 0;
      if (car.id <= AI_TRAFFIC) {
        this.placeOnLane(car, (car.id - 1) * 7 + Math.floor(this.room.rand() * 5));
        continue;
      }
      // parked cars were created after the AI ones, in parking-spot order
      const home = CITY.parking[car.id - AI_TRAFFIC - 1];
      if (home) { car.x = home.x; car.z = home.z; car.yaw = home.yaw; }
      car.y = 0; car.vx = 0; car.vz = 0; car.steer = 0;
      car.driver = "";
      car.state = 0;
      car.hp = CAR_MAX_HP;
      body.vy = 0; body.yawRate = 0; body.ai = null; body.idleSince = this.room.now;
      body.burnUntil = 0; body.wreckUntil = 0; body.lastHitBy = "";
    }
  }

  /** Put `car` on a lane as AI traffic, using `seed` to pick the spot (inside the fumes' circle, if it can). */
  placeOnLane(car: Car, seed: number) {
    for (let k = 0; k < 12; k++) {
      const s = seed + k * 131;
      this.placeAt(car, s);
      if (!this.room.br.outside(car.x, car.z)) return;
    }
  }

  private placeAt(car: Car, seed: number) {
    // somewhere along the middle half of a lane long enough, not on top of another car
    const ok = LANES.flatMap((l, i) => (l.line.len > 20 ? [i] : []));
    let lane = ok[seed % ok.length], s = 0;
    for (let k = 0; k < 8; k++) {
      lane = ok[(seed + k * 37) % ok.length];
      const l = LANES[lane].line;
      s = l.len * (0.25 + 0.5 * ((seed * 0.618 + k * 0.31) % 1));
      lineAt(l, s, _p);
      let clear = true;
      for (const o of this.room.carsById.values()) if (o !== car && (o.x - _p.x) ** 2 + (o.z - _p.z) ** 2 < 81) clear = false;
      if (clear) break;
    }
    lineAt(LANES[lane].line, s, _p);
    car.x = _p.x;
    car.z = _p.z;
    car.y = 0;
    car.yaw = Math.atan2(_p.dx, _p.dz);
    car.vx = 0; car.vz = 0;
    car.driver = "npc";
    car.state = 0;
    car.hp = CAR_MAX_HP;
    const body = this.room.bodies.get(car.id)!;
    body.vy = 0; body.yawRate = 0;
    body.ai = {
      lane, s, next: this.chooseNext(lane), turning: false, speed: 0, blockedFor: 0, ignoreUntil: 0, honkAt: 0,
      checkX: car.x, checkZ: car.z, checkAt: this.room.now, stuckFor: 0,
    };
    body.burnUntil = 0; body.wreckUntil = 0; body.lastHitBy = "";
  }

  /**
   * Which lane to turn into at the end of `lane`: straight on twice as often as a turn, never
   * back unless it's a dead end. During a round, only lanes that end well inside the fumes'
   * circle, or failing that the one that ends nearest its middle.
   */
  private chooseNext(lane: number): number {
    const l = LANES[lane];
    lineAt(l.line, l.line.len, _p);
    const ex = _p.dx, ez = _p.dz;
    let options: number[] = [];
    for (const n of l.next) {
      lineAt(LANES[n].line, 0, _p);
      const straight = ex * _p.dx + ez * _p.dz > 0.85;
      options.push(n, ...(straight ? [n] : []));
    }
    if (this.room.br.live) {
      const z = this.room.br.zone;
      const depth = (n: number) => {
        const end = CITY.roads.nodes[LANES[n].to];
        return Math.hypot(end.x - z.x, end.z - z.z) - z.r;
      };
      const safe = options.filter((n) => depth(n) <= -8);
      options = safe.length ? safe : [options.reduce((a, b) => (depth(a) <= depth(b) ? a : b))];
    }
    return options[Math.floor(this.room.rand() * options.length)];
  }

  /** The line we're driving along now: our lane, or the curve from it into the next one. */
  private piece(ai: AiState): Line {
    return ai.turning ? connector(LANES, ai.lane, ai.next) : LANES[ai.lane].line;
  }

  /** The point `d` m further along our way from `s`: through the turn and on into the next lane. */
  private ahead(ai: AiState, d: number, out: typeof _p) {
    let line = this.piece(ai), s = ai.s + d;
    if (s > line.len) {
      s -= line.len;
      if (!ai.turning) {
        line = connector(LANES, ai.lane, ai.next);
        if (s > line.len) { s -= line.len; line = LANES[ai.next].line; }
      } else line = LANES[ai.next].line;
    }
    return lineAt(line, s, out);
  }

  step(dt: number) {
    const now = this.room.now;
    let aiCount = 0;
    // what an AI car might stop for (`blocked`), read once; each car's entry follows it as it moves
    const cars = this.cars.reset(), people = this.people.reset(), walkers = this.walkers.reset();
    for (const car of this.room.carsById.values()) cars.add("", car, car.x, car.z);
    for (const p of this.room.state.players.values()) people.add("", p, p.x, p.z);
    for (const n of this.room.state.npcs.values()) walkers.add("", n, n.x, n.z);
    for (let k = 0; k < cars.n; k++) {
      const car = cars.items[k];
      if (this.stepCar(car, k, dt, now)) aiCount++;
      cars.x[k] = car.x; cars.z[k] = car.z;
    }

    // keep the streets busy: recycle abandoned cars nobody is looking at
    if (aiCount < AI_TRAFFIC) {
      for (const car of this.room.carsById.values()) {
        const body = this.room.bodies.get(car.id)!;
        if (car.driver !== "" || car.state !== 0 || body.ai || body.truck) continue;
        if (now - body.idleSince < 25000 || this.hasRiders(car.id)) continue;
        if (!this.farFromPlayers(car.x, car.z, 60)) continue;
        this.placeOnLane(car, Math.floor(this.room.rand() * 1000));
        if (!this.farFromPlayers(car.x, car.z, 40)) { car.driver = ""; body.ai = null; body.idleSince = now; continue; }
        break;
      }
    }
  }

  /** One car's step (`k`: its entry in `cars`). True if it's AI traffic. */
  private stepCar(car: Car, k: number, dt: number, now: number): boolean {
    const body = this.room.bodies.get(car.id)!;
    if (body.home) return false;

    if (car.state === 2) {
      this.freeBody(car, body, dt);
      if (!body.truck && now >= body.wreckUntil && !this.hasRiders(car.id) && this.farFromPlayers(car.x, car.z, 45)) this.respawnWreck(car);
      return false;
    }
    if (car.state === 1 && now >= body.burnUntil) {
      this.room.combat.explodeCar(car);
      return false;
    }
    if (car.siren && now > body.sirenUntil) car.siren = false;

    const playerDriven = car.driver !== "" && car.driver !== "npc";
    if (playerDriven) return false;
    // (Garbage Day drives the truck)
    if (body.truck && car.driver === "npc") return false;
    // (the AI brakes in `drive`; nobody's feet are on the pedals of a free car)
    if (car.lights !== 0) car.lights = 0;

    if (car.driver === "npc" && body.ai) {
      if (car.y > 0.01 || body.vy !== 0) this.freeBody(car, body, dt);
      else this.drive(car, k, body.ai, dt);
      return true;
    }
    this.freeBody(car, body, dt);
    return false;
  }

  private hasRiders(id: number) {
    for (const p of this.room.state.players.values()) if ((p.mode === Mode.Roof || p.mode === Mode.Driving) && p.veh === id) return true;
    return false;
  }

  /** No player still in the game near (x, z) (spectators' parked bodies don't count). */
  private farFromPlayers(x: number, z: number, d: number) {
    for (const [sid, p] of this.room.state.players) {
      if (p.mode === Mode.Dead || this.room.info(sid)?.status !== PlayerStatus.Playing) continue;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < d * d) return false;
    }
    return true;
  }

  private respawnWreck(car: Car) {
    const kind = car.kind;
    const type = CAR_TYPES[kind];
    car.paint = type.paint[Math.floor(this.room.rand() * type.paint.length)];
    this.placeOnLane(car, Math.floor(this.room.rand() * 1000));
  }

  // ------------------------------------------------------------------ AI driving
  private drive(car: Car, k: number, ai: AiState, dt: number) {
    const now = this.room.now;
    // how far along our way we are: the nearest point of the line we're on, a little behind to a
    // little ahead of where we were
    let line = this.piece(ai);
    ai.s = nearestOn(line, car.x, car.z, ai.s - 3, ai.s + 6);
    // (on the curve, but already nearer the lane it leads into: carry on along that)
    if (ai.turning) {
      const nl = LANES[ai.next].line;
      lineAt(line, ai.s, _p);
      const dc = (_p.x - car.x) ** 2 + (_p.z - car.z) ** 2;
      lineAt(nl, nearestOn(nl, car.x, car.z, 0, 4), _p);
      if ((_p.x - car.x) ** 2 + (_p.z - car.z) ** 2 < dc - 0.01) ai.s = line.len;
    }
    if (ai.s >= line.len - 0.3) {
      if (!ai.turning) { ai.turning = true; ai.s = 0; }
      else { ai.lane = ai.next; ai.turning = false; ai.s = 0; ai.next = this.chooseNext(ai.lane); }
      line = this.piece(ai);
      ai.s = nearestOn(line, car.x, car.z, 0, 6);
    }
    // slower into a bend: how much the way turns over the next 14 m
    const a = this.ahead(ai, 2, { x: 0, z: 0, dx: 0, dz: 0 }), b = this.ahead(ai, 14, { x: 0, z: 0, dx: 0, dz: 0 });
    const bend = Math.abs(wrapAngle(Math.atan2(b.dx, b.dz) - Math.atan2(a.dx, a.dz)));
    // pure pursuit toward a carrot 7 m ahead on our way (nearer through a turn, not to cut its corner)
    const c = this.ahead(ai, ai.turning || bend > 0.6 ? 4 : 7, _p);
    const desired = Math.atan2(c.x - car.x, c.z - car.z);
    const err = wrapAngle(desired - car.yaw);

    let targetSpeed = Math.abs(err) > 0.35 ? 6 : bend > 0.6 ? 7 : car.kind === 2 ? 13 : 11;

    // look ahead for anything in our way
    if (now > ai.ignoreUntil) {
      const blocker = this.blocked(car, k);
      if (blocker) {
        targetSpeed = 0;
        ai.blockedFor += dt;
        if (blocker === "player" && now > ai.honkAt) {
          this.room.interest.broadcastNear("honk", { id: car.id }, car.x, car.z, NEAR_EVENTS);
          ai.honkAt = now + 2500 + this.room.rand() * 2000;
        }
        if (ai.blockedFor > 2.5) { ai.ignoreUntil = now + 1500; ai.blockedFor = 0; }
      } else ai.blockedFor = 0;
    }

    const acc = targetSpeed > ai.speed ? 5 : 14;
    if (targetSpeed < ai.speed - 0.5) car.lights = CarLight.Brake;
    ai.speed += Math.max(-acc * dt, Math.min(acc * dt, targetSpeed - ai.speed));
    const maxTurn = 1.9 * dt * Math.min(1, ai.speed / 3);
    car.yaw += Math.max(-maxTurn, Math.min(maxTurn, err));
    car.vx = Math.sin(car.yaw) * ai.speed;
    car.vz = Math.cos(car.yaw) * ai.speed;
    car.x += car.vx * dt;
    car.z += car.vz * dt;
    car.steer = Math.max(-1, Math.min(1, err * 2));
    collideCarStatic(car, car.kind, null, this.room.poles);
    this.room.garbage?.pushOut(car);

    // hardly moved in 4 s (wedged somewhere, not just waiting behind someone): after 8 s of that,
    // with nobody around to see, it's put somewhere else
    if (now - ai.checkAt > 4000) {
      const moved = Math.hypot(car.x - ai.checkX, car.z - ai.checkZ);
      ai.stuckFor = moved < 2 && ai.blockedFor === 0 ? ai.stuckFor + (now - ai.checkAt) / 1000 : 0;
      ai.checkX = car.x; ai.checkZ = car.z; ai.checkAt = now;
      if (ai.stuckFor >= 8 && this.farFromPlayers(car.x, car.z, 60)) this.placeOnLane(car, Math.floor(this.room.rand() * 1000));
    }
  }

  private blocked(car: Car, self: number): "player" | "other" | null {
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    const type = CAR_TYPES[car.kind];
    const cx = car.x, cz = car.z, near = type.halfL - 0.5, far = type.halfL + 7;
    const test = (x: number, z: number) => {
      const dx = x - cx, dz = z - cz;
      const a = dx * fx + dz * fz;
      const l = dx * -fz + dz * fx;
      return a > near && a < far && Math.abs(l) < 1.7;
    };
    const { people, cars, walkers } = this;
    for (let i = 0; i < people.n; i++) {
      if (!test(people.x[i], people.z[i])) continue;
      const p = people.items[i];
      if (p.mode === Mode.Dead || p.mode === Mode.Gull || p.mode === Mode.Sewer || p.y > 2.5) continue;
      if (p.mode === Mode.Driving && p.veh === car.id) continue;
      return "player";
    }
    // the golden dumpster, down by the kerb
    if (this.room.garbage?.inTheWay(car.x, car.z, car.yaw, type.halfL)) return "other";
    for (let i = 0; i < cars.n; i++) if (i !== self && test(cars.x[i], cars.z[i])) return "other";
    for (let i = 0; i < walkers.n; i++) if (test(walkers.x[i], walkers.z[i]) && walkers.items[i].state <= 1) return "other";
    return null;
  }

  // ------------------------------------------------------------------ free bodies
  /** A car nobody drives: it coasts, slides, flies and lands (shared with the client). */
  freeBody(car: Car, body: CarBody, dt: number) {
    coastCar(car, car.kind, body, dt, this.room.poles);
    this.room.garbage?.pushOut(car);
  }
}

/** Arc length along `l` of the point nearest (x, z), looking between arc lengths s0 and s1. */
export function nearestOn(l: Line, x: number, z: number, s0: number, s1: number): number {
  const { pts, cum } = l;
  let best = Math.max(0, Math.min(l.len, s0)), bestD = Infinity;
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] < s0 || cum[i - 1] > s1) continue;
    const a = pts[i - 1], b = pts[i], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + dx * t - x, pz = a.z + dz * t - z, d = px * px + pz * pz;
    if (d < bestD) { bestD = d; best = cum[i - 1] + (cum[i] - cum[i - 1]) * t; }
  }
  return best;
}
