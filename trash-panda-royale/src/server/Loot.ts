import { LOOSE_TTL_MS } from "../shared/constants.js";
import { Pickup } from "../shared/schema.js";
import { dropLanding, type GrenadeLike } from "../shared/sim.js";
import type { GameRoom } from "./GameRoom.js";

/**
 * Loose loot: loot that isn't sitting in its loot can. A gull snatches it out of a can (the can is
 * empty until it refills, as when a raccoon loots it) and carries it about in its feet, then lets
 * go of it somewhere; the golden dumpster bursts open with a fountain of it. Either way it flies in
 * from (ox, oy, oz) and lands at (x, y, z) at `at`, where anyone can grab it once (it never comes
 * back), until it's been lying there too long or the fumes get to it.
 *
 * Keyed "l1", "l2"…, in the same `pickups` map as the cans (so the shared step grabs it the same way).
 */
export class Loot {
  private seq = 0;
  /** When each loose one goes for good (room ms): taken (a moment after, so clients see it confirmed), or left lying. */
  private goneAt = new Map<string, number>();
  /** Taken already (it waits out its moment inactive, never to come back). */
  private taken = new Set<string>();

  constructor(private room: GameRoom) {}

  static isLoose(key: string) { return key.charCodeAt(0) === 108; /* "l" */ }

  /** A new loose `kind`, flying from `from` to `to`, landing at room ms `at`; or carried by gull `carrier`. */
  add(kind: number, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, at: number, carrier = ""): string {
    const key = `l${++this.seq}`;
    this.room.state.pickups.set(key, new Pickup({
      kind, active: false, loose: true, carrier,
      x: to.x, y: to.y, z: to.z, ox: from.x, oy: from.y, oz: from.z, at,
    }));
    // (in a gull's feet it doesn't go stale: only lying about)
    this.goneAt.set(key, carrier ? Infinity : at + LOOSE_TTL_MS);
    return key;
  }

  /** Gull `sid` snatched pickup `key`: out of its can (which empties), or a loose one off the street. */
  snatch(sid: string, key: string, p: { x: number; y: number; z: number }) {
    const pk = this.room.state.pickups.get(key);
    if (!pk || !pk.active || pk.carrier) return;
    if (pk.loose) {
      pk.active = false;
      pk.carrier = sid;
      // (it won't lie about: it's in someone's feet now)
      this.goneAt.set(key, Infinity);
      return;
    }
    this.room.emptyCan(key, pk);
    this.add(pk.kind, p, p, this.room.now, sid);
  }

  /** What gull `sid` carries, if anything (its key). */
  carried(sid: string): string {
    for (const [key, pk] of this.room.state.pickups) if (pk.carrier === sid) return key;
    return "";
  }

  /** Gull `sid` let go of what it carries, at `launch`: it falls, and lands where `dropLanding` says. */
  drop(sid: string, launch: GrenadeLike) {
    const key = this.carried(sid);
    const pk = key ? this.room.state.pickups.get(key) : undefined;
    if (!pk) return;
    const to = dropLanding(launch);
    pk.carrier = "";
    pk.ox = launch.x; pk.oy = launch.y; pk.oz = launch.z;
    pk.x = to.x; pk.y = to.y; pk.z = to.z;
    pk.at = this.room.now + to.t * 1000;
    this.goneAt.set(key, pk.at + LOOSE_TTL_MS);
  }

  /** Someone grabbed loose `key` (the shared step did): gone, once clients have seen it go. */
  take(key: string) {
    const pk = this.room.state.pickups.get(key);
    if (!pk) return;
    pk.active = false;
    this.taken.add(key);
    this.goneAt.set(key, this.room.now + 1000);
  }

  /** Landed ones become grabbable; old, gassed and taken ones go. */
  step() {
    const now = this.room.now;
    const gone: string[] = [];
    for (const [key, pk] of this.room.state.pickups) {
      if (!pk.loose) continue;
      if (now >= (this.goneAt.get(key) ?? 0)) { gone.push(key); continue; }
      if (pk.active || pk.carrier || this.taken.has(key) || now < pk.at) continue;
      // (landed in the fumes: gone)
      if (!this.room.br.pickupAllowed(pk)) { gone.push(key); continue; }
      pk.active = true;
    }
    for (const key of gone) this.remove(key);
  }

  private remove(key: string) {
    this.room.state.pickups.delete(key);
    this.goneAt.delete(key);
    this.taken.delete(key);
  }

  /** A new round: no loose loot about. */
  reset() {
    const loose = [...this.room.state.pickups.entries()].filter(([, pk]) => pk.loose).map(([key]) => key);
    for (const key of loose) this.remove(key);
  }
}
