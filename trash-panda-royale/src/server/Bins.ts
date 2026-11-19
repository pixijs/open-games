import {
  BIN_HOP_SPEED, BIN_HOP_UP, BIN_LID_MS, BIN_POP_DAZE, BIN_POP_SPEED, BIN_POP_UP, BIN_REVEAL_MS, Mode, NEAR_EVENTS, ticks,
} from "../shared/constants.js";
import { BIN_R, CITY, circleObb } from "../shared/map.js";
import { Bin, type Player } from "../shared/schema.js";
import { leaveBin, type PlayerSim } from "../shared/sim.js";
import type { GameRoom } from "./GameRoom.js";

/**
 * The trash cans raccoons hide in, on the server's side.
 *
 * Who hides where is never synced: it's the hiders' own state (`Mode.Hidden`, `veh` = the
 * can), and `Interest` drops a hider from everyone else's view once those around have had a
 * moment to see them dive in (`secret`). All anyone else gets is whether each can's lid is on.
 *
 * Damage pops a hider out: a hit on the can (a shot, a slap, a stink bomb, a car) knocks its
 * lid off and flings whoever is inside out of it, dazed, and nobody can hide in that can
 * until its lid is back on. Getting hurt in a can some other way (the fumes) makes you hop out.
 */
export class Bins {
  /** When each can's lid goes back on (room ms; 0 while it's on). */
  private lidBack: number[] = CITY.bins.map(() => 0);
  /** When each hider dove in (room ms). */
  private hiddenAt = new Map<string, number>();

  constructor(private room: GameRoom) {}

  /** One synced entry per can (also rebuilds what a dev-mode restore didn't bring back). */
  ensure() {
    const bins = this.room.state.bins;
    if (bins.size === CITY.bins.length) return;
    CITY.bins.forEach((_, i) => { if (!bins.has(String(i))) bins.set(String(i), new Bin()); });
  }

  /** Who hides in can `i` ("" for nobody). */
  occupant(i: number): string {
    for (const [sid, p] of this.room.state.players) if (p.mode === Mode.Hidden && p.veh === i) return sid;
    return "";
  }

  lidOff(i: number): boolean {
    return this.room.state.bins.get(String(i))?.lidOff ?? false;
  }

  /** In a can long enough that only they (and whoever spectates them) get their updates. */
  secret(sid: string, p: Player): boolean {
    return p.mode === Mode.Hidden && this.room.now - (this.hiddenAt.get(sid) ?? -Infinity) >= BIN_REVEAL_MS;
  }

  /** `sid`'s own step dove into a can. */
  onHide(sid: string) {
    this.hiddenAt.set(sid, this.room.now);
  }

  /** `sid`'s own step hopped out of can `i`: back in everyone's sight now, and they see the lid flip. */
  onUnhide(sid: string, p: Player, i: number) {
    this.hiddenAt.delete(sid);
    this.room.interest.reveal(p);
    const b = CITY.bins[i];
    // (`y`: which way they hopped, for the lid to flip up on that side)
    const y = +Math.atan2(p.vx, p.vz).toFixed(2);
    if (b) this.room.interest.broadcastNear("unhide", { s: sid, c: i, y }, b.x, b.z, NEAR_EVENTS, this.room.clients.getById(sid));
  }

  /** `sid` tried a can someone else already hides in: they hear about it, and so does the one inside. */
  knock(i: number, sid: string) {
    const who = this.occupant(i);
    if (!who || who === sid) return;
    this.room.clients.getById(sid)?.send("taken", { c: i });
    this.room.clients.getById(who)?.send("knock", { c: i });
  }

  forget(sid: string) {
    this.hiddenAt.delete(sid);
  }

  /**
   * Can `i` was hit along (dx, dz) by `by` ("" for nobody in particular): its lid flies off
   * and whoever hides in it pops out, flung away from the hit. Returns who popped out ("").
   */
  hit(i: number, by: string, dx: number, dz: number): string {
    const st = this.room.state.bins.get(String(i));
    if (!st || !CITY.bins[i]) return "";
    const sid = this.occupant(i);
    const p = sid ? this.room.state.players.get(sid) : undefined;
    // a can that's already open (and so empty) just clangs: the shooter drew that themselves
    if (st.lidOff && !p) return "";
    if (!st.lidOff) {
      st.lidOff = true;
      st.lidYaw = Math.atan2(dx, dz);
      this.lidBack[i] = this.room.now + BIN_LID_MS;
    }
    if (p) {
      this.eject(sid, p, dx, dz, true);
      const finder = by && by !== sid ? this.room.info(by) : undefined;
      if (finder) this.room.broadcast("feed", { text: `${finder.name} found ${p.name} in a trash can!`, i: "bin" });
    }
    const b = CITY.bins[i];
    const l = Math.hypot(dx, dz) || 1;
    this.room.interest.broadcastNear("bin", { c: i, s: sid, b: by, x: +(dx / l).toFixed(2), z: +(dz / l).toFixed(2) }, b.x, b.z, NEAR_EVENTS);
    return sid;
  }

  /**
   * Out of their can: flung along (dx, dz) (their facing if that's nothing) and knocked
   * down for a moment (`dazed`, a hit), or hopping out on their own (the fumes, a win).
   */
  eject(sid: string, p: Player, dx: number, dz: number, dazed: boolean) {
    const b = CITY.bins[p.veh];
    if (p.mode !== Mode.Hidden || !b) return;
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) { dx = Math.sin(p.yaw); dz = Math.cos(p.yaw); } else { dx /= l; dz /= l; }
    const s = p as unknown as PlayerSim;
    if (dazed) {
      // straight up out of the can, like a jack-in-the-box
      leaveBin(s, b, dx, dz, BIN_POP_SPEED, BIN_POP_UP);
      p.mode = Mode.Knocked;
      p.timer = ticks(BIN_POP_DAZE);
    } else {
      leaveBin(s, b, dx, dz, BIN_HOP_SPEED, BIN_HOP_UP, BIN_R + 0.05);
    }
    this.hiddenAt.delete(sid);
    this.room.interest.reveal(p);
  }

  /**
   * A car body (x, z, yaw, half sizes) ploughed through whatever cans it touches. Whoever pops
   * out is flung off to the side of it the can was on, out of the car's way (the can took the hit).
   */
  ram(x: number, z: number, yaw: number, halfW: number, halfL: number, by: string) {
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    CITY.bins.forEach((b, i) => {
      if ((b.x - x) ** 2 + (b.z - z) ** 2 > 25) return;
      if (!circleObb(b.x, b.z, BIN_R + 0.3, x, z, yaw, halfW, halfL)) return;
      const side = (b.x - x) * rx + (b.z - z) * rz < 0 ? -1 : 1;
      this.hit(i, by, rx * side, rz * side);
    });
  }

  /** Lids go back on once their time is up. */
  step() {
    const now = this.room.now;
    for (const [key, st] of this.room.state.bins) {
      const i = Number(key);
      // (a dev-mode restore brings lids back off, but not when they go back on)
      if (st.lidOff && !this.lidBack[i]) this.lidBack[i] = now + BIN_LID_MS;
      if (!this.lidBack[i] || now < this.lidBack[i]) continue;
      this.lidBack[i] = 0;
      st.lidOff = false;
    }
  }

  /** A new round: every lid back on. */
  reset() {
    for (const st of this.room.state.bins.values()) st.lidOff = false;
    this.lidBack.fill(0);
    this.hiddenAt.clear();
  }
}
