import {
  GULL_HATCH_MS, GULL_SHOO_S, Mode, NEAR_EVENTS, PARK_X, PARK_Z, PLAYER_RADIUS, PlayerStatus, POOP_IMMUNE_MS, POOP_R, RoundPhase, CAR_TYPES, ticks,
} from "../shared/constants.js";
import { RACCOON_TOP } from "../shared/hitscan.js";
import { circleObb, groundHeight } from "../shared/map.js";
import type { Player } from "../shared/schema.js";
import { DROP_SUBSTEP, stepDrop, type GrenadeLike } from "../shared/sim.js";
import type { GameRoom } from "./GameRoom.js";

/** V (fly / watch) is heeded at most this often (ms). */
const TOGGLE_MS = 1500;
/** A gull scores 10 for at most this many fresh splats a round. */
const POOP_SCORES = 8;
/** A raccoon hiding (in a trash can, down the sewer) is no one to hatch over: where it is is a secret. */
const hidden = (m: number) => m === Mode.Hidden || m === Mode.Sewer || m === Mode.Dead;

/** A dropping on its way down (server side: clients fall their own copy from the `poop` message). */
interface Drop extends GrenadeLike { owner: string; born: number }

const cm = (v: number) => Math.round(v * 100);

/**
 * Seagulls: what raccoons knocked out of a round (and those waiting for the next one) come back as.
 *
 * A gull hatches out of its tombstone a moment after the knockout (`GULL_HATCH_MS`) and flies about
 * the town on the shared step (`stepGull`, predicted like any raccoon). It can't hurt anyone and
 * counts for nothing in the round, but it can poop on the living (a splat over their screen for a
 * few seconds), snatch their loot out from under them and drop it somewhere else (`Loot`), and be
 * shooed by a shot, a slap or a blast. V switches between flying and watching someone (`toggle`).
 *
 * Droppings are cheap: one `poop` message with where it left and how fast, and everyone watching
 * falls the same deterministic `stepDrop` from there. Only a hit on a raccoon is the server's word.
 */
export class Gulls {
  /** When each raccoon out of the round hatches (room ms). */
  private hatchAt = new Map<string, number>();
  /** Those who'd rather watch (V): they stay spectators until they press it again. */
  private watchers = new Set<string>();
  private drops: Drop[] = [];
  /** A raccoon just pooped on can't be again until then (room ms). */
  private immuneUntil = new Map<string, number>();
  /** When each player last switched with V (room ms). */
  private toggledAt = new Map<string, number>();
  /** Where each gull was, and its dropping's cooldown, when it landed (V): it takes off from there again. */
  private landed = new Map<string, { x: number; y: number; z: number; cd: number }>();
  /** Fresh splats each gull has scored for this round. */
  private scored = new Map<string, number>();

  constructor(private room: GameRoom) {}

  /** Knocked out of the live round: a gull soon. */
  onOut(sid: string) {
    this.hatchAt.set(sid, this.room.now + GULL_HATCH_MS);
  }

  /** Joined mid-round: a gull right away (well, nearly). */
  onWaiting(sid: string) {
    this.hatchAt.set(sid, this.room.now + 1200);
  }

  /**
   * V: fly (`on`), or watch the round instead. Heeded once every TOGGLE_MS; a gull that lands and
   * takes off again does so from where it landed, its dropping not a moment readier (so V is no
   * teleport, and no reload). Returns whether anything changed.
   */
  toggle(sid: string, on: boolean): boolean {
    const p = this.room.state.players.get(sid);
    const now = this.room.now;
    if (!p || now < (this.toggledAt.get(sid) ?? -Infinity) + TOGGLE_MS) return false;
    if (on) {
      if (!this.watchers.delete(sid) && p.mode !== Mode.Dead) return false;
      // (a raccoon just knocked out still waits out the hatch)
      if (!this.hatchAt.has(sid)) this.hatchAt.set(sid, now);
    } else {
      if (this.watchers.has(sid)) return false;
      this.watchers.add(sid);
      if (p.mode === Mode.Gull) {
        this.landed.set(sid, { x: p.x, y: p.y, z: p.z, cd: p.cd });
        this.land(sid, p);
      }
    }
    this.toggledAt.set(sid, now);
    return true;
  }

  wantsToWatch(sid: string) { return this.watchers.has(sid); }

  /** Knocked out and about to hatch (not watching instead): its view stays where it fell till then. */
  hatching(sid: string) { return this.hatchAt.has(sid) && !this.watchers.has(sid); }

  /** A gull no more: it lets go of what it carries, and its body waits off the map like any spectator's. */
  land(sid: string, p: Player) {
    this.dropCarried(sid, p);
    this.room.park(p);
  }

  step(dt: number) {
    const r = this.room.state.round;
    if (r.phase === RoundPhase.Live) {
      for (const [sid, p] of this.room.state.players) {
        if (p.mode !== Mode.Dead || this.watchers.has(sid)) continue;
        const info = this.room.info(sid);
        if (!info?.connected || info.status === PlayerStatus.Playing) continue;
        const at = this.hatchAt.get(sid);
        if (at === undefined || this.room.now < at) continue;
        this.hatchAt.delete(sid);
        this.hatch(sid, p);
      }
    }
    this.stepDrops(dt);
  }

  /**
   * Out of its tombstone (where its raccoon fell); a gull that landed (V), from where it did; someone
   * who never got to play this round, up over whoever they watch (a little way off them, and never
   * over one hiding: that would give them away), else over the middle of the circle.
   */
  private hatch(sid: string, p: Player) {
    let x = p.x, z = p.z, y = 0, cd = 0;
    const parked = Math.abs(p.x - PARK_X) < 1 && Math.abs(p.z - PARK_Z) < 1;
    const back = this.landed.get(sid);
    this.landed.delete(sid);
    if (back) { x = back.x; z = back.z; y = back.y; cd = back.cd; }
    else if (parked) {
      const w = this.room.state.players.get(this.room.interest.watching(sid));
      if (w && w !== p && !hidden(w.mode)) {
        const a = this.room.rand() * Math.PI * 2;
        x = w.x + Math.cos(a) * 8; z = w.z + Math.sin(a) * 8;
      } else { x = this.room.br.zone.x; z = this.room.br.zone.z; }
    }
    const floor = groundHeight(x, z, 40);
    p.mode = Mode.Gull;
    p.veh = -1;
    p.x = x; p.z = z;
    p.y = back ? Math.max(y, floor + 1) : floor + (parked ? 12 : 1.4);
    p.vx = 0; p.vy = parked || back ? 0 : 4; p.vz = 0;
    p.grounded = false;
    p.cd = cd; p.timer = 0; p.charge = 0; p.zoomies = 0; p.coyote = 0; p.stench = 0;
    p.lx = 0; p.ly = 0; p.lz = 0; p.lyaw = 0;
    p.life = (p.life + 1) & 0xffff;
    this.room.interest.reveal(p);
    // (its own client hears of it wherever it was looking from: it was watching someone till now)
    const msg = { s: sid, x: +x.toFixed(1), y: +p.y.toFixed(1), z: +z.toFixed(1) };
    const own = this.room.clients.getById(sid);
    own?.send("gull", msg);
    this.room.interest.broadcastNear("gull", msg, x, z, NEAR_EVENTS, own);
  }

  /** `sid`'s gull let go of a dropping at `launch` (its step decided so, and its client already shows it falling). */
  poop(sid: string, launch: GrenadeLike) {
    this.drops.push({ ...launch, owner: sid, born: this.room.now });
    this.room.interest.broadcastNear("poop", [sid, cm(launch.x), cm(launch.y), cm(launch.z), cm(launch.vx), cm(launch.vy), cm(launch.vz)],
      launch.x, launch.z, NEAR_EVENTS, this.room.clients.getById(sid));
  }

  /**
   * Shooed by `by` (a shot, a slap, a blast) along (dx, dz): it lets go of what it carries and
   * tumbles a moment. Not its step's doing: its client corrects onto it.
   */
  shoo(sid: string, p: Player, by: string, dx: number, dz: number) {
    if (p.mode !== Mode.Gull || p.timer > 0) return;
    this.dropCarried(sid, p);
    const l = Math.hypot(dx, dz) || 1;
    p.timer = ticks(GULL_SHOO_S);
    p.vx = (dx / l) * 6; p.vz = (dz / l) * 6; p.vy = 3;
    this.room.interest.broadcastNear("shoo", { s: sid, b: by }, p.x, p.z, NEAR_EVENTS);
  }

  /** Whatever gull `sid` carries falls from where it is. */
  private dropCarried(sid: string, p: Player) {
    if (this.room.loot.carried(sid)) this.room.loot.drop(sid, { x: p.x, y: p.y - 0.35, z: p.z, vx: p.vx * 0.5, vy: Math.min(0, p.vy), vz: p.vz * 0.5 });
    if (p.mode === Mode.Gull) p.veh = -1;
  }

  /** Droppings fall (two sub-steps a step); one that meets a raccoon on its way splats on them. */
  private stepDrops(dt: number) {
    if (!this.drops.length) return;
    const now = this.room.now;
    const n = Math.max(1, Math.round(dt / DROP_SUBSTEP));
    const keep: Drop[] = [];
    for (const d of this.drops) {
      let done = now - d.born > 6000;
      for (let k = 0; k < n && !done; k++) {
        const landed = stepDrop(d, dt / n) === 1;
        const victim = this.victimAt(d);
        if (victim) { this.splat(victim, d); done = true; }
        else if (landed) done = true;
      }
      if (!done) keep.push(d);
    }
    this.drops = keep;
  }

  /** The raccoon a dropping at `d` is falling onto (on foot, riding, crawling, behind the wheel: the car), if any. */
  private victimAt(d: Drop): { sid: string; p: Player } | null {
    for (const [sid, p] of this.room.state.players) {
      if (sid === d.owner || this.room.info(sid)?.status !== PlayerStatus.Playing) continue;
      const m = p.mode;
      if (m === Mode.Dead || m === Mode.Hidden || m === Mode.Sewer || m === Mode.Gull) continue;
      if (m === Mode.Driving) {
        const car = this.room.carsById.get(p.veh);
        if (!car) continue;
        const t = CAR_TYPES[car.kind];
        if (d.y > car.y + t.roof + 0.1 || d.y < car.y + t.roof * 0.4) continue;
        if (circleObb(d.x, d.z, POOP_R, car.x, car.z, car.yaw, t.halfW, t.halfL)) return { sid, p };
        continue;
      }
      if (d.y < p.y || d.y > p.y + RACCOON_TOP + 0.15) continue;
      const r = PLAYER_RADIUS + POOP_R;
      if ((d.x - p.x) ** 2 + (d.z - p.z) ** 2 <= r * r) return { sid, p };
    }
    return null;
  }

  /**
   * Splat. `h`: it counts (their screen gets it), or they had one a moment ago (it just slides off).
   * A fresh one scores the gull 10, in a live round, POOP_SCORES times a round at most.
   */
  private splat(v: { sid: string; p: Player }, d: Drop) {
    const now = this.room.now;
    const fresh = now >= (this.immuneUntil.get(v.sid) ?? 0);
    if (fresh) {
      this.immuneUntil.set(v.sid, now + POOP_IMMUNE_MS);
      const info = this.room.info(d.owner), n = this.scored.get(d.owner) ?? 0;
      if (info && n < POOP_SCORES && this.room.state.round.phase === RoundPhase.Live) {
        info.score += 10;
        this.scored.set(d.owner, n + 1);
      }
    }
    this.room.interest.broadcastNear("pooped", { v: v.sid, b: d.owner, x: +d.x.toFixed(2), y: +d.y.toFixed(2), z: +d.z.toFixed(2), h: fresh ? 1 : 0 },
      d.x, d.z, NEAR_EVENTS);
    // (the victim and the gull are told wherever they're looking from)
    for (const sid of [v.sid, d.owner]) {
      const c = this.room.clients.getById(sid);
      const centre = this.room.interest.centreOf(sid);
      if (c && centre && (centre.x - d.x) ** 2 + (centre.z - d.z) ** 2 > NEAR_EVENTS * NEAR_EVENTS) {
        c.send("pooped", { v: v.sid, b: d.owner, x: +d.x.toFixed(2), y: +d.y.toFixed(2), z: +d.z.toFixed(2), h: fresh ? 1 : 0 });
      }
    }
  }

  forget(sid: string) {
    const p = this.room.state.players.get(sid);
    if (p) this.dropCarried(sid, p);
    this.hatchAt.delete(sid);
    this.watchers.delete(sid);
    this.immuneUntil.delete(sid);
    this.toggledAt.delete(sid);
    this.landed.delete(sid);
    this.scored.delete(sid);
  }

  /** A new round (or warmup): nobody's a gull, nothing's falling. Who'd rather watch stays so. */
  reset() {
    this.hatchAt.clear();
    this.drops.length = 0;
    this.immuneUntil.clear();
    this.landed.clear();
    this.scored.clear();
  }
}
