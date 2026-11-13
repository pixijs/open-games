import type { RewindView } from "colyseus";
import { CAR_FUSE_MS, CAR_TYPES, Mode, NEAR_BOOMS, NEAR_EVENTS, NPC_HIT_R, NpcState, PLAYER_RADIUS, RUN_OVER_CLOSING, RUN_OVER_SPEED, TICK_RATE, ticks, Weapon, WEAPONS } from "../shared/constants.js";
import { BIN_R, CITY, circleObb, type XZ } from "../shared/map.js";
import {
  AIM_Q, BLAST_KNOCKDOWN, gullTarget, newPellet, pelletDamage, pelletDir, RACCOON_TOP, shotHeight, shotYaw, tracePellet, TOWNSFOLK_TOP, type ShotTarget,
} from "../shared/hitscan.js";
import type { Car, Npc, Player } from "../shared/schema.js";
import { localToWorld, type RunOver } from "../shared/sim.js";
import { TRAIN_SLOTS, trainCarPose, trainPointWorld, type CarPose } from "../shared/train.js";
import type { GameRoom } from "./GameRoom.js";
import { Spots } from "./Spots.js";

const _xz: XZ = { x: 0, z: 0 };
const _n: XZ & { depth: number } = { x: 0, z: 0, depth: 0 };
const _train: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };
const POS3 = ["x", "y", "z"] as const;
const POSY = ["y"] as const;
const LOCAL2 = ["lx", "lz"] as const;
const CARPOSE = ["x", "z", "yaw"] as const;
const scratch3 = { x: 0, y: 0, z: 0 };
const scratchY = { y: 0 };
const _xyz = { x: 0, y: 0, z: 0 };
const _pellet = newPellet();
const _dir = { yaw: 0, pitch: 0 };
type XYZ = { x: number; y: number; z: number };
const scratchL = { lx: 0, lz: 0 };
const scratchC = { x: 0, z: 0, yaw: 0 };

type Target =
  | { kind: "player"; sid: string; p: Player }
  | { kind: "gull"; sid: string; p: Player }
  | { kind: "npc"; npc: Npc }
  | { kind: "car"; car: Car }
  | { kind: "bin"; i: number };

export class Combat {
  /** Pairs of player-driven cars that just crashed (key "a:b" → room ms). */
  private bumpUntil = new Map<string, number>();
  // (stepCollisions' scratch)
  private readonly cars = new Spots<Car>();
  private readonly feet = new Spots<Player>();
  private readonly peds = new Spots<Npc>();
  private readonly halfL: number[] = [];
  private readonly ys: number[] = [];

  constructor(private room: GameRoom) {}

  // ------------------------------------------------------------------ shooting
  /**
   * Hitscan along `aim` (yaw) and `pitch` (up, rad: where the shooter's crosshair was), from
   * the gun or (`eye`: over the raccoon's back) the crosshair's line over its head, judged
   * against the world AS THE SHOOTER SAW IT: every target is rewound to the shooter's render
   * time with `rewind.lastSeenBy()`. Riders are rebuilt the same way the client draws them:
   * (rewound car or timetable train) ⊕ (rewound local offset).
   */
  fire(sid: string, p: Player, aim: number, pitch: number, eye: boolean, time: number, tick: number) {
    if (p.weapon === Weapon.Fists) return this.melee(sid, p, aim, time, tick);
    const w = WEAPONS[p.weapon];
    const seen = this.room.rewind.lastSeenBy(sid);
    const ox = p.x, oz = p.z, oy = shotHeight(p.x, p.y, p.z, p.mode === Mode.Driving, eye);
    // (as sent to everyone watching: they trace the pellets from it themselves)
    const yaw = Math.round(shotYaw(aim, p.weapon, tick) * AIM_Q) / AIM_Q;
    let hits = 0;

    // everything the shot could hit, where the shooter saw it
    const targets: ShotTarget[] = [];
    const what: Target[] = [];
    for (const [qsid, q] of this.room.state.players) {
      if (qsid === sid || q.mode === Mode.Dead) continue;
      // a gull is a small target up in the air (a hit shoos it: it's out of the round, nothing hurts
      // it). One that only just hatched (or just landed) is a gull to one side of the rewind and a
      // body to the other: no target at all, rather than a raccoon to knock about
      const gullNow = q.mode === Mode.Gull, gullSeen = seen.value(q, "mode") === Mode.Gull;
      if (gullNow !== gullSeen) continue;
      const pos = this.seenPlayer(q, seen, time);
      if (!pos) continue;
      if (gullNow) {
        targets.push(gullTarget(pos.x, pos.y, pos.z));
        what.push({ kind: "gull", sid: qsid, p: q });
        continue;
      }
      targets.push({ x: pos.x, z: pos.z, y0: pos.y, y1: pos.y + RACCOON_TOP, y: pos.y + 0.9, r: PLAYER_RADIUS + 0.2 });
      what.push({ kind: "player", sid: qsid, p: q });
    }
    for (const npc of this.room.state.npcs.values()) {
      if (npc.state > NpcState.Flying) continue;
      const pos = seen.read(npc, POS3, scratch3);
      targets.push({ x: pos.x, z: pos.z, y0: pos.y, y1: pos.y + TOWNSFOLK_TOP, y: pos.y + 0.8, r: 0.5 });
      what.push({ kind: "npc", npc });
    }
    for (const car of this.room.carsById.values()) {
      if (car.state === 2 || (p.mode === Mode.Driving && car.id === p.veh)) continue;
      const type = CAR_TYPES[car.kind];
      const pose = car.driver === sid ? car : seen.read(car, CARPOSE, scratchC);
      targets.push({ x: pose.x, z: pose.z, y0: car.y, y1: car.y + type.roof, y: car.y + type.roof * 0.55, r: 0, yaw: pose.yaw, hw: type.halfW, hl: type.halfL });
      what.push({ kind: "car", car });
    }

    // each pellet: where it went (pellets in one target add up, and it takes them once, below)
    const pellets = new Array<number>(targets.length).fill(0), damage = new Array<number>(targets.length).fill(0);
    const bins: number[] = [];
    for (let k = 0; k < w.pellets; k++) {
      pelletDir(yaw, pitch, p.weapon, k, _dir);
      tracePellet(ox, oy, oz, _dir.yaw, _dir.pitch, w.range, targets, _pellet);
      // a trash can: its lid flies off, and if someone hides in it, out they pop (unhurt: the can took it)
      if (_pellet.bin >= 0 && !bins.includes(_pellet.bin)) {
        bins.push(_pellet.bin);
        this.room.bins.hit(_pellet.bin, sid, Math.sin(_dir.yaw), Math.cos(_dir.yaw));
      }
      if (_pellet.target < 0) continue;
      pellets[_pellet.target]++;
      damage[_pellet.target] += pelletDamage(p.weapon, _pellet.t);
    }
    const blast = w.pellets > 1;
    for (let i = 0; i < targets.length; i++) {
      const n = pellets[i];
      if (!n) continue;
      hits++;
      const target = what[i];
      // (pushed away from the shooter)
      const tx = targets[i].x - ox, tz = targets[i].z - oz, tl = Math.hypot(tx, tz) || 1;
      const ux = tl > 0.01 ? tx / tl : Math.sin(yaw), uz = tl > 0.01 ? tz / tl : Math.cos(yaw);
      if (target.kind === "gull") {
        this.room.gulls.shoo(target.sid, target.p, sid, ux, uz);
      } else if (target.kind === "player") {
        this.damagePlayer(target.p, target.sid, damage[i], sid, w.name);
        // a blast: most of it in you knocks you off your feet (a knock-down the shared step plays
        // out, on your screen too); less of it doesn't shove you at all (a shove nobody's client
        // predicted would only show up as a correction). A gun's single pellet nudges, as ever.
        if (blast) { if (n >= BLAST_KNOCKDOWN) this.knock(target.p, ux * 1.8 * n, 3 + 0.5 * n, uz * 1.8 * n, ticks(0.8)); }
        else if (target.p.mode === Mode.Foot) { target.p.vx += ux * w.knockback; target.p.vz += uz * w.knockback; }
      } else if (target.kind === "npc") {
        const push = 2 + (blast ? 1.5 * n : w.knockback);
        this.room.peds.launch(target.npc, ux * push, 3.5 + (blast ? 0.3 * n : 0), uz * push);
        this.reward(sid, 10, target.npc.x, target.npc.z);
      } else if (target.kind === "car") {
        this.damageCar(target.car, damage[i], sid);
      }
    }

    this.room.peds.scare(ox, oz, 22);
    const client = this.room.clients.getById(sid);
    // only the aim (cm, 1/AIM_Q rad: small ints, ~30 bytes): the pellets are traced from it by everyone watching
    const cm = (v: number) => Math.round(v * 100);
    this.room.interest.broadcastNear("shot", [sid, p.weapon, cm(ox), cm(oy), cm(oz), Math.round(yaw * AIM_Q), Math.round(pitch * AIM_Q)], ox, oz, NEAR_EVENTS, client);
    if (hits && client) client.send("hit", { t: tick });
  }

  /**
   * Where `q` was on the shooter's screen (its feet). Drivers are inside their car (the car
   * takes the hit), and hiders inside their trash can (the can does). The mode and the car
   * ridden are rewound too, so a rider's local offset is read against the platform it was
   * relative to at that instant.
   */
  private seenPlayer(q: Player, seen: RewindView, time: number): XYZ | null {
    const veh = seen.value(q, "veh");
    switch (seen.value(q, "mode")) {
      case Mode.Driving:
      case Mode.Hidden:
      case Mode.Sewer: return null;
      case Mode.Roof: {
        const car = this.room.carsById.get(veh);
        if (!car) return null;
        const pose = seen.read(car, CARPOSE, scratchC);
        const l = seen.read(q, LOCAL2, scratchL);
        localToWorld(pose, l.lx, l.lz, _xz);
        _xyz.x = _xz.x; _xyz.z = _xz.z; _xyz.y = seen.read(q, POSY, scratchY).y;
        return _xyz;
      }
      case Mode.Train: {
        const l = seen.read(q, LOCAL2, scratchL);
        trainPointWorld(veh, time, l.lx, l.lz, _xz);
        _xyz.x = _xz.x; _xyz.z = _xz.z; _xyz.y = seen.read(q, POSY, scratchY).y;
        return _xyz;
      }
      default: {
        const pos = seen.read(q, POS3, scratch3);
        _xyz.x = pos.x; _xyz.y = pos.y; _xyz.z = pos.z;
        return _xyz;
      }
    }
  }

  /** Fists: a short cone in front of the puncher, also lag compensated. */
  private melee(sid: string, p: Player, aim: number, time: number, tick: number) {
    const seen = this.room.rewind.lastSeenBy(sid);
    const dx = Math.sin(aim), dz = Math.cos(aim);
    let hit = false;
    // (r: the radius of what's in front, from its middle)
    const inReach = (x: number, z: number, r = 0) => {
      const rx = x - p.x, rz = z - p.z;
      const along = rx * dx + rz * dz;
      const side = Math.abs(rx * dz - rz * dx);
      return along > -0.2 && along - r < WEAPONS[0].range && side < 0.9 + r * 0.5;
    };
    for (const [qsid, q] of this.room.state.players) {
      if (qsid === sid || q.mode === Mode.Dead || q.mode === Mode.Driving) continue;
      if ((q.mode === Mode.Gull) !== (seen.value(q, "mode") === Mode.Gull)) continue;
      const pos = this.seenPlayer(q, seen, time);
      if (!pos || !inReach(pos.x, pos.z)) continue;
      // a gull swatted out of the air (a low one: it hovers over a paw's reach of the street)
      if (q.mode === Mode.Gull) {
        if (pos.y - p.y > 2.2 || pos.y < p.y - 0.5) continue;
        hit = true;
        this.room.gulls.shoo(qsid, q, sid, dx, dz);
        continue;
      }
      if (Math.abs(q.y - p.y) > 1.2) continue;
      hit = true;
      this.knock(q, dx * 7, 5, dz * 7, ticks(0.6));
      this.damagePlayer(q, qsid, WEAPONS[0].damage, sid, WEAPONS[Weapon.Fists].name);
    }
    for (const npc of this.room.state.npcs.values()) {
      if (npc.state > NpcState.Flee) continue;
      const pos = seen.read(npc, POS3, scratch3);
      if (!inReach(pos.x, pos.z) || Math.abs(pos.y - p.y) > 1.2) continue;
      hit = true;
      this.room.peds.launch(npc, dx * 8, 5, dz * 8);
      this.reward(sid, 10, npc.x, npc.z);
    }
    // a slap on a trash can knocks its lid off (and whoever's inside out)
    CITY.bins.forEach((b, i) => {
      if (Math.abs(b.y - p.y) < 1.2 && inReach(b.x, b.z, BIN_R)) this.room.bins.hit(i, sid, dx, dz);
    });
    const client = this.room.clients.getById(sid);
    if (hit && client) client.send("hit", { t: tick });
    this.room.interest.broadcastNear("punch", { s: sid }, p.x, p.z, NEAR_EVENTS, client);
  }

  // ------------------------------------------------------------------ damage
  /**
   * `carKind` (≥ 0) tells the kill feed which car did it (cause "Bumper"). Nobody can be
   * hurt while a round is frozen or over, nor once out of it. A death nobody dealt
   * (fumes, trains, falls) goes to whoever hurt the victim last, within a few seconds.
   */
  damagePlayer(q: Player, qsid: string, dmg: number, attacker: string | null, cause: string, carKind = -1) {
    if (q.mode === Mode.Dead) return;
    const br = this.room.br;
    if (!br.canHurt(qsid)) return;
    // hurt in a trash can by something the can doesn't stop (the fumes): out you hop
    if (q.mode === Mode.Hidden) this.room.bins.eject(qsid, q, 0, 0, false);
    if (attacker && attacker !== qsid) br.noteHit(qsid, attacker);
    q.hp = Math.max(0, q.hp - Math.round(dmg));
    if (q.hp > 0) return;
    q.vy = Math.max(q.vy, 6);
    q.grounded = false;
    const credit = attacker && attacker !== qsid ? attacker : br.lastHitter(qsid);
    this.room.killPlayer(q, qsid, credit);
    const ki = credit ? this.room.info(credit) : undefined;
    if (ki) {
      ki.kills++;
      ki.roundKills++;
      ki.score += 100;
      const killer = this.room.state.players.get(credit);
      if (killer) br.rewardKill(killer);
    }
    this.room.broadcast("kill", { k: ki?.name ?? "", ks: credit, v: q.name, vs: qsid, w: cause, ...(carKind >= 0 ? { c: carKind } : {}) });
  }

  damageCar(car: Car, dmg: number, attacker: string) {
    if (car.state !== 0) return;
    car.hp = Math.max(0, car.hp - Math.round(dmg));
    const body = this.room.bodies.get(car.id)!;
    if (attacker) body.lastHitBy = attacker;
    if (car.hp <= 0) {
      car.state = 1;
      body.burnUntil = this.room.now + CAR_FUSE_MS;
    }
  }

  knock(q: Player, vx: number, vy: number, vz: number, timer: number) {
    // (nothing to knock: a body, a gull, or someone in a trash can or down the sewer that the
    // shooter saw still out, a moment ago: they take the hurt, not the shove)
    if (q.mode === Mode.Dead || q.mode === Mode.Gull || q.mode === Mode.Hidden || q.mode === Mode.Sewer) return;
    if (q.mode === Mode.Driving) this.room.releaseCar(q);
    // riders: their world x/z are kept fresh by the shared step, so they fly from where they stood
    q.mode = Mode.Knocked;
    q.veh = -1;
    q.timer = timer;
    q.vx = vx; q.vy = vy; q.vz = vz;
    // (a hair up off whatever they stand on: a roof, the floor of a pit)
    q.y += 0.05;
    q.grounded = false;
  }

  private reward(sid: string, pts: number, x: number, z: number) {
    const info = this.room.info(sid);
    if (!info) return;
    info.score += pts;
    this.room.clients.getById(sid)?.send("ko", { x: +x.toFixed(1), z: +z.toFixed(1), pts });
  }

  /** A new round: forget the crash bookkeeping. */
  reset() {
    this.bumpUntil.clear();
  }

  // ------------------------------------------------------------------ explosions
  /** `car`: a car going up (a fireball) rather than a stink bomb (a green cloud). */
  explode(x: number, y: number, z: number, radius: number, damage: number, owner: string, car = false) {
    this.room.interest.broadcastNear("boom", { x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), r: radius, ...(car ? { c: 1 } : {}) }, x, z, NEAR_BOOMS);
    this.room.peds.scare(x, z, 30);
    for (const [qsid, q] of this.room.state.players) {
      // (whoever hides in a trash can is behind its walls: the can takes the blast, below; down
      // the sewer, the street over them does, but a stink bomb by a manhole gasses them out)
      if (q.mode === Mode.Dead || q.mode === Mode.Hidden || q.mode === Mode.Sewer) continue;
      const dx = q.x - x, dy = q.y + 0.6 - y, dz = q.z - z;
      const d = Math.hypot(dx, dy, dz);
      if (d > radius) continue;
      const f = 1 - d / radius;
      const hl = Math.hypot(dx, dz) || 1;
      if (q.mode === Mode.Gull) { this.room.gulls.shoo(qsid, q, owner, dx, dz); continue; }
      if (q.mode === Mode.Driving) {
        const car = this.room.carsById.get(q.veh);
        if (car) this.damageCar(car, 130 * f, owner);
        q.vy = 4 + 6 * f; q.vx += (dx / hl) * 9 * f; q.vz += (dz / hl) * 9 * f; q.yawRate += 5 * f;
        q.y = Math.max(q.y, 0.05);
        this.damagePlayer(q, qsid, damage * f * 0.4, owner, car ? "Car bomb" : WEAPONS[Weapon.Grenade].name);
      } else {
        this.knock(q, (dx / hl) * 13 * f, 7 + 6 * f, (dz / hl) * 13 * f, ticks(1.3));
        this.damagePlayer(q, qsid, Math.max(8, damage * f), owner, car ? "Car bomb" : WEAPONS[Weapon.Grenade].name);
      }
    }
    for (const npc of this.room.state.npcs.values()) {
      if (npc.state === NpcState.Hidden) continue;
      const dx = npc.x - x, dz = npc.z - z;
      const d = Math.hypot(dx, npc.y + 0.6 - y, dz);
      if (d > radius) continue;
      const f = 1 - d / radius;
      const hl = Math.hypot(dx, dz) || 1;
      this.room.peds.launch(npc, (dx / hl) * 12 * f, 7 + 7 * f, (dz / hl) * 12 * f);
      if (owner) this.reward(owner, 10, npc.x, npc.z);
    }
    for (const car of this.room.carsById.values()) {
      if (car.driver && car.driver !== "npc") continue; // handled through the driver above
      const dx = car.x - x, dz = car.z - z;
      const d = Math.hypot(dx, car.y + 0.6 - y, dz);
      if (d > radius + 1.5) continue;
      const f = Math.max(0, 1 - d / (radius + 1.5));
      this.damageCar(car, 130 * f, owner);
      const body = this.room.bodies.get(car.id)!;
      const hl = Math.hypot(dx, dz) || 1;
      body.vy = Math.max(body.vy, 3 + 7 * f);
      car.vx += (dx / hl) * 8 * f; car.vz += (dz / hl) * 8 * f;
      body.yawRate += (this.room.rand() - 0.5) * 8 * f;
      car.y = Math.max(car.y, 0.05);
    }
    // trash cans in the blast lose their lids, and pop out whoever hides in them
    CITY.bins.forEach((b, i) => {
      const dx = b.x - x, dz = b.z - z;
      if (Math.hypot(dx, b.y + 0.5 - y, dz) <= radius + BIN_R) this.room.bins.hit(i, owner, dx, dz);
    });
    // a manhole in it: whoever is under it is gassed out (low blasts only: not a car up on a roof)
    if (y < 3) this.room.sewers.blast(x, z, owner);
  }

  explodeCar(car: Car) {
    const body = this.room.bodies.get(car.id)!;
    car.state = 2;
    car.siren = false;
    body.wreckUntil = this.room.now + 12000;
    body.ai = null;
    const driverSid = car.driver;
    car.driver = "";
    // the wreck hops into the air
    body.vy = 9;
    body.yawRate = (this.room.rand() - 0.5) * 6;
    car.y = Math.max(car.y, 0.05);
    if (driverSid && driverSid !== "npc") {
      const p = this.room.state.players.get(driverSid);
      if (p && p.mode === Mode.Driving && p.veh === car.id) {
        this.knock(p, Math.cos(car.yaw) * 6, 9, -Math.sin(car.yaw) * 6, ticks(1.5));
        this.damagePlayer(p, driverSid, 70, body.lastHitBy || null, "Car bomb");
      }
    }
    const owner = body.lastHitBy;
    if (owner && owner !== driverSid) this.reward(owner, 25, car.x, car.z);
    this.explode(car.x, 0.8, car.z, 7, 80, owner, true);
  }

  /**
   * A driver's car ran a townsperson over in the shared step: against where that driver saw
   * them (the rewind), so it's the very hit their client predicted. They fly from there, the
   * flight already as old as the input says (`time` is its stamp, `h.at` when in that step
   * the car got to them): the driver's client has been drawing it since then.
   */
  runOver(sid: string, car: number, h: RunOver, time: number) {
    const npc = this.room.state.npcs.get(h.key);
    if (!npc || (npc.state > NpcState.Flee && npc.state !== NpcState.KO)) return;
    const at = time + (h.at * 1000) / TICK_RATE;
    this.room.peds.launchFrom(npc, h, this.room.now - at);
    this.reward(sid, 10, h.x, h.z);
    // (the driver's client settles its prediction with this)
    this.splatNpc(h.key, car, at, h.x, Math.max(h.y, 0.05), h.z, h.vx, h.vy, h.vz);
  }

  /**
   * Townsperson `key` hit by car `car` at room ms `t`: their launch, so everyone else can play
   * it from the start as that car, drawn a moment in the past on their screens, gets to them.
   */
  private splatNpc(key: string, car: number, t: number, x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const l = [x, y, z, vx, vy, vz].map((v) => +v.toFixed(2));
    this.room.interest.broadcastNear("splat", { x: +x.toFixed(1), y: 0.6, z: +z.toFixed(1), n: key, c: car, t: Math.round(t), l }, x, z, NEAR_EVENTS);
  }

  // ------------------------------------------------------------------ collisions
  stepCollisions(_dt: number) {
    const now = this.room.now;
    // every position read once: the loops below touch an entity only once it's a real candidate
    const cars = this.cars.reset(), feet = this.feet.reset(), peds = this.peds.reset();
    for (const car of this.room.carsById.values()) cars.add("", car, car.x, car.z);
    for (const [sid, q] of this.room.state.players) feet.add(sid, q, q.x, q.z);
    for (const [key, npc] of this.room.state.npcs) peds.add(key, npc, npc.x, npc.z);

    for (let c = 0; c < cars.n; c++) {
      const car = cars.items[c];
      const speed = Math.hypot(car.vx, car.vz);
      if (speed < RUN_OVER_SPEED || car.y > 1.2) continue;
      const type = CAR_TYPES[car.kind];
      const driverIsPlayer = car.driver !== "" && car.driver !== "npc";
      // (a circle further from the car's centre than its corner, plus its radius, can't touch it)
      const cx = cars.x[c], cz = cars.z[c], corner = Math.hypot(type.halfW, type.halfL);

      // run over players on foot
      const reachQ = (corner + PLAYER_RADIUS + 0.05) ** 2;
      for (let i = 0; i < feet.n; i++) {
        if ((feet.x[i] - cx) ** 2 + (feet.z[i] - cz) ** 2 >= reachQ) continue;
        const qsid = feet.keys[i], q = feet.items[i];
        if (qsid === car.driver) continue;
        if (q.mode !== Mode.Foot && !(q.mode === Mode.Knocked && q.timer < ticks(1.0))) continue;
        if (q.y > type.roof - 0.3) continue;
        if (!circleObb(q.x, q.z, PLAYER_RADIUS + 0.05, car.x, car.z, car.yaw, type.halfW, type.halfL, _n)) continue;
        // only if the car is moving into them (_n: from the car toward them)
        if (car.vx * _n.x + car.vz * _n.z < RUN_OVER_CLOSING) continue;
        this.knock(q, car.vx * 1.05 + _n.x * 4, 6 + speed * 0.25, car.vz * 1.05 + _n.z * 4, ticks(1.5));
        this.damagePlayer(q, qsid, speed * 3.2, driverIsPlayer ? car.driver : null, "Bumper", car.kind);
        // `s`: who got flattened (they go pancake on screen)
        this.room.interest.broadcastNear("splat", { x: +q.x.toFixed(1), y: 0.6, z: +q.z.toFixed(1), s: qsid }, q.x, q.z, NEAR_EVENTS);
      }
      // trash cans a runaway car ploughs into (a driven one bumps them in its driver's step: GameRoom)
      if (driverIsPlayer) continue;
      this.room.bins.ram(car.x, car.z, car.yaw, type.halfW, type.halfL, "");
      // run over pedestrians (a player's car does it in its driver's step: `runOver`)
      const reachN = (corner + NPC_HIT_R) ** 2;
      for (let i = 0; i < peds.n; i++) {
        if ((peds.x[i] - cx) ** 2 + (peds.z[i] - cz) ** 2 >= reachN) continue;
        const key = peds.keys[i], npc = peds.items[i];
        if (npc.state > NpcState.Flee && npc.state !== NpcState.KO) continue;
        if (!circleObb(npc.x, npc.z, NPC_HIT_R, car.x, car.z, car.yaw, type.halfW, type.halfL, _n)) continue;
        if (car.vx * _n.x + car.vz * _n.z < RUN_OVER_CLOSING) continue;
        this.room.peds.launch(npc, car.vx * 1.1 + _n.x * 4, 6 + speed * 0.3, car.vz * 1.1 + _n.z * 4);
        this.splatNpc(key, car.id, now, npc.x, npc.y, npc.z, npc.vx, npc.vy, npc.vz);
      }
    }

    // car vs car: player-driven cars already collided against what their driver saw
    // inside the shared step, so here they never move: only the other car is shoved.
    const halfL = this.halfL, ys = this.ys;
    for (let i = 0; i < cars.n; i++) {
      const car = cars.items[i];
      halfL[i] = CAR_TYPES[car.kind].halfL;
      ys[i] = car.y;
    }
    for (let i = 0; i < cars.n; i++) {
      for (let j = i + 1; j < cars.n; j++) {
        const dx = cars.x[j] - cars.x[i], dz = cars.z[j] - cars.z[i];
        const reach = halfL[i] + halfL[j];
        if (dx * dx + dz * dz > reach * reach || Math.abs(ys[i] - ys[j]) > 1.2) continue;
        const a = cars.items[i], b = cars.items[j];
        this.resolvePair(a, b);
        // (shoved apart: later pairs see where they are now)
        cars.x[i] = a.x; cars.z[i] = a.z;
        cars.x[j] = b.x; cars.z[j] = b.z;
      }
    }

    // trains vs everything the server owns (players are handled in the shared step)
    for (let slot = 0; slot < TRAIN_SLOTS; slot++) {
      const t = trainCarPose(slot, now, _train);
      for (let i = 0; i < cars.n; i++) {
        if ((cars.x[i] - t.x) ** 2 + (cars.z[i] - t.z) ** 2 > 100) continue;
        const car = cars.items[i];
        if (car.driver && car.driver !== "npc") continue;
        if (car.y > t.roof) continue;
        const type = CAR_TYPES[car.kind];
        if (!circleObb(car.x, car.z, type.halfW + 0.4, t.x, t.z, t.yaw, t.halfW, t.halfL, _n)) continue;
        const body = this.room.bodies.get(car.id)!;
        if (body.vy > 0) continue; // already flying from this hit
        car.vx = t.vx * 1.4 + _n.x * 10;
        car.vz = t.vz * 1.4 + _n.z * 10;
        body.vy = 9;
        body.yawRate = this.room.rand() < 0.5 ? 7 : -7;
        car.y = Math.max(car.y, 0.3);
        if (body.ai) { body.ai = null; car.driver = ""; body.idleSince = now; }
        // anyone surfing on its roof goes flying too
        for (const [, q] of this.room.state.players) {
          if (q.mode === Mode.Roof && q.veh === car.id) this.knock(q, car.vx * 0.8, 11, car.vz * 0.8, ticks(1.6));
        }
        this.damageCar(car, 70, "");
        this.room.interest.broadcastNear("crash", { x: +car.x.toFixed(1), z: +car.z.toFixed(1), big: 1 }, car.x, car.z, NEAR_EVENTS);
      }
      for (let i = 0; i < peds.n; i++) {
        if ((peds.x[i] - t.x) ** 2 + (peds.z[i] - t.z) ** 2 > 60) continue;
        const npc = peds.items[i];
        if (npc.state > NpcState.Flee && npc.state !== NpcState.KO) continue;
        if (!circleObb(npc.x, npc.z, 0.4, t.x, t.z, t.yaw, t.halfW, t.halfL, _n)) continue;
        this.room.peds.launch(npc, t.vx * 1.2 + _n.x * 7, 10, t.vz * 1.2 + _n.z * 7);
      }
    }
  }

  private resolvePair(a: Car, b: Car) {
    const ta = CAR_TYPES[a.kind], tb = CAR_TYPES[b.kind];
    let best = 0, nx = 0, nz = 0;
    // a's two circles against b's box, and b's against a's
    for (const [c, tc, o, to, sgnN] of [[a, ta, b, tb, -1], [b, tb, a, ta, 1]] as const) {
      const off = tc.halfL - tc.halfW;
      for (const s of [1, -1]) {
        const cx = c.x + Math.sin(c.yaw) * off * s, cz = c.z + Math.cos(c.yaw) * off * s;
        if (!circleObb(cx, cz, tc.halfW, o.x, o.z, o.yaw, to.halfW, to.halfL, _n)) continue;
        // _n points from the box toward the circle: flip it so n always points a → b
        if (_n.depth > best) { best = _n.depth; nx = _n.x * sgnN; nz = _n.z * sgnN; }
      }
    }
    if (best <= 0) return;
    // n points from a toward b. A player-driven car is moved only by its driver's own
    // predicted step (which already bumped into the other car as the driver saw it), so
    // the server shoving it here would be a correction nobody predicted. Wrecks don't
    // budge either.
    const pa = this.playerDriving(a), pb = this.playerDriving(b);
    // (nor does the garbage truck on its rounds: it's the biggest thing on the road)
    const wa = a.state === 2 || pa || this.onItsRounds(a) ? 0 : 1;
    const wb = b.state === 2 || pb || this.onItsRounds(b) ? 0 : 1;
    const wsum = wa + wb;
    const rv = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
    if (wsum > 0) {
      const pushA = (best * wa) / wsum, pushB = (best * wb) / wsum;
      this.moveCar(a, -nx * pushA, -nz * pushA);
      this.moveCar(b, nx * pushB, nz * pushB);
      if (rv >= 0) return;
      const j = (-(1.3) * rv) / wsum;
      this.kickCar(a, -nx * j * wa, -nz * j * wa);
      this.kickCar(b, nx * j * wb, nz * j * wb);
    } else if (rv >= 0) return;
    // two immovable bodies keep touching for a few ticks: count one crash per bump
    const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
    if (wsum === 0) {
      if ((this.bumpUntil.get(key) ?? 0) > this.room.now) return;
      this.bumpUntil.set(key, this.room.now + 600);
    }
    if (rv < -6) {
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      this.room.interest.broadcastNear("crash", { x: +mx.toFixed(1), z: +mz.toFixed(1), big: 0 }, mx, mz, NEAR_EVENTS);
      this.damageCar(a, -rv * 1.5, b.driver !== "npc" ? b.driver : "");
      this.damageCar(b, -rv * 1.5, a.driver !== "npc" ? a.driver : "");
    }
  }

  private onItsRounds(car: Car): boolean {
    return car.driver === "npc" && !!this.room.bodies.get(car.id)?.truck;
  }

  private playerDriving(car: Car): Player | null {
    if (!car.driver || car.driver === "npc") return null;
    const p = this.room.state.players.get(car.driver);
    return p && p.mode === Mode.Driving && p.veh === car.id ? p : null;
  }

  private moveCar(car: Car, dx: number, dz: number) {
    car.x += dx; car.z += dz;
  }

  private kickCar(car: Car, dvx: number, dvz: number) {
    car.vx += dvx; car.vz += dvz;
    const body = this.room.bodies.get(car.id)!;
    if (body.ai) body.ai.speed = Math.max(0, body.ai.speed * 0.5);
  }
}
