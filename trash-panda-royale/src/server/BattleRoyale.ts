import {
  KILL_CREDIT_MS, KILL_HEAL, Mode, PLAYER_MAX_HP, PlayerStatus, ROUND_COUNTDOWN_MS, ROUND_MIN_PLAYERS, ROUND_VICTORY_MS, RoundPhase,
} from "../shared/constants.js";
import { CITY, clearOfLoot } from "../shared/map.js";
import type { Pickup, Player } from "../shared/schema.js";
import { localToWorld } from "../shared/sim.js";
import { trainPointWorld } from "../shared/train.js";
import {
  newZoneState, nextCircle, ZONE_R0, ZONE_STAGES, zoneAt, zoneDamage, zoneDepth, zoneRandom, type ZoneState,
} from "../shared/zone.js";
import type { GameRoom } from "./GameRoom.js";

export interface RoundOptions {
  /** false: warmup forever (the old free-for-all; tests use it). */
  enabled: boolean;
  minPlayers: number;
  countdownMs: number;
  victoryMs: number;
  /** A fixed fume pace (tests); null picks one from the number of entrants. */
  pace: number | null;
}

export const DEFAULT_ROUND: RoundOptions = {
  enabled: true, minPlayers: ROUND_MIN_PLAYERS, countdownMs: ROUND_COUNTDOWN_MS, victoryMs: ROUND_VICTORY_MS, pace: null,
};

/**
 * Battle royale: warmup → countdown → live → victory → countdown… Runs on the server
 * at the end of every step (`postStep`), after all the damage of the step is in, so
 * players knocked out by the same explosion share their place, and nobody wins a round
 * that a draw just ended.
 */
export class BattleRoyale {
  /** The fumes this step (server side; clients evaluate the same `zoneAt`). */
  readonly zone: ZoneState = newZoneState();
  private damageLeft = new Map<string, number>();
  /** Knocked out this step, placed in `settle()`. */
  private out: string[] = [];
  private lastHit = new Map<string, { by: string; at: number }>();
  private rand: () => number = zoneRandom(1);
  private readonly tmp = { x: 0, z: 0 };

  constructor(private room: GameRoom, readonly opts: RoundOptions) {}

  /** Never cached: a dev-mode restore replaces the instance. */
  get r() { return this.room.state.round; }

  /** A round is being fought (the fumes are closing). */
  get live() { return this.r.phase === RoundPhase.Live; }
  /** Players can hurt each other (not while frozen before GO, nor during the victory lap). */
  get damageOn() { return this.r.phase === RoundPhase.Warmup || this.r.phase === RoundPhase.Live; }
  get respawnsOn() { return this.r.phase === RoundPhase.Warmup; }
  /** Inputs stamped before GO are frozen (`SimCtx.frozen`). */
  frozen(time: number) { return this.r.goAt > 0 && time < this.r.goAt; }

  isPlaying(sid: string) { return this.room.info(sid)?.status === PlayerStatus.Playing; }
  canHurt(sid: string) { return this.damageOn && this.isPlaying(sid); }

  // ------------------------------------------------------------------ kill credit
  noteHit(victim: string, by: string) { this.lastHit.set(victim, { by, at: this.room.now }); }

  /** Who gets the kill for a death nobody dealt directly (fumes, trains, falls). */
  lastHitter(victim: string): string {
    const h = this.lastHit.get(victim);
    return h && this.room.now - h.at <= KILL_CREDIT_MS && this.room.state.players.has(h.by) ? h.by : "";
  }

  /** A kill this round heals the killer a bit. */
  rewardKill(killer: Player) {
    if (this.r.phase === RoundPhase.Live && killer.mode !== Mode.Dead) killer.hp = Math.min(PLAYER_MAX_HP, killer.hp + KILL_HEAL);
  }

  // ------------------------------------------------------------------ positions
  /**
   * Where a player really is now. Riders' x/z are refreshed by their own steps, which
   * stop when they stop sending inputs (a dropped connection): place them from what
   * they ride instead.
   */
  livePos(p: Player, out: { x: number; z: number }) {
    if (p.mode === Mode.Train) return trainPointWorld(p.veh, this.room.now, p.lx, p.lz, out);
    if (p.mode === Mode.Roof) {
      const car = this.room.carsById.get(p.veh);
      if (car) return localToWorld(car, p.lx, p.lz, out);
    }
    out.x = p.x; out.z = p.z;
    return out;
  }

  /** Is (x, z) in the fumes right now? (During a round and its victory lap, when they're frozen.) */
  outside(x: number, z: number) {
    const ph = this.r.phase;
    return (ph === RoundPhase.Live || ph === RoundPhase.Victory) && zoneDepth(this.zone, x, z) > 0;
  }

  /** A can may refill: not in the fumes. */
  pickupAllowed(pk: Pickup) { return !this.outside(pk.x, pk.z); }

  // ------------------------------------------------------------------ tick
  preStep(now: number) {
    const ph = this.r.phase;
    if (ph === RoundPhase.Live) this.advanceZone(now);
    if (ph === RoundPhase.Live || ph === RoundPhase.Victory) zoneAt(this.r.zone, now, this.r.stopAt, this.zone);
  }

  postStep(dt: number) {
    const now = this.room.now;
    switch (this.r.phase) {
      case RoundPhase.Warmup:
        if (this.opts.enabled && this.connected() >= this.opts.minPlayers) this.startCountdown();
        break;
      case RoundPhase.Countdown:
        if (this.connected(true) < this.opts.minPlayers) this.toWarmup();
        else if (now >= this.r.goAt) this.goLive();
        break;
      case RoundPhase.Live:
        this.fumes(dt);
        this.cullPickups();
        this.settle();
        break;
      case RoundPhase.Victory:
        if (now < this.r.endsAt) break;
        if (this.opts.enabled && this.connected() >= this.opts.minPlayers) this.startCountdown();
        else this.toWarmup();
        break;
    }
  }

  /** Connected players (only those in the round, with `playing`). */
  private connected(playing = false) {
    let n = 0;
    for (const [sid, info] of this.room.state.roster) {
      if (!info.connected || !this.room.state.players.has(sid)) continue;
      if (playing && info.status !== PlayerStatus.Playing) continue;
      n++;
    }
    return n;
  }

  private alive() {
    let n = 0;
    for (const info of this.room.state.roster.values()) if (info.status === PlayerStatus.Playing) n++;
    return n;
  }

  // ------------------------------------------------------------------ phases
  startCountdown() {
    const r = this.r, now = this.room.now;
    r.phase = RoundPhase.Countdown;
    r.number++;
    r.goAt = r.endsAt = now + this.opts.countdownMs;
    r.stopAt = 0;
    r.winner = "";
    r.winnerName = "";
    this.resetZone();
    this.room.resetWorld();
    this.damageLeft.clear();
    this.lastHit.clear();
    this.out.length = 0;

    const sids = [...this.room.state.players.keys()].filter((sid) => this.room.info(sid)?.connected);
    const spots = this.spreadSpawns(sids.length);
    let n = 0;
    for (const [sid, p] of this.room.state.players) {
      const info = this.room.info(sid);
      if (!info) continue;
      info.place = 0;
      info.killedBy = "";
      info.roundKills = 0;
      if (info.connected) {
        info.status = PlayerStatus.Playing;
        this.room.spawnPlayer(p, spots[n++]);
      } else {
        info.status = PlayerStatus.Waiting;
        this.room.park(p);
      }
    }
    r.entrants = r.alive = n;
    this.room.broadcast("round", { e: "countdown", n: r.number });
  }

  private goLive() {
    const r = this.r;
    r.phase = RoundPhase.Live;
    r.pace = this.opts.pace ?? (r.entrants <= 2 ? 1.5 : r.entrants <= 4 ? 1.25 : 1);
    this.rand = zoneRandom(Math.floor(this.room.rand() * 0xffffffff) >>> 0);
    const z = r.zone;
    z.stage = 0;
    z.x0 = 0; z.z0 = 0; z.r0 = ZONE_R0;
    this.planNext(r.goAt);
    zoneAt(z, this.room.now, 0, this.zone);
    this.room.garbage.onGo(r.goAt, r.pace);
    this.room.broadcast("round", { e: "go" });
  }

  private victory() {
    const r = this.r, now = this.room.now;
    let winner = "";
    for (const [sid, info] of this.room.state.roster) if (info.status === PlayerStatus.Playing) { winner = sid; break; }
    r.phase = RoundPhase.Victory;
    r.endsAt = now + this.opts.victoryMs;
    r.stopAt = now;
    r.winner = winner;
    // a winner hiding in a trash can (or down the sewer) hops out for the victory lap
    const wp = winner ? this.room.state.players.get(winner) : undefined;
    if (wp) { this.room.bins.eject(winner, wp, 0, 0, false); this.room.sewers.eject(winner, wp, wp.yaw, false); }
    const wi = winner ? this.room.info(winner) : undefined;
    r.winnerName = wi?.name ?? "";
    if (wi) {
      wi.place = 1;
      wi.wins++;
      wi.score += 250;
    }
    this.room.broadcast("round", { e: "victory", s: winner, n: r.winnerName });
  }

  /** Back to the free-for-all (not enough players, or a dev-mode reload). */
  toWarmup() {
    const r = this.r;
    r.phase = RoundPhase.Warmup;
    r.goAt = r.endsAt = r.stopAt = 0;
    r.winner = "";
    r.winnerName = "";
    r.alive = r.entrants = 0;
    this.resetZone();
    this.damageLeft.clear();
    this.out.length = 0;
    // no more gulls, nothing on its way down, no Garbage Day
    this.room.gulls.reset();
    this.room.loot.reset();
    this.room.garbage.reset();
    for (const [sid, p] of this.room.state.players) {
      const info = this.room.info(sid);
      if (!info) continue;
      const sitting = info.status !== PlayerStatus.Playing || p.mode === Mode.Dead || p.mode === Mode.Gull;
      info.status = PlayerStatus.Playing;
      info.place = 0;
      if (sitting) this.room.spawnPlayer(p);
    }
    this.room.broadcast("round", { e: "warmup" });
  }

  // ------------------------------------------------------------------ people
  onJoin(sid: string, p: Player) {
    const info = this.room.info(sid)!;
    switch (this.r.phase) {
      case RoundPhase.Warmup:
        info.status = PlayerStatus.Playing;
        this.room.spawnPlayer(p);
        break;
      case RoundPhase.Countdown:
        // still time to get in: the step is frozen until GO anyway
        info.status = PlayerStatus.Playing;
        this.room.spawnPlayer(p, this.spreadSpawns(1, true)[0]);
        this.r.entrants++;
        this.r.alive++;
        break;
      default:
        info.status = PlayerStatus.Waiting;
        this.room.park(p);
        // (as a gull, in a moment)
        this.room.gulls.onWaiting(sid);
    }
  }

  onReconnect(sid: string, p: Player) {
    const info = this.room.info(sid);
    if (info && this.r.phase === RoundPhase.Countdown && info.status === PlayerStatus.Waiting) this.onJoin(sid, p);
  }

  /** Left for good (a dropped connection keeps its body in the round until its seat expires). */
  onLeave(sid: string) {
    const info = this.room.info(sid);
    if (info && info.status === PlayerStatus.Playing && this.r.phase === RoundPhase.Live) {
      info.status = PlayerStatus.Out;
      this.room.broadcast("feed", { text: `${info.name} fled the round`, i: "raccoon" });
    }
    this.damageLeft.delete(sid);
    this.lastHit.delete(sid);
  }

  /** Knocked out of the live round (`killPlayer` with respawns off). */
  onEliminated(sid: string, by: string) {
    const info = this.room.info(sid);
    if (!info || this.r.phase !== RoundPhase.Live) return;
    info.status = PlayerStatus.Out;
    info.killedBy = by;
    this.out.push(sid);
    this.room.gulls.onOut(sid);
  }

  // ------------------------------------------------------------------ live round
  /** Fume damage: deeper hurts more. Drivers and riders too (the player, not the car). */
  private fumes(dt: number) {
    for (const [sid, p] of this.room.state.players) {
      if (p.mode === Mode.Dead || !this.isPlaying(sid)) continue;
      const pos = this.livePos(p, this.tmp);
      const dps = zoneDamage(this.zone, zoneDepth(this.zone, pos.x, pos.z));
      if (dps <= 0) { this.damageLeft.delete(sid); continue; }
      const acc = (this.damageLeft.get(sid) ?? 0) + dps * dt;
      const whole = Math.floor(acc);
      this.damageLeft.set(sid, acc - whole);
      if (whole <= 0) continue;
      // fumigated: a trash can or the sewer doesn't keep the gas out, and nobody stays in one coughing
      if (p.mode === Mode.Hidden) {
        this.room.bins.eject(sid, p, this.zone.x - pos.x, this.zone.z - pos.z, false);
        this.room.broadcast("feed", { text: `${p.name} got smoked out of a trash can`, i: "fumes" });
      } else if (p.mode === Mode.Sewer) {
        this.room.sewers.eject(sid, p, Math.atan2(this.zone.x - pos.x, this.zone.z - pos.z), false);
        this.room.broadcast("feed", { text: `${p.name} got smoked out of the sewer`, i: "fumes" });
      }
      this.room.combat.damagePlayer(p, sid, whole, null, "zone");
    }
  }

  private cullPickups() {
    for (const pk of this.room.state.pickups.values()) if (pk.active && !this.pickupAllowed(pk)) pk.active = false;
  }

  /** Place the players knocked out this step (all of them share a place), and see if it's over. */
  private settle() {
    const alive = this.alive();
    if (this.out.length) {
      for (const sid of this.out) {
        const info = this.room.info(sid);
        if (!info) continue;
        info.place = alive + 1;
        this.room.broadcast("out", { s: sid, p: alive + 1, n: alive });
      }
      this.out.length = 0;
    }
    this.r.alive = alive;
    if (alive <= 1) this.victory();
  }

  // ------------------------------------------------------------------ the fumes
  private resetZone() {
    const z = this.r.zone;
    z.stage = 0;
    z.x0 = z.z0 = z.x1 = z.z1 = 0;
    z.r0 = z.r1 = ZONE_R0;
    z.shrinkAt = z.doneAt = 0;
    zoneAt(z, 0, 0, this.zone);
  }

  /** Pick the circle stage `z.stage` closes to, holding from `from`. */
  private planNext(from: number) {
    const z = this.r.zone, pace = this.r.pace || 1;
    const st = ZONE_STAGES[z.stage];
    nextCircle(this.rand, z.x0, z.z0, z.r0, st.r, this.tmp);
    z.x1 = this.tmp.x; z.z1 = this.tmp.z; z.r1 = st.r;
    z.shrinkAt = from + (st.hold * 1000) / pace;
    z.doneAt = z.shrinkAt + (st.close * 1000) / pace;
  }

  private advanceZone(now: number) {
    const z = this.r.zone;
    while (z.stage < ZONE_STAGES.length && now >= z.doneAt) {
      const done = z.doneAt;
      z.x0 = z.x1; z.z0 = z.z1; z.r0 = z.r1;
      z.stage++;
      if (z.stage < ZONE_STAGES.length) this.planNext(done);
      else z.shrinkAt = z.doneAt = done; // sudden death: the last circle has closed
    }
  }

  /** Dev hook: fast-forward the fumes by `ms`. */
  skipZone(ms: number) {
    const z = this.r.zone;
    z.shrinkAt -= ms;
    z.doneAt -= ms;
  }

  // ------------------------------------------------------------------ spawns
  /**
   * `n` spawn points spread out over the town: farthest-point picks over the sidewalk
   * corners (from the players already standing, with `fromPlayers`).
   */
  private spreadSpawns(n: number, fromPlayers = false): { x: number; z: number }[] {
    // (never on a loot can: see `clearOfLoot`)
    const nodes = CITY.nav.filter((v) => Math.abs(v.x) < 116 && Math.abs(v.z) < 116 && clearOfLoot(CITY, v.x, v.z));
    const chosen: { x: number; z: number }[] = [];
    const taken: { x: number; z: number }[] = [];
    if (fromPlayers) {
      for (const [sid, p] of this.room.state.players) if (this.isPlaying(sid) && p.mode !== Mode.Dead) taken.push({ x: p.x, z: p.z });
    }
    for (let k = 0; k < n; k++) {
      let best = nodes[Math.floor(this.room.rand() * nodes.length)], bestD = -1;
      if (taken.length) {
        for (const v of nodes) {
          let d = Infinity;
          for (const t of taken) d = Math.min(d, (v.x - t.x) ** 2 + (v.z - t.z) ** 2);
          // a little noise so the same corners don't always win
          d *= 0.85 + this.room.rand() * 0.3;
          if (d > bestD) { bestD = d; best = v; }
        }
      }
      const spot = { x: best.x, z: best.z };
      chosen.push(spot);
      taken.push(spot);
    }
    return chosen;
  }
}
