import { polesNear } from "../shared/map.js";
import type { PoleWorld } from "../shared/sim.js";
import type { GameRoom } from "./GameRoom.js";

/**
 * The lamp posts cars knock over, on the server's side. All there is to it is the synced
 * `poles` map: a fallen post's index and which way it fell (decided by the shared step, so the
 * driver's client predicted the very same byte). Everyone draws it falling that way.
 */
export class Poles implements PoleWorld {
  constructor(private room: GameRoom) {}

  down(i: number): boolean {
    return this.room.state.poles.has(String(i));
  }

  poles(x: number, z: number, r: number): number[] {
    const near = polesNear(x, z, r);
    // (most of the time every post is standing)
    return this.room.state.poles.size ? near.filter((i) => !this.down(i)) : near;
  }

  knock(i: number, fall: number) {
    if (!this.down(i)) this.room.state.poles.set(String(i), fall);
  }

  /** A new round: every post stands again. */
  reset() {
    this.room.state.poles.clear();
  }
}
