import type { RewindView } from "colyseus";
import { BIN_REACH, CAR_TYPES, MAX_REWIND_MS, NPC_RUN_SPEED, NpcState, PICKUP_FOOD, PLAYER_MAX_HP } from "../shared/constants.js";
import { nearestBin } from "../shared/map.js";
import { nearestManhole, sewerFlooded } from "../shared/sewer.js";
import { inPickupReach, inSnatchReach, type SeenCar, type SeenManhole, type SeenNpc, type SeenPickup, type WorldView } from "../shared/sim.js";
import { GULL_SNATCH_R } from "../shared/constants.js";
import type { Car, Pickup } from "../shared/schema.js";
import type { GameRoom } from "./GameRoom.js";
import { Spots } from "./Spots.js";

const CAR_FIELDS = ["x", "z", "yaw", "vx", "vz"] as const;
/** How far a car can have moved between what a client saw and now (broad-phase margin). */
const REWIND_SLACK = Math.max(...CAR_TYPES.map((t) => t.maxSpeed)) * (MAX_REWIND_MS / 1000);
const NPC_FIELDS = ["x", "y", "z"] as const;
/** How far a townsperson can have run between what a client saw and now (broad-phase margin). */
const NPC_SLACK = NPC_RUN_SPEED * (MAX_REWIND_MS / 1000);

/**
 * The server's answer to "what did this player see?": every car pose the shared
 * step reads comes from the lag-compensation rewind of the acting client, so the
 * server reaches the same verdict (landing on a roof, bumping a car, stealing it)
 * the client predicted from its own interpolated view.
 */
export class ServerWorld implements WorldView {
  private seen!: RewindView;
  private sid = "";
  private readonly scratch = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0 };
  private readonly npcScratch = { x: 0, y: 0, z: 0 };
  /** The trash can the acting player just tried to dive into while someone else hides in it (-1: none). */
  taken = -1;
  // (as of `frame`)
  private readonly carSpots = new Spots<Car>();
  private readonly pickupSpots = new Spots<Pickup>();

  constructor(private room: GameRoom) {}

  /**
   * Before the players' inputs: where every car and pickup is. None of them moves while the inputs
   * run (cars follow their drivers afterwards; loot only appears, lands and goes in `Loot.step`, and
   * loot in a gull's feet is never active), so these copies stay exact for the whole phase.
   */
  frame() {
    const cars = this.carSpots.reset(), pickups = this.pickupSpots.reset();
    for (const car of this.room.carsById.values()) cars.add("", car, car.x, car.z);
    for (const [id, pk] of this.room.state.pickups) pickups.add(id, pk, pk.x, pk.z);
  }

  bind(seen: RewindView, sid: string) {
    this.seen = seen;
    this.sid = sid;
    this.taken = -1;
  }

  private seenCar(id: number): SeenCar | null {
    const car = this.room.carsById.get(id);
    if (!car) return null;
    const type = CAR_TYPES[car.kind];
    // our own car is wherever we are: no rewind for it
    const pose = car.driver === this.sid ? car : this.seen.read(car, CAR_FIELDS, this.scratch);
    return {
      id, kind: car.kind, driven: car.driver !== "", wreck: car.state === 2,
      x: pose.x, z: pose.z, yaw: pose.yaw, vx: pose.vx, vz: pose.vz,
      halfW: type.halfW, halfL: type.halfL, roof: type.roof,
    };
  }

  cars(x: number, z: number, r: number): SeenCar[] {
    const out: SeenCar[] = [];
    const r2 = (r + 3) * (r + 3);
    const broad = (r + 3 + REWIND_SLACK) ** 2;
    const cars = this.carSpots;
    for (let i = 0; i < cars.n; i++) {
      if ((cars.x[i] - x) ** 2 + (cars.z[i] - z) ** 2 > broad) continue;
      const c = this.seenCar(cars.items[i].id);
      if (c && (c.x - x) ** 2 + (c.z - z) ** 2 <= r2) out.push(c);
    }
    // the golden dumpster, once it's down: solid, and you can stand on it (it never moves: no rewind)
    const crate = this.room.garbage.crate();
    if (crate && (crate.x - x) ** 2 + (crate.z - z) ** 2 <= r2) out.push(crate);
    return out;
  }

  /** A car to stand on: wrecks are only scenery. */
  car(id: number): SeenCar | null {
    const c = this.seenCar(id);
    return c && !c.wreck ? c : null;
  }

  carKind(id: number): number {
    return this.room.carsById.get(id)?.kind ?? 0;
  }

  /** A full loot can within reach (a snack only if the acting player isn't at full health). */
  pickup(x: number, y: number, z: number): SeenPickup | null {
    const pks = this.pickupSpots;
    for (let i = 0; i < pks.n; i++) {
      if ((x - pks.x[i]) ** 2 + (z - pks.z[i]) ** 2 > 1.5 * 1.5) continue;
      const pk = pks.items[i];
      if (!pk.active || (pk.kind === PICKUP_FOOD && this.full())) continue;
      if (inPickupReach({ x, y, z }, pk.x, pk.y, pk.z)) return { id: pks.keys[i], kind: pk.kind };
    }
    return null;
  }

  private full() {
    return (this.room.state.players.get(this.sid)?.hp ?? 0) >= PLAYER_MAX_HP;
  }

  /** The trash can within reach, if its lid is on and it's empty (an occupied one is noted in `taken`). */
  bin(x: number, y: number, z: number): number {
    const i = nearestBin(x, y, z, BIN_REACH);
    if (i < 0 || this.room.bins.lidOff(i)) return -1;
    const who = this.room.bins.occupant(i);
    if (who && who !== this.sid) { this.taken = i; return -1; }
    return i;
  }

  /** The manhole nearest (x, z) within `r`, and whether its lid is off (as it is now: lids are the server's). None while the sewer's flooded. */
  manhole(x: number, z: number, r: number): SeenManhole | null {
    if (sewerFlooded(this.room.state.round)) return null;
    const i = nearestManhole(x, z, r);
    return i < 0 ? null : { i, open: this.room.sewers.isOpen(i) };
  }

  /** Loot under a gull's feet: in a can or loose on the street, and in nobody else's feet. */
  snatch(x: number, y: number, z: number): SeenPickup | null {
    let best: SeenPickup | null = null, bestD = Infinity;
    const pks = this.pickupSpots;
    for (let i = 0; i < pks.n; i++) {
      if ((x - pks.x[i]) ** 2 + (z - pks.z[i]) ** 2 > GULL_SNATCH_R * GULL_SNATCH_R) continue;
      const id = pks.keys[i], pk = pks.items[i];
      if (!pk.active || pk.carrier || !inSnatchReach(x, y, z, pk.x, pk.y, pk.z, GULL_SNATCH_R)) continue;
      const d = (pk.x - x) ** 2 + (pk.z - z) ** 2;
      if (d < bestD) { bestD = d; best = { id, kind: pk.kind }; }
    }
    return best;
  }

  /** Standing lamp posts: as they are now (a post someone just knocked over is down for everyone after them). */
  poles(x: number, z: number, r: number): number[] {
    return this.room.poles.poles(x, z, r);
  }

  /**
   * Townsfolk a car can hit (on their feet or lying KO now), where the acting player saw them:
   * rewound on the reckon timeline to their input's stamp, the instant their client reckoned
   * them to. (`bind` already aimed the rewind there, so `_time` isn't needed.)
   */
  npcs(x: number, z: number, r: number, _time: number): SeenNpc[] {
    const out: SeenNpc[] = [];
    const broad = (r + NPC_SLACK) ** 2;
    for (const [key, npc] of this.room.state.npcs) {
      if (npc.state > NpcState.Flee && npc.state !== NpcState.KO) continue;
      if ((npc.x - x) ** 2 + (npc.z - z) ** 2 > broad) continue;
      const pos = this.seen.read(npc, NPC_FIELDS, this.npcScratch);
      if ((pos.x - x) ** 2 + (pos.z - z) ** 2 <= r * r) out.push({ key, x: pos.x, y: pos.y, z: pos.z });
    }
    return out;
  }
}
