import assert from "assert";
import { AI_TRAFFIC, CAR_MAX_HP, CAR_TYPES, TICK_RATE } from "../src/shared/constants.ts";
import { distPointLine, makeLine } from "../src/shared/geom.ts";
import { LANES } from "../src/shared/lanes.ts";
import { EDGE_NO_CARS, EDGE_NO_TRAFFIC } from "../src/shared/layout.ts";
import { CITY, collideCircle, mulberry32 } from "../src/shared/map.ts";
import { Traffic, type CarBody } from "../src/server/Traffic.ts";

/**
 * The AI traffic on the town's lanes, five simulated minutes of it, against a stand-in for the
 * room (just what `Traffic` reads): cars keep to the streets open to them, keep moving, and never
 * end up inside anything.
 */
describe("AI traffic on the lanes", () => {
  const lines = CITY.roads.edges.map((e) => ({ e, line: makeLine(e.pts) }));
  /** How far (x, z) is from the nearest street a car may use, past its asphalt. */
  const offStreet = (x: number, z: number) => {
    let best = Infinity;
    for (const { e, line } of lines) {
      if (e.flags & (EDGE_NO_CARS | EDGE_NO_TRAFFIC) || e.half <= 0) continue;
      best = Math.min(best, distPointLine(x, z, line) - e.half);
    }
    return best;
  };

  it("has lanes, each leading somewhere", () => {
    assert.ok(LANES.length > 20, `${LANES.length} lanes`);
    for (const l of LANES) assert.ok(l.next.length > 0, `lane on street ${l.edge} leads nowhere`);
  });

  it("five minutes of driving: on the streets, moving, never inside a wall", () => {
    const rand = mulberry32(42);
    let nextId = 1;
    const cars = new Map<number, any>();
    const bodies = new Map<number, CarBody>();
    const room: any = {
      now: 0, rand,
      carsById: cars, bodies,
      state: { players: new Map(), npcs: new Map() },
      br: { live: false, zone: { x: 0, z: 0, r: 999 }, outside: () => false },
      interest: { broadcastNear() {} },
      poles: { poles: (): number[] => [], knock() {} },
      combat: { explodeCar() {} },
      info: (): undefined => undefined,
      newCar(kind: number, x: number, z: number, yaw: number) {
        const car = { id: nextId++, kind, x, y: 0, z, yaw, vx: 0, vz: 0, steer: 0, driver: "", state: 0, hp: CAR_MAX_HP, lights: 0, siren: false, paint: CAR_TYPES[kind].paint[0] };
        cars.set(car.id, car);
        bodies.set(car.id, { vy: 0, yawRate: 0, ai: null, idleSince: 0, burnUntil: 0, wreckUntil: 0, lastHitBy: "", sirenUntil: 0 });
        return car;
      },
    };
    const traffic = new Traffic(room);
    traffic.populate();
    const ai = [...cars.values()].filter((c) => c.id <= AI_TRAFFIC);
    assert.strictEqual(ai.length, AI_TRAFFIC);
    const dt = 1 / TICK_RATE;
    const steps = 5 * 60 * TICK_RATE;
    /** Per car: where it was at the start of the current 20 s window, how far it got, how often it was put elsewhere. */
    const track = new Map(ai.map((c) => [c.id, { x0: c.x, z0: c.z, px: c.x, pz: c.z, recycled: 0, slowWindows: 0 }]));
    let worstOff = 0, worstAt = "";
    for (let i = 1; i <= steps; i++) {
      room.now = (i * 1000) / TICK_RATE;
      traffic.step(dt);
      for (const c of ai) {
        const t = track.get(c.id)!;
        // put elsewhere (unstuck): a jump in one step
        if (Math.hypot(c.x - t.px, c.z - t.pz) > 10) { t.recycled++; t.x0 = c.x; t.z0 = c.z; }
        t.px = c.x; t.pz = c.z;
        const off = offStreet(c.x, c.z);
        if (off > worstOff) { worstOff = off; worstAt = `car ${c.id} at (${c.x.toFixed(1)}, ${c.z.toFixed(1)}) step ${i}`; }
      }
      if (i % (20 * TICK_RATE) === 0) {
        for (const c of ai) {
          const t = track.get(c.id)!;
          if (Math.hypot(c.x - t.x0, c.z - t.z0) < 30) t.slowWindows++;
          t.x0 = c.x; t.z0 = c.z;
        }
      }
    }
    assert.ok(worstOff < 1.6, `strayed ${worstOff.toFixed(2)} m off the asphalt: ${worstAt}`);
    const stuck = [...track].filter(([, t]) => t.slowWindows > 3);
    assert.ok(stuck.length <= 2, `cars that kept stalling: ${stuck.map(([id, t]) => `${id} (${t.slowWindows} slow windows, ${t.recycled} recycled)`).join(", ")}`);
    for (const c of ai) {
      const type = CAR_TYPES[c.kind];
      const p = { x: c.x, z: c.z };
      assert.ok(!collideCircle(p, 0, type.halfW * 0.8, true), `car ${c.id} ended inside something at (${c.x.toFixed(1)}, ${c.z.toFixed(1)})`);
    }
  });
});
