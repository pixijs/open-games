import { parseArgs } from "node:util";
import { Client, type Room } from "@colyseus/sdk";
import {
  GRENADE_CHARGE_STEPS, GRENADE_MAX_DIST, GRENADE_MIN_DIST, Mode, PICKUP_FOOD, PICKUP_ZOOMIES, PlayerStatus, RoundPhase,
  TICK_RATE, Weapon, WEAPONS,
} from "../src/shared/constants.ts";
import { AIM_Q, shotHeight } from "../src/shared/hitscan.ts";
import { CITY, segmentClear } from "../src/shared/map.ts";
import { NAMES } from "../src/shared/outfit.ts";
import { PlayerInput } from "../src/shared/schema.ts";
import { newZoneState, zoneAt } from "../src/shared/zone.ts";

/**
 * Battle-royale bots: real clients (the same SDK, inputs and server path as a browser) that
 * play a round, so a match runs from countdown to winner with one human in it, or none.
 * Each one heads for the next safe circle along the sidewalks, grabs loot, snacks and coffee
 * on the way, fights whoever it can see (with a reaction time and a shaky aim, so you can
 * win) and lobs the odd stink bomb. Knocked out, it comes back as a seagull that follows the
 * nearest raccoon still in the round and poops on it. One of them prints the round as it goes.
 *
 *   npm run bots                                  5 bots on ws://localhost:2567 (or :5173, `npm start`'s)
 *   npm run bots -- --bots 8 --skill 0.8          more of them, and sharper
 *   npm run bots -- --endpoint ws://localhost:2600
 *
 * Ctrl+C takes them all out of the room at once (no 20 s wait for a reconnection).
 */
const { values: args } = parseArgs({
  options: {
    bots: { type: "string", short: "n", default: "5" },
    /** Default: whichever of ws://localhost:2567 and ws://localhost:5173 answers first. */
    endpoint: { type: "string", short: "e" },
    room: { type: "string", default: "town" },
    /** 0 (slow to react, sprays) … 1 (snappy, accurate). */
    skill: { type: "string", short: "s", default: "0.5" },
    /** Don't print the round as it goes. */
    quiet: { type: "boolean", short: "q", default: false },
    /** Also print what every bot is up to, every 10 s. */
    verbose: { type: "boolean", short: "v", default: false },
  },
});
const COUNT = Math.max(1, Math.min(15, Number(args.bots) || 5));
const SKILL = Math.max(0, Math.min(1, Number(args.skill) || 0));

const STEP_MS = 1000 / TICK_RATE;
/** How far a bot notices other raccoons (m): inside the server's AOI_IN, so they're in its view. */
const SIGHT = 60;
/** Where each weapon likes to fight from (m). */
const PREFER = [0, 20, 14, 6, 0];

type XZ = { x: number; z: number };
type Goal = { kind: keyof typeof PRIORITY; x: number; z: number; key?: string };
/** A goal only gives way to a more urgent one (or when it's reached, gone or stale). */
const PRIORITY = { roam: 0, coffee: 1, loot: 2, chase: 3, heal: 4, zone: 5 };

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const dist = (a: XZ, b: XZ) => Math.hypot(a.x - b.x, a.z - b.z);
const clock = () => new Date().toLocaleTimeString();

// ---------------------------------------------------------------- getting around
const NAV = CITY.nav;

/** Can a raccoon walk straight from a to b: nothing at knee (over a kerb's step) or chest height in between? */
function walkable(ax: number, az: number, bx: number, bz: number, y = 0) {
  return segmentClear(ax, y + 0.55, az, bx, y + 0.55, bz) && segmentClear(ax, y + 1.1, az, bx, y + 1.1, bz);
}

/** The sidewalk node nearest (x, z) that's a straight walk away (-1: none of the nearest few). */
function entryNode(x: number, z: number, y = 0): number {
  const order = NAV.map((n, i) => [(n.x - x) ** 2 + (n.z - z) ** 2, i]).sort((a, b) => a[0] - b[0]);
  for (let k = 0; k < Math.min(8, order.length); k++) {
    const n = NAV[order[k][1]];
    if (walkable(x, z, n.x, n.z, y)) return order[k][1];
  }
  return -1;
}

function nearestNode(p: XZ): number {
  let k = 0;
  NAV.forEach((n, i) => { if (dist(p, n) < dist(p, NAV[k])) k = i; });
  return k;
}

/** Shortest way along the sidewalks (Dijkstra: there are only a few hundred nodes). */
function route(from: number, to: number): number[] {
  const n = NAV.length;
  const best = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
  best[from] = 0;
  for (;;) {
    let u = -1, bu = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && best[i] < bu) { bu = best[i]; u = i; }
    if (u < 0 || u === to) break;
    done[u] = 1;
    for (const v of NAV[u].links) {
      const d = bu + Math.hypot(NAV[u].x - NAV[v].x, NAV[u].z - NAV[v].z);
      if (d < best[v]) { best[v] = d; prev[v] = u; }
    }
  }
  const path: number[] = [];
  for (let u = to; u >= 0; u = prev[u]) path.unshift(u);
  return path[0] === from ? path : [to];
}

/** The node each loot can is walked to from (-1: on a roof, or nowhere a straight walk reaches). */
const PICKUP_NODE = CITY.pickups.map((p) => ((p.y ?? 0) > 0.6 ? -1 : entryNode(p.x, p.z)));

// ---------------------------------------------------------------- arms
function pickWeapon(p: any, d: number): number {
  if (d < 11 && p.ammo3 > 0) return Weapon.Shotgun;
  if (d < 30 && p.ammo2 > 0) return Weapon.Smg;
  if (p.ammo1 > 0) return Weapon.Pistol;
  if (p.ammo2 > 0) return Weapon.Smg;
  if (p.ammo3 > 0) return Weapon.Shotgun;
  return Weapon.Fists;
}

/** Nothing better than the Pop-Gun, or nearly out of everything. */
const underArmed = (p: any) => p.ammo2 + p.ammo3 === 0 || (p.ammo1 + p.ammo2 < 15 && p.ammo3 < 3);

// ---------------------------------------------------------------- one bot
class Bot {
  room!: Room;
  private input!: ReturnType<Room["input"]>;
  private readonly zs = newZoneState();
  private zoneOn = false;

  private goal: Goal | null = null;
  private goalAt = 0;
  private path: XZ[] = [];

  private target = "";
  private spottedAt = 0;
  private visible = false;
  private lastSeen: (XZ & { at: number }) | null = null;

  private strafe = 1;
  private strafeUntil = 0;
  private burstUntil = 0;
  private restUntil = 0;
  private err = 0;
  private errUntil = 0;
  /** A stink bomb on its way: steps to hold fire first (the cooldown runs out), then steps to wind it up. */
  private nadeWait = 0;
  private nadeHold = 0;
  private nadeAt = 0;

  private steps = 0;
  private stuck = 0;
  private movedFrom: XZ = { x: 0, z: 0 };
  private wantMove = false;
  private tauntAt = 0;

  constructor(readonly index: number, readonly name: string) {}

  get sid() { return this.room?.sessionId ?? ""; }

  /** One line on what it's up to (`--verbose`). */
  report(): string {
    const s = this.room?.state as any, me = s?.players?.get(this.sid), info = s?.roster?.get(this.sid);
    if (!me || !info) return `${this.name}: (no state)`;
    const at = `(${me.x.toFixed(0)}, ${me.z.toFixed(0)})`;
    if (me.mode === Mode.Gull) return `${this.name}: a gull ${me.y.toFixed(0)} m up at ${at}, out #${info.place}`;
    if (info.status !== PlayerStatus.Playing || me.mode === Mode.Dead) return `${this.name}: ${info.status === PlayerStatus.Out ? `out, #${info.place}` : "waiting"}`;
    const target = this.target ? `${this.visible ? "fighting" : "chasing"} ${s.roster.get(this.target)?.name ?? "?"}` : "";
    const goal = this.goal ? `${this.goal.kind} ${dist(me, this.goal).toFixed(0)} m off` : "idle";
    return `${this.name}: ${me.hp} hp at ${at} mode ${me.mode}, ${goal}${target ? `, ${target}` : ""}, ammo ${me.ammo1}/${me.ammo2}/${me.ammo3}/${me.ammo4}${this.stuck ? `, stuck ×${this.stuck}` : ""}`;
  }

  async join(client: Client) {
    this.room = await client.joinOrCreate(args.room!, { name: this.name });
    this.input = this.room.input({ type: PlayerInput });
    // the bots don't draw anything: every event the server sends goes unheard
    this.room.onMessage("*", () => {});
    this.goal = null;
    this.path = [];
    this.target = "";
    this.nadeAt = performance.now() + rnd(4000, 12000);
  }

  /** One fixed step: decide, fill in the input, send it (exactly one per step, like a real client). */
  tick(now: number) {
    if (!this.input) return;
    const d = this.input.data as any;
    d.mx = 0; d.mz = 0; d.fire = false; d.nade = false; d.jump = false; d.sprint = false; d.use = false; d.eye = false;
    this.wantMove = false;
    const s = this.room.state as any;
    const me = s?.players?.get(this.sid), info = s?.roster?.get(this.sid);
    this.steps++;
    if (me && info && s.round) this.play(now, s, me, info, d);
    this.input.send();
  }

  private play(now: number, s: any, me: any, info: any, d: any) {
    const phase = s.round.phase;
    // knocked out and a gull now: after the nearest raccoon still in, to poop on it
    if (me.mode === Mode.Gull) { if (phase === RoundPhase.Live) this.gull(now, s, me, d); return; }
    if (info.status !== PlayerStatus.Playing || me.mode === Mode.Dead) {
      this.goal = null; this.path = []; this.target = ""; this.nadeHold = this.nadeWait = 0;
      return;
    }
    // frozen until GO (and just put somewhere new): look around a bit
    if (phase === RoundPhase.Countdown) {
      this.goal = null; this.path = []; this.target = "";
      d.aim = wrap(this.steps / 40 + this.index);
      return;
    }
    if (phase === RoundPhase.Victory) {
      if (s.round.winner === this.sid && now > this.tauntAt) { this.room.send("taunt"); this.tauntAt = now + 1800; }
      return;
    }
    // stuck to a wall with the zoomies: kick off it
    if (me.mode === Mode.Wall) { d.jump = this.steps % 2 === 0; return; }
    // fallen down an open manhole: straight back out
    if (me.mode === Mode.Sewer) { d.jump = this.steps % 2 === 0; return; }
    if (me.mode === Mode.Knocked) return;

    // the slow part, a few times a second (the bots take turns)
    if ((this.steps + this.index) % 6 === 0) this.think(now, s, me);

    let move = this.follow(me);
    const q = this.target ? s.players.get(this.target) : undefined;
    if (q && q.mode !== Mode.Dead) {
      const fight = this.fight(now, me, q, d);
      // in the fumes the way out comes first (shooting all the way); out of sight, the way to
      // where it was (the "chase" goal); otherwise dance about
      if (this.visible && !(this.goal?.kind === "zone" && move)) move = fight;
    } else {
      this.nadeWait = this.nadeHold = 0;
      d.weapon = pickWeapon(me, 20);
      if (move) d.aim = Math.atan2(move.x, move.z);
      d.sprint = !!move;
    }
    move = this.dodge(s, me) ?? move;
    if (move) {
      d.mx = Math.round(move.x * 100);
      d.mz = Math.round(move.z * 100);
      this.wantMove = true;
    }
    this.unstick(me, d);
  }

  /**
   * A gull: up over the nearest raccoon still in the round (that it can see: its view is the
   * server's), some 7 m over its head, a dropping whenever it's right over it, and a squawk now
   * and then. Nobody about: it circles where it is.
   */
  private gull(now: number, s: any, me: any, d: any) {
    let best: any = null, bestD = SIGHT;
    for (const [sid, q] of s.players) {
      if (sid === this.sid || s.roster.get(sid)?.status !== PlayerStatus.Playing) continue;
      if (q.mode === Mode.Dead || q.mode === Mode.Hidden || q.mode === Mode.Sewer) continue;
      const dd = dist(me, q);
      if (dd < bestD) { bestD = dd; best = q; }
    }
    if (!best) {
      // circling
      const a = this.steps / 60 + this.index;
      d.mx = Math.round(Math.cos(a) * 60); d.mz = Math.round(Math.sin(a) * 60);
      d.jump = me.y < 10;
      return;
    }
    const dx = best.x - me.x, dz = best.z - me.z, l = Math.hypot(dx, dz);
    // (easing off as it gets there, so it hangs right over them)
    const k = Math.min(1, l / 6);
    if (l > 0.3) { d.mx = Math.round((dx / l) * 100 * k); d.mz = Math.round((dz / l) * 100 * k); }
    d.aim = Math.atan2(dx, dz);
    const want = best.y + 7;
    d.jump = me.y < want - 1;
    d.sprint = me.y > want + 2;
    d.fire = l < 1.6;
    if (now > this.tauntAt && Math.random() < 0.004) { this.room.send("taunt"); this.tauntAt = now + 4000; }
  }

  // ---------------------------------------------------------------- deciding
  private think(now: number, s: any, me: any) {
    const r = s.round;
    this.zoneOn = r.phase === RoundPhase.Live;
    if (this.zoneOn) zoneAt(r.zone, this.room.clock.serverNow(), r.stopAt, this.zs);
    this.look(now, s, me);
    // cut corners: on to the next waypoint but one as soon as it's a straight walk
    while (this.path.length > 1 && dist(me, this.path[1]) < 35 && walkable(me.x, me.z, this.path[1].x, this.path[1].z, me.y)) this.path.shift();
    this.plan(now, s, me);
  }

  /** Who to fight: the nearest raccoon in plain sight (sticking with the one it has, unless another is much nearer). */
  private look(now: number, s: any, me: any) {
    const eye = me.y + 1.0;
    let best = "", bestD = Infinity;
    for (const [sid, q] of s.players as Map<string, any>) {
      if (sid === this.sid || q.mode === Mode.Dead || q.mode === Mode.Hidden) continue;
      if (s.roster.get(sid)?.status !== PlayerStatus.Playing) continue;
      let dd = dist(me, q);
      if (dd > SIGHT) continue;
      if (!segmentClear(me.x, eye, me.z, q.x, q.y + 0.9, q.z) && !segmentClear(me.x, eye, me.z, q.x, q.y + 1.35, q.z)) continue;
      if (sid === this.target) dd *= 0.6;
      if (dd < bestD) { bestD = dd; best = sid; }
    }
    const was = this.target;
    if (best) {
      if (best !== was || !this.visible) {
        // a reaction time, longer for someone behind it
        const q = s.players.get(best);
        const behind = Math.abs(wrap(Math.atan2(q.x - me.x, q.z - me.z) - me.yaw)) > 1.8;
        this.spottedAt = now + lerp(750, 250, SKILL) * (behind ? 1.6 : 1);
      }
      this.target = best;
      this.visible = true;
      const q = s.players.get(best);
      this.lastSeen = { x: q.x, z: q.z, at: now };
    } else {
      this.visible = false;
      // out of sight: go and look where it was, for a few seconds
      const q = was ? s.players.get(was) : undefined;
      if (!q || q.mode === Mode.Dead || !this.lastSeen || now - this.lastSeen.at > 5000) this.target = "";
    }
  }

  private plan(now: number, s: any, me: any) {
    const g = this.goal;
    if (g) {
      const done = !this.path.length || dist(me, g) < 1.5;
      const gone = g.key !== undefined && !s.pickups.get(g.key)?.active;
      const stale = now - this.goalAt > (g.kind === "chase" ? 6000 : 25000);
      const zoneOk = g.kind !== "zone" || !this.zoneOn || this.inside(g, 2);
      if (done || gone || stale || !zoneOk) this.goal = null;
    }
    const next = this.want(now, s, me, this.goal ? PRIORITY[this.goal.kind] : -1);
    if (next) this.setGoal(next, me, now);
  }

  /** Inside the circle the fumes are closing to (by `margin` m)? */
  private inside(p: XZ, margin: number) {
    return !this.zoneOn || Math.hypot(p.x - this.zs.nx, p.z - this.zs.nz) < this.zs.nr - margin;
  }

  /** The most urgent thing to go and do, if it beats `over`. */
  private want(now: number, s: any, me: any, over: number): Goal | null {
    const zoneOn = this.zoneOn;
    if (over < PRIORITY.zone && zoneOn && !this.inside(me, Math.min(4, this.zs.nr * 0.3))) {
      // the nearest sidewalk corner well inside the next circle (or its middle, when it's off the sidewalks)
      let best: Goal = { kind: "zone", x: this.zs.nx, z: this.zs.nz }, bestD = Infinity;
      for (const n of NAV) {
        if (!this.inside(n, this.zs.nr * 0.35)) continue;
        const dd = dist(me, n) + rnd(0, 15);
        if (dd < bestD) { bestD = dd; best = { kind: "zone", x: n.x, z: n.z }; }
      }
      return best;
    }
    if (over < PRIORITY.heal && me.hp < 65) {
      const g = this.nearestPickup(s, me, 80, (k) => k === PICKUP_FOOD);
      if (g) return { ...g, kind: "heal" };
    }
    if (over < PRIORITY.chase && this.target && !this.visible && this.lastSeen && now - this.lastSeen.at < 5000) {
      return { kind: "chase", x: this.lastSeen.x, z: this.lastSeen.z };
    }
    if (over < PRIORITY.loot) {
      const weak = underArmed(me);
      const g = this.nearestPickup(s, me, weak ? 70 : 25, (k) =>
        (k >= Weapon.Pistol && k <= Weapon.Shotgun && (weak || k !== Weapon.Pistol)) || (k === Weapon.Grenade && me.ammo4 === 0));
      if (g) return { ...g, kind: "loot" };
    }
    if (over < PRIORITY.coffee && !me.zoomies) {
      const g = this.nearestPickup(s, me, 30, (k) => k === PICKUP_ZOOMIES);
      if (g && Math.random() < 0.3) return { ...g, kind: "coffee" };
    }
    if (over < PRIORITY.roam) {
      // somewhere else in the safe part of town: as the circle shrinks, everyone ends up close
      const near = NAV.filter((n) => this.inside(n, zoneOn ? this.zs.nr * 0.2 : 0) && dist(me, n) > 12 && dist(me, n) < 70);
      const pool = near.length ? near : NAV.filter((n) => this.inside(n, 0));
      const n = pool[Math.floor(Math.random() * pool.length)];
      if (n) return { kind: "roam", x: n.x, z: n.z };
    }
    return null;
  }

  private nearestPickup(s: any, me: any, within: number, ok: (kind: number) => boolean): Goal | null {
    let best: Goal | null = null, bestD = within;
    for (const [key, pk] of s.pickups as Map<string, any>) {
      if (!pk.active || !ok(pk.kind) || PICKUP_NODE[+key] < 0 || !this.inside(pk, 1)) continue;
      const dd = dist(me, pk);
      if (dd < bestD) { bestD = dd; best = { kind: "roam", x: pk.x, z: pk.z, key }; }
    }
    return best;
  }

  private setGoal(g: Goal, me: any, now: number) {
    this.goal = g;
    this.goalAt = now;
    if (walkable(me.x, me.z, g.x, g.z, me.y) && dist(me, g) < 40) { this.path = [{ x: g.x, z: g.z }]; return; }
    // (off the sidewalks with no straight walk to one: the nearest node anyway, and `unstick` copes)
    const from = entryNode(me.x, me.z, me.y), to = g.key !== undefined ? PICKUP_NODE[+g.key] : entryNode(g.x, g.z);
    const nodes = route(from >= 0 ? from : nearestNode(me), to >= 0 ? to : nearestNode(g));
    this.path = nodes.map((i) => ({ x: NAV[i].x, z: NAV[i].z }));
    this.path.push({ x: g.x, z: g.z });
  }

  // ---------------------------------------------------------------- moving
  /** Toward the next waypoint (unit vector), or null: nowhere to go. */
  private follow(me: any): XZ | null {
    while (this.path.length && dist(me, this.path[0]) < 1.3) this.path.shift();
    const w = this.path[0];
    if (!w) return null;
    const l = dist(me, w) || 1;
    return { x: (w.x - me.x) / l, z: (w.z - me.z) / l };
  }

  /** Stink bombs about to go off nearby: away from them (and the bot's own too). */
  private dodge(s: any, me: any): XZ | null {
    if (!s.grenades) return null;
    for (const g of (s.grenades as Map<string, any>).values()) {
      const dx = me.x - g.x, dz = me.z - g.z, l = Math.hypot(dx, dz);
      if (l > 8) continue;
      return l > 0.01 ? { x: dx / l, z: dz / l } : { x: 1, z: 0 };
    }
    return null;
  }

  /** Walking but getting nowhere: hop (a kerb, a bench, a car to climb), then step aside, then give up on the goal. */
  private unstick(me: any, d: any) {
    if (this.steps % TICK_RATE !== 0) return;
    const moved = dist(me, this.movedFrom);
    this.movedFrom = { x: me.x, z: me.z };
    if (!this.wantMove || moved > 1) { this.stuck = 0; return; }
    this.stuck++;
    d.jump = true;
    if (this.stuck === 2) {
      // a few metres to one side, if that's a straight walk
      const a = Math.random() * Math.PI * 2;
      const side = { x: me.x + Math.sin(a) * 4, z: me.z + Math.cos(a) * 4 };
      if (walkable(me.x, me.z, side.x, side.z, me.y)) this.path.unshift(side);
    } else if (this.stuck >= 4) {
      this.goal = null;
      this.path = [];
      this.stuck = 0;
    }
  }

  // ---------------------------------------------------------------- fighting
  /** Aim, shoot (or wind up a stink bomb) at `q`, and the way to move meanwhile. */
  private fight(now: number, me: any, q: any, d: any): XZ | null {
    const dx = q.x - me.x, dz = q.z - me.z, l = Math.hypot(dx, dz) || 1;
    const ux = dx / l, uz = dz / l;
    const weapon = pickWeapon(me, l);
    d.weapon = weapon;

    // a shaky aim: off by a bit that changes a few times a second, more on a fast target
    if (now > this.errUntil) {
      const speed = Math.hypot(q.vx, q.vz);
      this.err = gauss() * lerp(0.1, 0.03, SKILL) * (1 + speed / 10);
      this.errUntil = now + rnd(250, 500);
    }
    d.aim = wrap(Math.atan2(dx, dz) + this.err);
    const muzzle = shotHeight(me.x, me.y, me.z, me.mode === Mode.Driving, false);
    d.pitch = Math.round(Math.atan2(q.y + 0.9 - muzzle, l) * AIM_Q);

    const ready = this.visible && now >= this.spottedAt;
    if (this.nadeWait > 0 || this.nadeHold > 0) {
      // winding up: the cooldown first (a held G only starts once it's out), then a step per 1/30 of full power
      if (this.nadeWait > 0) this.nadeWait--;
      else { d.nade = true; this.nadeHold--; }
    } else if (ready && me.ammo4 > 0 && now > this.nadeAt && l > 7 && l < GRENADE_MAX_DIST - 3) {
      this.nadeWait = WEAPONS[me.weapon]?.cooldown ?? 0;
      this.nadeHold = Math.max(1, Math.min(GRENADE_CHARGE_STEPS,
        Math.round((GRENADE_CHARGE_STEPS * (l - GRENADE_MIN_DIST)) / (GRENADE_MAX_DIST - GRENADE_MIN_DIST))));
      this.nadeAt = now + rnd(9000, 18000) * lerp(1.5, 0.8, SKILL);
    } else if (ready) {
      // bursts with breathers between them
      if (now > this.burstUntil && now > this.restUntil) {
        this.restUntil = now + rnd(150, 700) * lerp(1.4, 0.6, SKILL);
        this.burstUntil = this.restUntil + rnd(600, 1600);
      }
      const reach = weapon === Weapon.Fists ? 1.8 : WEAPONS[weapon].range * 0.92;
      d.fire = now > this.restUntil && l < reach;
    }

    // nothing but paws: straight at them, close enough to slap
    if (weapon === Weapon.Fists) {
      return l > 1.2 && walkable(me.x, me.z, me.x + ux * 1.5, me.z + uz * 1.5, me.y) ? { x: ux, z: uz } : null;
    }
    // keep to this weapon's range, sidestepping
    const prefer = PREFER[weapon];
    const radial = l > prefer + 5 ? 1 : l < prefer - 4 ? -1 : 0;
    if (now > this.strafeUntil) {
      this.strafe = Math.random() < 0.2 ? 0 : Math.random() < 0.5 ? -1 : 1;
      this.strafeUntil = now + rnd(500, 1600);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      let mx = ux * radial + uz * this.strafe, mz = uz * radial - ux * this.strafe;
      const ml = Math.hypot(mx, mz);
      if (ml < 0.01) return null;
      mx /= ml; mz /= ml;
      if (walkable(me.x, me.z, me.x + mx * 1.5, me.z + mz * 1.5, me.y)) {
        d.sprint = radial > 0 && l > prefer + 12;
        return { x: mx, z: mz };
      }
      this.strafe = -this.strafe;
    }
    return radial ? { x: ux * radial, z: uz * radial } : null;
  }
}

// ---------------------------------------------------------------- the round, as it goes
function narrate(room: Room) {
  const s = () => room.state as any;
  const who = (sid: string) => s()?.roster?.get(sid)?.name ?? "someone";
  const say = (text: string) => { if (!args.quiet) console.log(`[${clock()}] ${text}`); };
  /** (a message comes straight away, the state it changed with the next patch) */
  const soon = (fn: () => void) => setTimeout(fn, 150);
  // counted here: the roster's `roundKills` lags the victory message by a patch
  const kills = new Map<string, number>();
  let goAt = 0;
  room.onMessage("round", (m: any) => {
    const r = () => s()?.round;
    if (m.e === "countdown") {
      kills.clear();
      soon(() => say(`round ${m.n}: countdown (${r()?.entrants ?? "?"} raccoons in)`));
    } else if (m.e === "go") {
      goAt = performance.now();
      soon(() => say(`round ${r()?.number}: GO! (fumes pace ×${r()?.pace?.toFixed(2)})`));
    } else if (m.e === "victory") {
      const k = kills.get(m.s) ?? 0, took = goAt ? ` after ${((performance.now() - goAt) / 1000).toFixed(0)} s` : "";
      say(m.s ? `round ${r()?.number}: WINNER WINNER, TRASH DINNER! ${m.n} (${k} kill${k === 1 ? "" : "s"})${took}` : `round ${r()?.number}: a draw, nobody left${took}`);
    } else if (m.e === "warmup") say("warmup: not enough raccoons for a round");
  });
  room.onMessage("kill", (m: any) => {
    if (m.ks) kills.set(m.ks, (kills.get(m.ks) ?? 0) + 1);
    say(m.k ? `  ${m.k} got ${m.v} (${m.w})` : `  ${m.v} went down (${m.w})`);
  });
  room.onMessage("out", (m: any) => say(`  ${who(m.s)} is out: #${m.p}, ${m.n} left`));
  // (what it hears from where it's looking: the gulls' bullseyes near it, Garbage Day all over)
  room.onMessage("pooped", (m: any) => { if (m.h) say(`  ${who(m.b)}, a gull, pooped on ${who(m.v)}`); });
  room.onMessage("feed", (m: any) => { if (/GARBAGE|golden dumpster/i.test(m.text)) say(`  ${m.text}`); });
  // and how it stands, every 20 s of a round
  const timer = setInterval(() => {
    const r = s()?.round;
    if (r?.phase !== RoundPhase.Live) return;
    const z = zoneAt(r.zone, room.clock.serverNow(), r.stopAt, newZoneState());
    say(`  ${r.alive}/${r.entrants} alive, fumes stage ${z.stage + 1} (r ${z.r.toFixed(0)} m${z.closing ? ", closing" : ""})`);
  }, 20000);
  room.onLeave(() => clearInterval(timer));
}

// ---------------------------------------------------------------- go
const servers = (args.endpoint ? [args.endpoint] : ["ws://localhost:2567", "ws://localhost:5173"]).map((url) => ({ url, client: new Client(url) }));
/** The one the first bot got into (the others follow it there). */
let server: (typeof servers)[number] | null = null;
const bots = Array.from({ length: COUNT }, (_, i) => new Bot(i, `Bot ${NAMES[i % NAMES.length]}${i >= NAMES.length ? i : ""}`.slice(0, 14)));
const narrated = new Set<string>();
let quitting = false;

async function connect(bot: Bot) {
  join: for (;;) {
    const why: string[] = [];
    for (const sv of server ? [server] : servers) {
      try {
        await bot.join(sv.client);
        server = sv;
        break join;
      } catch (e) {
        why.push(`${sv.url}: ${(e as Error).message || (e as any).code || e}`);
      }
    }
    console.error(`${bot.name} couldn't join (${why.join("; ")}); trying again in 3 s`);
    await new Promise((r) => setTimeout(r, 3000));
    if (quitting) return;
  }
  const room = bot.room;
  if (!narrated.has(room.roomId)) {
    narrated.add(room.roomId);
    console.log(`[${clock()}] bots are in room ${room.roomId} on ${server!.url} (skill ${SKILL})`);
    narrate(room);
  }
  room.onLeave((code: number) => {
    narrated.delete(room.roomId);
    if (quitting) return;
    console.log(`[${clock()}] ${bot.name} lost the room (${code}); rejoining`);
    setTimeout(() => connect(bot), 2000);
  });
}

for (const bot of bots) await connect(bot);

// a fixed 30 Hz step for all of them (timers are coarse on Windows: catch up on missed steps)
let last = performance.now(), acc = 0;
setInterval(() => {
  const now = performance.now();
  acc = Math.min(acc + now - last, STEP_MS * 5);
  last = now;
  while (acc >= STEP_MS) {
    acc -= STEP_MS;
    for (const bot of bots) bot.tick(now);
  }
}, 4);

if (args.verbose) setInterval(() => console.log(bots.map((b) => `    ${b.report()}`).join("\n")), 10000);

async function quit() {
  if (quitting) process.exit(0);
  quitting = true;
  console.log("\nbots leaving…");
  await Promise.allSettled(bots.map((b) => b.room?.leave(true)));
  process.exit(0);
}
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
