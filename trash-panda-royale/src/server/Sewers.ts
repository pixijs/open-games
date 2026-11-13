import {
  BIN_REVEAL_MS, MANHOLE_BLAST_R, MANHOLE_OPEN_MS, Mode, NEAR_EVENTS, SEWER_COUGH_MS, SEWER_COUGH_S, SEWER_POP_SPEED, SEWER_POP_UP, ticks,
} from "../shared/constants.js";
import type { Player } from "../shared/schema.js";
import { MANHOLES, sewerFlooded } from "../shared/sewer.js";
import { airLeft } from "../shared/sim.js";
import type { GameRoom } from "./GameRoom.js";

/** A lid's fall direction (world yaw) as one byte, 256ths of a turn (as `state.manholes` keeps it). */
export const lidByte = (yaw: number) => Math.round((yaw / (Math.PI * 2)) * 256) & 255;

/**
 * The sewer, on the server's side: the manholes' lids, and keeping who's down there a secret.
 *
 * Like a trash can, the sewer is somewhere the server keeps a secret: a raccoon down a manhole is
 * dropped from everyone else's `StateView` once those around have seen it dive (`secret`), and
 * isn't sent to anyone again (but whoever watches it) until it climbs back out. What gives it away
 * is noise: every manhole it passes under rattles for whoever is near (`rattle`).
 *
 * Climbing out knocks the lid off; for a while the hole is open (`state.manholes`), and anyone
 * walking onto it falls in. A stink bomb going off by a manhole gasses out whoever is under it.
 *
 * Nobody stays down for good: a breath runs out (the shared step brings them up; the last few
 * seconds, the manhole over them coughs), and for the showdown the sewer floods (`sewerFlooded`).
 */
export class Sewers {
  /** When each open lid goes back on (room ms). */
  private lidBack = new Map<number, number>();
  /** When each raccoon down there went down (room ms). */
  private downAt = new Map<string, number>();
  /** When each raccoon short of breath down there coughs next (room ms). */
  private coughAt = new Map<string, number>();
  private flooded = false;

  constructor(private room: GameRoom) {}

  isOpen(i: number): boolean {
    return this.room.state.manholes.has(String(i));
  }

  /**
   * Down there long enough that only they (and whoever watches them) get their updates: those
   * around saw the dive (BIN_REVEAL_MS), or it has set off along a pipe already (which pipe, and
   * which way, is the secret).
   */
  secret(sid: string, p: Player): boolean {
    return p.mode === Mode.Sewer && (p.vx !== 0 || this.room.now - (this.downAt.get(sid) ?? -Infinity) >= BIN_REVEAL_MS);
  }

  /** `sid`'s step went down manhole `i` (dove in, or fell into the open hole): its lid rattles shut over them. */
  onDive(sid: string, i: number) {
    this.downAt.set(sid, this.room.now);
    const m = MANHOLES[i];
    if (m) this.room.interest.broadcastNear("manhole", { m: i, s: sid, e: "in" }, m.x, m.z, NEAR_EVENTS, this.room.clients.getById(sid));
  }

  /** `sid`'s step climbed out of manhole `i`: the lid flies off (the way they hopped), and they're back in everyone's sight. */
  onClimb(sid: string, p: Player, i: number) {
    this.downAt.delete(sid);
    this.room.interest.reveal(p);
    this.open(i, Math.atan2(p.vx, p.vz) + Math.PI);
    const m = MANHOLES[i];
    if (m) this.room.interest.broadcastNear("manhole", { m: i, s: sid, e: "out" }, m.x, m.z, NEAR_EVENTS, this.room.clients.getById(sid));
  }

  /** The manholes `sid` just scurried under: they rattle and puff for whoever is near (not for them: their client did it). */
  rattle(sid: string, holes: number[]) {
    const own = this.room.clients.getById(sid);
    for (const i of holes) {
      const m = MANHOLES[i];
      if (m) this.room.interest.broadcastNear("manhole", { m: i, e: "rattle" }, m.x, m.z, NEAR_EVENTS, own);
    }
  }

  /** Lid `i` off, lying toward `yaw`, for MANHOLE_OPEN_MS (again, if it was off already). */
  open(i: number, yaw: number) {
    if (!MANHOLES[i]) return;
    this.room.state.manholes.set(String(i), lidByte(yaw));
    this.lidBack.set(i, this.room.now + MANHOLE_OPEN_MS);
  }

  /**
   * Whoever is under a manhole within MANHOLE_BLAST_R of a stink bomb going off at (x, z) is
   * gassed out: up out of it (the lid flies), dazed. `by` gets the credit for what follows.
   */
  blast(x: number, z: number, by: string) {
    for (const [sid, p] of this.room.state.players) {
      if (p.mode !== Mode.Sewer || p.vx !== 0) continue;
      const m = MANHOLES[p.lz];
      if (!m || (m.x - x) ** 2 + (m.z - z) ** 2 > MANHOLE_BLAST_R ** 2) continue;
      this.eject(sid, p, Math.atan2(m.x - x, m.z - z), true);
      if (by && by !== sid) this.room.br.noteHit(sid, by);
      const finder = by && by !== sid ? this.room.info(by) : undefined;
      if (finder) this.room.broadcast("feed", { text: `${finder.name} gassed ${p.name} out of the sewer!`, i: "fumes" });
    }
  }

  /**
   * Up out of the manhole they're under (or last passed), flung along `yaw`, and (`dazed`) knocked
   * flat a moment: gassed out, or the round's over. Not their step's doing: their client corrects.
   */
  eject(sid: string, p: Player, yaw: number, dazed: boolean) {
    if (p.mode !== Mode.Sewer) return;
    const i = p.lz, m = MANHOLES[i];
    p.mode = dazed ? Mode.Knocked : Mode.Foot;
    p.veh = -1;
    p.x = m?.x ?? p.x; p.z = m?.z ?? p.z; p.y = 0.05;
    p.vx = Math.sin(yaw) * SEWER_POP_SPEED * 1.4;
    p.vz = Math.cos(yaw) * SEWER_POP_SPEED * 1.4;
    p.vy = SEWER_POP_UP;
    p.lx = 0; p.lz = 0;
    p.grounded = false;
    p.coyote = 0;
    p.timer = dazed ? ticks(0.8) : 0;
    this.downAt.delete(sid);
    this.room.interest.reveal(p);
    if (m) {
      this.open(i, yaw + Math.PI);
      this.room.interest.broadcastNear("manhole", { m: i, s: sid, e: "out" }, m.x, m.z, NEAR_EVENTS);
    }
  }

  forget(sid: string) {
    this.downAt.delete(sid);
    this.coughAt.delete(sid);
  }

  /** Lids go back on once their time is up; the breathless cough; a flood washes everyone out. */
  step() {
    const now = this.room.now;
    const flooded = sewerFlooded(this.room.state.round);
    if (flooded && !this.flooded) this.room.broadcast("feed", { text: "The sewer is flooding!", i: "manhole" });
    this.flooded = flooded;
    for (const [sid, p] of this.room.state.players) {
      if (p.mode !== Mode.Sewer) continue;
      if (flooded) { this.eject(sid, p, p.yaw, false); continue; }
      if (airLeft(p) > SEWER_COUGH_S || now < (this.coughAt.get(sid) ?? 0)) continue;
      this.coughAt.set(sid, now + SEWER_COUGH_MS);
      // (from the manhole they're under, or last passed)
      const m = MANHOLES[p.lz];
      if (m) this.room.interest.broadcastNear("manhole", { m: p.lz, e: "cough" }, m.x, m.z, NEAR_EVENTS, this.room.clients.getById(sid));
    }
    for (const [key] of this.room.state.manholes) {
      const i = Number(key);
      // (a dev-mode restore brings lids back off, but not when they go back on)
      if (!this.lidBack.has(i)) this.lidBack.set(i, now + MANHOLE_OPEN_MS);
      if (now < this.lidBack.get(i)!) continue;
      this.lidBack.delete(i);
      this.room.state.manholes.delete(key);
    }
  }

  /** A new round: every lid back on. */
  reset() {
    this.room.state.manholes.clear();
    this.lidBack.clear();
    this.downAt.clear();
    this.coughAt.clear();
    this.flooded = false;
  }
}
