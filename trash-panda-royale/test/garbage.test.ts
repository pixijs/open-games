import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.ts";
import {
  CAR_GARBAGE, CAR_MAX_HP, CAR_TYPES, DUMPSTER_HD, DUMPSTER_HW, GARBAGE_AT_S, GARBAGE_LOCK_MS, GARBAGE_LOOT, GARBAGE_LOOT_R, GarbagePhase, Mode, RoundPhase, TICK_RATE,
} from "../src/shared/constants.ts";
import { crateOf, dumpSpot } from "../src/shared/garbage.ts";
import { circleObb, CITY, collideCircle, groundHeight, mulberry32, roomAt } from "../src/shared/map.ts";
import { PlayerInput } from "../src/shared/schema.ts";
import { stepPlayer, type InputLike, type PlayerSim, type SimCtx, type WorldView } from "../src/shared/sim.ts";
import { TRAIN_SLOTS, trainCarPose, type CarPose } from "../src/shared/train.ts";
import { nextCircle, ZONE_R0, ZONE_STAGES } from "../src/shared/zone.ts";
import { GarbageDay } from "../src/server/GarbageDay.ts";
import type { CarBody } from "../src/server/Traffic.ts";
import type { GameRoom } from "../src/server/GameRoom.ts";

const DT = 1 / TICK_RATE;

/** Just what `GarbageDay` reads of a room, with no traffic about (see traffic.test.ts). */
function fakeRoom(zone: { x0: number; z0: number; r0: number; x1: number; z1: number; r1: number }) {
  let nextId = 1;
  const loot: { kind: number; to: { x: number; y: number; z: number }; at: number }[] = [];
  const feed: string[] = [];
  const room: any = {
    now: 0, rand: mulberry32(9),
    carsById: new Map<number, any>(), bodies: new Map<number, CarBody>(),
    state: {
      players: new Map(), npcs: new Map(), pickups: new Map(),
      round: { phase: RoundPhase.Live, zone },
      garbage: { phase: 0, x: 0, z: 0, yaw: 0, at: 0, truck: 0 },
    },
    br: { zone: { x: zone.x0, z: zone.z0, r: zone.r0 }, pickupAllowed: () => true },
    interest: { broadcastNear() {} },
    broadcast: (type: string, m: any) => { if (type === "feed") feed.push(m.text); },
    poles: { poles: (): number[] => [], knock() {} },
    loot: { add: (kind: number, _from: unknown, to: any, at: number) => { loot.push({ kind, to, at }); return `l${loot.length}`; } },
    newCar(kind: number, x: number, z: number, yaw: number) {
      const car = { id: nextId++, kind, x, y: 0, z, yaw, vx: 0, vz: 0, steer: 0, driver: "", state: 0, hp: CAR_MAX_HP, lights: 0, siren: false, paint: 0 };
      room.carsById.set(car.id, car);
      room.bodies.set(car.id, { vy: 0, yawRate: 0, ai: null, idleSince: 0, burnUntil: 0, wreckUntil: 0, lastHitBy: "", sirenUntil: 0 });
      return car;
    },
  };
  return { room, loot, feed };
}

const _t: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };

describe("Garbage Day", () => {
  it("the truck pulls up by a lane well inside the next circle, near its middle, with room by the kerb for the dumpster: for any circle", () => {
    const rand = mulberry32(7);
    let tried = 0;
    for (let k = 0; k < 60; k++) {
      // the next circle of the first or second stage, as the server would pick it
      const st = k % 2 ? 1 : 0;
      const c0 = st ? nextCircle(rand, 0, 0, ZONE_R0, ZONE_STAGES[0].r, { x: 0, z: 0 }) : { x: 0, z: 0 };
      const r0 = st ? ZONE_STAGES[0].r : ZONE_R0;
      const c1 = nextCircle(rand, c0.x, c0.z, r0, ZONE_STAGES[st].r, { x: 0, z: 0 });
      const { room } = fakeRoom({ x0: c0.x, z0: c0.z, r0, x1: c1.x, z1: c1.z, r1: ZONE_STAGES[st].r });
      const gd = new GarbageDay(room);
      const stop = (gd as any).pickStop() as { lane: number; s: number } | null;
      assert.ok(stop, `circle ${k}: nowhere to stop`);
      tried++;
      const g = room.state.garbage;
      gd.ensureTruck();
      (gd as any).begin();
      assert.strictEqual(g.phase, GarbagePhase.Coming, `circle ${k}: on its way`);
      const r1 = ZONE_STAGES[st].r;
      assert.ok(Math.hypot(g.x - c1.x, g.z - c1.z) < r1 - Math.min(30, r1 * 0.5) + 3, `circle ${k}: the dumpster's spot well inside the next circle`);
      assert.ok(roomAt(CITY, g.x, g.z, 0, 1.2), `circle ${k}: the dumpster's spot at (${g.x.toFixed(1)}, ${g.z.toFixed(1)}) isn't clear`);
      assert.ok(Math.abs(groundHeight(g.x, g.z, 1)) < 0.3, `circle ${k}: the dumpster's spot isn't on the street`);
    }
    assert.ok(tried >= 60);
  });

  it("drives in from the edge of town (waiting at the level crossing), pulls up, lowers the dumpster, which bursts on time into a ring of loot; then off out of town", () => {
    const { room, loot, feed } = fakeRoom({ x0: 0, z0: 0, r0: ZONE_R0, x1: 10, z1: -15, r1: 115 });
    const gd = new GarbageDay(room);
    gd.ensureTruck();
    gd.onGo(0, 1);
    const g = room.state.garbage;
    const truck = room.carsById.get(g.truck)!;
    assert.strictEqual(truck.kind, CAR_GARBAGE);
    const type = CAR_TYPES[CAR_GARBAGE];
    const phases: [number, number][] = [];
    let worstWall = 0, trainHits = 0, burstAt = 0, parkedAt = 0;
    const _p = { x: 0, z: 0 }, _n = { x: 0, z: 0 };
    for (let i = 1; i <= 200 * TICK_RATE && !parkedAt; i++) {
      room.now = (i * 1000) / TICK_RATE;
      gd.step(DT);
      if (!phases.length || phases[phases.length - 1][0] !== g.phase) phases.push([g.phase, room.now]);
      if (g.phase === GarbagePhase.Open && !burstAt) burstAt = room.now;
      if (g.phase === GarbagePhase.Open && truck.driver === "" && Math.abs(truck.z + 900) < 1) parkedAt = room.now;
      else if (g.phase >= GarbagePhase.Coming && truck.driver === "npc") assert.ok(Math.max(Math.abs(truck.x), Math.abs(truck.z)) <= 165, "inside the map");
      // in town (not out on the spokes past the edge), never in a wall; never run into by a train
      if (Math.abs(truck.x) < 160 && Math.abs(truck.z) < 160 && truck.driver === "npc") {
        const off = type.halfL - type.halfW;
        for (const sgn of [1, -1]) {
          _p.x = truck.x + Math.sin(truck.yaw) * off * sgn; _p.z = truck.z + Math.cos(truck.yaw) * off * sgn;
          const x0 = _p.x, z0 = _p.z;
          if (collideCircle(_p, 0, type.halfW, true, _n)) worstWall = Math.max(worstWall, Math.hypot(_p.x - x0, _p.z - z0));
        }
        for (let slot = 0; slot < TRAIN_SLOTS; slot++) {
          const t = trainCarPose(slot, room.now, _t);
          if (circleObb(truck.x, truck.z, type.halfW, t.x, t.z, t.yaw, t.halfW, t.halfL)) trainHits++;
        }
      }
    }
    const seq = phases.map(([p]) => p);
    assert.deepStrictEqual(seq.slice(0, 5), [GarbagePhase.None, GarbagePhase.Coming, GarbagePhase.Lowering, GarbagePhase.Locked, GarbagePhase.Open], `phases ${seq}`);
    const comingAt = phases[1][1];
    assert.ok(Math.abs(comingAt - GARBAGE_AT_S * 1000) <= 40, `announced at ${comingAt} ms`);
    const lockedAt = phases[3][1];
    assert.ok(Math.abs(burstAt - lockedAt - GARBAGE_LOCK_MS) <= 40, "padlocked for GARBAGE_LOCK_MS");
    assert.ok(worstWall < 0.3, `the truck ploughed ${worstWall.toFixed(2)} m into a wall`);
    assert.strictEqual(trainHits, 0, "a train ran into the truck");
    // stopped by the dumpster's spot: the truck's right flank, level with its lift
    assert.ok(feed.some((t) => /GARBAGE DAY/.test(t)) && feed.some((t) => /burst open/.test(t)));
    assert.strictEqual(loot.length, GARBAGE_LOOT.length);
    for (const l of loot) {
      const d = Math.hypot(l.to.x - g.x, l.to.z - g.z);
      assert.ok(d >= 1.2 && d <= GARBAGE_LOOT_R[1] + 0.5, `loot ${d.toFixed(1)} m out`);
      assert.ok(!circleObb(l.to.x, l.to.z, 0.3, g.x, g.z, g.yaw, DUMPSTER_HW, DUMPSTER_HD), "not inside the dumpster");
      assert.ok(roomAt(CITY, l.to.x, l.to.z, 0.2, 0.4), `loot at (${l.to.x.toFixed(1)}, ${l.to.z.toFixed(1)}) in something`);
      assert.ok(l.at > burstAt, "lands after the burst");
    }
    assert.ok(parkedAt > burstAt, "left town and went home");
  });

  it("whoever is in or on the truck is put off it when it sets off (it leaves from the edge of town), and when it goes home", () => {
    const { room } = fakeRoom({ x0: 0, z0: 0, r0: ZONE_R0, x1: 10, z1: -15, r1: 115 });
    const gd = new GarbageDay(room);
    gd.ensureTruck();
    const truck = room.carsById.get(room.state.garbage.truck)!;
    const p: any = { mode: Mode.Driving, veh: truck.id, y: 0, vy: 0, grounded: true, life: 0 };
    const q: any = { mode: Mode.Roof, veh: truck.id, y: 2.8, vy: 0, grounded: true, life: 0 };
    room.state.players.set("p", p); room.state.players.set("q", q);
    room.br.isPlaying = () => true;
    gd.startNow();
    assert.strictEqual(room.state.garbage.phase, GarbagePhase.Coming);
    assert.ok(p.mode === Mode.Foot && q.mode === Mode.Foot && p.life === 1, "both off it");
    p.mode = Mode.Driving; p.veh = truck.id;
    gd.reset();
    assert.strictEqual(p.mode, Mode.Foot);
  });

  it("stolen on its way, the dumpster tips off right there; wrecked, the same", () => {
    for (const how of ["stolen", "wrecked"]) {
      const { room, feed } = fakeRoom({ x0: 0, z0: 0, r0: ZONE_R0, x1: -20, z1: 30, r1: 115 });
      const gd = new GarbageDay(room);
      gd.ensureTruck();
      gd.startNow();
      const g = room.state.garbage, truck = room.carsById.get(g.truck)!;
      for (let i = 1; i <= 12 * TICK_RATE; i++) { room.now = (i * 1000) / TICK_RATE; gd.step(DT); }
      assert.strictEqual(g.phase, GarbagePhase.Coming);
      if (how === "stolen") truck.driver = "someone";
      else { truck.state = 2; room.bodies.get(truck.id)!.wreckUntil = room.now + 12000; }
      room.now += 33;
      gd.step(DT);
      assert.strictEqual(g.phase, GarbagePhase.Lowering, `${how}: it came off`);
      assert.ok(Math.hypot(g.x - truck.x, g.z - truck.z) < 4.5, `${how}: right by the truck`);
      assert.ok(feed.some((t) => /fell off/.test(t)));
    }
  });

  it("the dumpster down is solid, and you can stand on it (the shared step: it's in `cars`, as a wreck)", () => {
    // (on the open ground outside the town's north-east corner: nothing else to bump into)
    const spot = dumpSpot(150, 150, 0);
    const crate = crateOf(spot);
    const w: WorldView = {
      cars: () => [crate], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null,
    };
    const p: PlayerSim = {
      x: crate.x + 3, y: 0, z: crate.z, vx: 0, vy: 0, vz: 0, yaw: 0, mode: Mode.Foot, veh: -1, lx: 0, ly: 0, lz: 0, lyaw: 0, steer: 0, yawRate: 0,
      grounded: true, weapon: 0, ammo1: 0, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
    };
    const go = (cmd: Partial<InputLike>, n: number) => {
      for (let k = 0; k < n; k++) {
        const ctx: SimCtx = { dt: DT, time: 0, memo: (_k, f) => f() };
        stepPlayer(ctx, p, { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 0, ...cmd }, w);
      }
    };
    go({ mx: -100 }, 30);
    assert.ok(p.x > crate.x + 0.3, `walked into it: stopped at x ${p.x.toFixed(2)}`);
    // a running jump onto it: standing on its top
    go({ mx: -100, jump: true }, 2);
    go({ mx: -100 }, 6);
    go({}, 20);
    assert.ok(Math.abs(p.y - crate.roof) < 0.01, `standing on it (y ${p.y.toFixed(2)})`);
    assert.strictEqual(p.mode, Mode.Foot, "not riding it");
  });
});

describe("Garbage Day in a room", function () {
  this.timeout(30000);
  let colyseus: ColyseusTestServer;
  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => await colyseus.cleanup());

  it("announced in a live round: the truck sets off, beacons going; a new round sends it home", async () => {
    const r = (await colyseus.createRoom("town", { br: { countdownMs: 300, victoryMs: 300, pace: 0.05 } })) as unknown as GameRoom;
    const clients = [];
    for (const name of ["Ann", "Bob"]) {
      const c = await colyseus.connectTo(r as any, { name });
      await c.waitForInitialState?.();
      clients.push({ c, input: c.input({ type: PlayerInput }) as any });
    }
    const t0 = Date.now();
    while (r.state.round.phase !== RoundPhase.Live && Date.now() - t0 < 4000) {
      for (const k of clients) { k.input.data.mx = 0; k.input.send(); }
      await new Promise((res) => setTimeout(res, 33));
    }
    assert.strictEqual(r.state.round.phase, RoundPhase.Live);
    // between Garbage Days the truck waits off the map, and nothing moves it (the traffic step, the map's edge)
    const parked = r.carsById.get(r.state.garbage.truck)!;
    assert.ok(parked.z < -800, `parked off the map (z ${parked.z.toFixed(1)})`);
    clients[0].c.send("dbg_garbage");
    await new Promise((res) => setTimeout(res, 300));
    const g = r.state.garbage;
    assert.strictEqual(g.phase, GarbagePhase.Coming);
    const truck = r.carsById.get(g.truck)!;
    assert.strictEqual(truck.driver, "npc");
    assert.ok(truck.siren, "beacons on");
    assert.ok(Math.max(Math.abs(truck.x), Math.abs(truck.z)) > 140, "coming in from the edge of town");
    // a new round: home, no dumpster
    r.br.startCountdown();
    assert.strictEqual(g.phase, GarbagePhase.None);
    assert.ok(truck.z < -800 && (truck.driver as string) === "" && !truck.siren, "parked off the map");
  });
});
