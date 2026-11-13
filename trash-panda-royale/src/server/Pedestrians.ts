import { MAX_REWIND_MS, NPC_COUNT, NPC_RUN_SPEED, NPC_WALK_SPEED, NpcState, TICK_RATE } from "../shared/constants.js";
import { CITY } from "../shared/map.js";
import { Npc, type Car } from "../shared/schema.js";
import { stepNpcFlight, wrapAngle } from "../shared/sim.js";
import type { GameRoom } from "./GameRoom.js";

interface Brain {
  from: number;
  to: number;
  until: number;
  dangerX: number;
  dangerZ: number;
  /** Since when (room ms) they've been caught in the fumes; 0 when not. */
  gassed: number;
  /** Room ms a run-over's flight is already stepped to (`launchFrom`; 0: none): `step` goes on from there. */
  flownTo: number;
}

const freshBrain = (): Brain => ({ from: 0, to: 0, until: 0, dangerX: 0, dangerZ: 0, gassed: 0, flownTo: 0 });

/** Server-driven townsfolk: stroll the sidewalks, panic at gunfire, fly when hit. */
export class Pedestrians {
  private brains = new Map<Npc, Brain>();

  constructor(private room: GameRoom) {}

  populate() {
    for (let i = 0; i < NPC_COUNT; i++) {
      const npc = new Npc({ look: Math.floor(this.room.rand() * 0xffffffff) >>> 0 });
      this.brains.set(npc, freshBrain());
      this.placeAtRandomNode(npc);
      this.room.state.npcs.set(String(i), npc);
    }
  }

  /** A new round: everyone back on the sidewalks, calm. */
  resetAll() {
    for (const npc of this.room.state.npcs.values()) {
      this.brains.set(npc, freshBrain());
      this.placeAtRandomNode(npc);
    }
  }

  private placeAtRandomNode(npc: Npc) {
    const b = this.brains.get(npc)!;
    // during a round, somewhere outside the fumes if we can find it
    let node = Math.floor(this.room.rand() * CITY.nav.length);
    for (let k = 0; k < 12 && this.room.br.outside(CITY.nav[node].x, CITY.nav[node].z); k++) {
      node = Math.floor(this.room.rand() * CITY.nav.length);
    }
    const n = CITY.nav[node];
    b.from = node;
    b.to = n.links[Math.floor(this.room.rand() * n.links.length)];
    const t = this.room.rand();
    const m = CITY.nav[b.to];
    npc.x = n.x + (m.x - n.x) * t;
    npc.z = n.z + (m.z - n.z) * t;
    npc.y = 0;
    npc.vx = 0; npc.vy = 0; npc.vz = 0;
    npc.state = NpcState.Walk;
  }

  /** Brains live outside the synced state; rebuild one if a restored room lost it. */
  private brain(npc: Npc): Brain {
    let b = this.brains.get(npc);
    if (!b) {
      b = freshBrain();
      this.brains.set(npc, b);
      this.placeAtRandomNode(npc);
    }
    return b;
  }

  step(dt: number) {
    const now = this.room.now;
    const zone = this.room.br.zone;
    for (const npc of this.room.state.npcs.values()) {
      const b = this.brain(npc);
      // caught in the fumes: run for the middle (away from a point out past the edge),
      // and if they're still in it after a while, they're gone
      if (npc.state <= NpcState.Flee && this.room.br.outside(npc.x, npc.z)) {
        if (!b.gassed) b.gassed = now;
        if (now - b.gassed > 8000) {
          npc.state = NpcState.Hidden;
          b.until = now + 3000;
          b.gassed = 0;
          continue;
        }
        if (npc.state === NpcState.Walk || now > b.until - 4000) {
          const dx = npc.x - zone.x, dz = npc.z - zone.z, d = Math.hypot(dx, dz) || 1;
          npc.state = NpcState.Flee;
          b.until = now + 5000;
          b.dangerX = npc.x + (dx / d) * 30;
          b.dangerZ = npc.z + (dz / d) * 30;
          // heading further out? turn around now
          const t = CITY.nav[b.to];
          if (Math.hypot(t.x - zone.x, t.z - zone.z) > d) { const s = b.to; b.to = b.from; b.from = s; }
        }
      } else b.gassed = 0;
      switch (npc.state) {
        case NpcState.Walk:
        case NpcState.Flee: {
          if (npc.state === NpcState.Flee && now > b.until) npc.state = NpcState.Walk;
          const speed = npc.state === NpcState.Flee ? NPC_RUN_SPEED : NPC_WALK_SPEED;
          const t = CITY.nav[b.to];
          let dx = t.x - npc.x, dz = t.z - npc.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.5) {
            this.chooseNext(npc, b);
            continue;
          }
          dx /= d; dz /= d;
          npc.vx = dx * speed;
          npc.vz = dz * speed;
          npc.x += npc.vx * dt;
          npc.z += npc.vz * dt;
          npc.yaw += wrapAngle(Math.atan2(dx, dz) - npc.yaw) * Math.min(1, 10 * dt);
          break;
        }
        case NpcState.Flying: {
          // (a run-over's flight is stepped to `flownTo` already: it goes on from there)
          const span = b.flownTo ? Math.min(dt, (now - b.flownTo) / 1000) : dt;
          if (span <= 0) break;
          b.flownTo = 0;
          this.fly(npc, b, span);
          break;
        }
        case NpcState.KO:
          if (now > b.until) { npc.state = NpcState.Hidden; b.until = now + 3000; }
          break;
        case NpcState.Hidden:
          if (now > b.until) this.placeAtRandomNode(npc);
          break;
      }
    }
  }

  /** One step of a flight: off walls, bouncing, and lying KO once it's over. */
  private fly(npc: Npc, b: Brain, dt: number) {
    npc.yaw += 9 * dt;
    if (stepNpcFlight(npc, dt)) {
      npc.state = NpcState.KO;
      b.until = this.room.now + 6000;
    }
  }

  private chooseNext(npc: Npc, b: Brain) {
    const at = b.to;
    const node = CITY.nav[at];
    let next = node.links[Math.floor(this.room.rand() * node.links.length)];
    if (npc.state === NpcState.Flee) {
      // run to whichever neighbour is farthest from the danger
      let best = -1;
      for (const l of node.links) {
        const m = CITY.nav[l];
        const d = (m.x - b.dangerX) ** 2 + (m.z - b.dangerZ) ** 2;
        if (d > best) { best = d; next = l; }
      }
    } else if (next === b.from && node.links.length > 1 && this.room.rand() < 0.8) {
      next = node.links[(node.links.indexOf(next) + 1) % node.links.length];
    }
    b.from = at;
    b.to = next;
  }

  /** Everyone within `radius` of (x, z) panics. */
  scare(x: number, z: number, radius: number) {
    const now = this.room.now;
    for (const npc of this.room.state.npcs.values()) {
      if (npc.state > NpcState.Flee) continue;
      if ((npc.x - x) ** 2 + (npc.z - z) ** 2 > radius * radius) continue;
      const b = this.brain(npc);
      npc.state = NpcState.Flee;
      b.until = now + 5000 + this.room.rand() * 3000;
      b.dangerX = x; b.dangerZ = z;
      // turn around right away if we're walking toward the danger
      const t = CITY.nav[b.to];
      if ((t.x - x) ** 2 + (t.z - z) ** 2 < (npc.x - x) ** 2 + (npc.z - z) ** 2) {
        const s = b.to; b.to = b.from; b.from = s;
      }
    }
  }

  /** Send `npc` flying. */
  launch(npc: Npc, vx: number, vy: number, vz: number) {
    npc.state = NpcState.Flying;
    npc.vx = vx; npc.vy = vy; npc.vz = vz;
    npc.y = Math.max(npc.y, 0.05);
  }

  /**
   * Send `npc` flying from (x, y, z) as of `ageMs` before the end of this tick (positions after
   * a tick are as of its `now`): already that far into the flight. A driver's client drew this
   * very flight from that instant on (where it saw them hit), so this way it carries on along
   * the same path for them. (Launched after this tick's `now`, as at next to no latency, it
   * sets off next tick, from then.)
   */
  launchFrom(npc: Npc, l: { x: number; y: number; z: number; vx: number; vy: number; vz: number }, ageMs: number) {
    const b = this.brain(npc);
    npc.x = l.x; npc.y = l.y; npc.z = l.z;
    this.launch(npc, l.vx, l.vy, l.vz);
    const step = 1 / TICK_RATE;
    for (let left = Math.min(ageMs, MAX_REWIND_MS) / 1000; left > 1e-6 && npc.state === NpcState.Flying; left -= step) {
      this.fly(npc, b, Math.min(step, left));
    }
    b.flownTo = this.room.now - Math.min(ageMs, 0);
  }

  /** The AI driver of a stolen car tumbles out and runs off screaming. */
  ejectDriver(car: Car) {
    let pick: Npc | null = null;
    for (const npc of this.room.state.npcs.values()) if (npc.state === NpcState.Hidden) { pick = npc; break; }
    if (!pick) return;
    const lx = Math.cos(car.yaw), lz = -Math.sin(car.yaw);
    pick.x = car.x + lx * 1.6;
    pick.z = car.z + lz * 1.6;
    pick.y = 0;
    const b = this.brain(pick);
    // join the nearest sidewalk node
    let best = 0, bestD = Infinity;
    CITY.nav.forEach((n, i) => {
      const d = (n.x - pick!.x) ** 2 + (n.z - pick!.z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    b.from = best; b.to = best;
    this.launch(pick, lx * 5, 4, lz * 5);
    b.dangerX = car.x; b.dangerZ = car.z;
  }
}
