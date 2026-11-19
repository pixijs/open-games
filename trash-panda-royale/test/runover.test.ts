import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.ts";
import { CAR_TYPES, Mode, NPC_HIT_R, NpcState, RUN_OVER_LOSS, TICK_RATE } from "../src/shared/constants.ts";
import { PlayerInput, type Npc, type Player } from "../src/shared/schema.ts";
import {
  EV_CRASH, stepNpcReckon, stepPlayer, type InputLike, type PlayerSim, type RunOver, type SeenNpc, type SimCtx, type WorldView,
} from "../src/shared/sim.ts";
import type { GameRoom } from "../src/server/GameRoom.ts";
import { Pedestrians } from "../src/server/Pedestrians.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STEP_MS = 1000 / TICK_RATE;
const HATCH = CAR_TYPES[0];

describe("run over: shared step", () => {
  // the open ground outside the town's north-east corner (see driving.test.ts): nothing to hit
  let peds: SeenNpc[] = [];
  const flying = new Set<string>();
  const world: WorldView = {
    cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [],
    npcs: (x, z, r) => peds.filter((n) => !flying.has(n.key) && (n.x - x) ** 2 + (n.z - z) ** 2 <= r * r),
    manhole: () => null, snatch: () => null,
  };
  const coast: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 0 };
  /** A hatchback heading east (+x) at `speed`, its middle at (x, 124). */
  const car = (x: number, speed: number): PlayerSim => ({
    x, y: 0, z: 124, vx: speed, vy: 0, vz: 0, yaw: Math.PI / 2, mode: Mode.Driving, veh: 1, lx: 0, ly: 0, lz: 0, lyaw: 0,
    steer: 0, yawRate: 0, grounded: true, weapon: 0, ammo1: 0, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
  });
  let time = 0;
  /** One step; whoever it runs over is flying from then on (as on the server). */
  const step = (s: PlayerSim, memo: SimCtx["memo"] = (_k, f) => f()) => {
    const ctx: SimCtx = { dt: 1 / TICK_RATE, time: (time += 33), memo };
    const ev = stepPlayer(ctx, s, coast, world);
    assert.ok(!(ev & EV_CRASH), "no crash");
    for (const h of ctx.runOver ?? []) flying.add(h.key);
    return ctx.runOver ?? [];
  };
  beforeEach(() => { peds = []; flying.clear(); });

  for (const [lateral, speed] of [[0, 8], [0, 15], [0, 25], [0.9, 15], [0.9, 25], [1.3, 25]] as const) {
    it(`hit ${lateral} m off the middle at ${speed} m/s: they fly the step the bumper reaches them, ahead of the car`, () => {
      peds = [{ key: "7", x: 120, y: 0, z: 124 + lateral }];
      // (a twin with nobody in the way: what the step costs the car anyway)
      const s = car(120 - HATCH.halfL - 3, speed), twin = { ...s };
      let hit: RunOver | null = null, front = 0, before = 0, coasted = 0;
      for (let n = 0; n < 60 && !hit; n++) {
        before = s.vx;
        [hit] = step(s);
        front = s.x + HATCH.halfL;
        const v = twin.vx;
        stepPlayer({ dt: 1 / TICK_RATE, time, memo: (_k, f) => f() }, twin, coast, { ...world, npcs: () => [] });
        coasted = v - twin.vx;
      }
      assert.ok(hit, "ran over");
      // the step that hit them is the first whose bumper (in front, or the corner) reaches their circle
      const reach = front + NPC_HIT_R;
      assert.ok(reach >= 120 && reach - 120 <= speed / TICK_RATE + 0.05, `bumper at ${front.toFixed(2)} (them at 120)`);
      assert.ok(hit!.vx > s.vx + 3, `flying on ahead of the car (${hit!.vx.toFixed(1)} vs ${s.vx.toFixed(1)} m/s)`);
      assert.ok(hit!.vy > 6);
      assert.deepStrictEqual([hit!.x, hit!.y, hit!.z], [120, 0, 124 + lateral], "from where the driver saw them");
      const drop = before - s.vx - coasted;
      assert.ok(drop > 0.2 && drop <= RUN_OVER_LOSS + 0.02, `the car lost ${drop.toFixed(2)} m/s to them`);
      // and never again
      for (let n = 0; n < 20; n++) assert.deepStrictEqual(step(s), []);
    });
  }

  it("going slowly it just nudges past (no hit), nor does someone alongside get hit", () => {
    peds = [{ key: "1", x: 120, y: 0, z: 124 }];
    const s = car(115, 3);
    for (let n = 0; n < 60; n++) assert.deepStrictEqual(step(s), []);
    // alongside: just clear of the car's flank as it goes by fast
    peds = [{ key: "2", x: 112, y: 0, z: 124 + HATCH.halfW + NPC_HIT_R + 0.05 }];
    const t = car(100, 20);
    for (let n = 0; n < 30; n++) assert.deepStrictEqual(step(t), []);
  });

  it("someone up on a roof isn't hit by a car going by below", () => {
    peds = [{ key: "3", x: 120, y: 4, z: 124 }];
    const s = car(110, 15);
    for (let n = 0; n < 40; n++) assert.deepStrictEqual(step(s), []);
  });

  it("two in one step go flying in the order of their keys, on the server and on any client alike", () => {
    const a = car(110, 20), b = car(110, 20);
    peds = [{ key: "12", x: 120, y: 0, z: 124.3 }, { key: "4", x: 120, y: 0, z: 123.7 }];
    let hits: RunOver[] = [];
    for (let n = 0; n < 40 && !hits.length; n++) hits = step(a);
    flying.clear();
    peds.reverse();
    let again: RunOver[] = [];
    for (let n = 0; n < 40 && !again.length; n++) again = step(b);
    assert.deepStrictEqual(hits.map((h) => h.key), ["12", "4"]);
    assert.deepStrictEqual(again, hits);
    assert.deepStrictEqual([b.x, b.vx, b.vz, b.yawRate], [a.x, a.vx, a.vz, a.yawRate]);
  });

  it("a replay runs them over again from the memo, even though they're flying by then", () => {
    peds = [{ key: "5", x: 120, y: 0, z: 124.6 }];
    const memos: Map<string, unknown>[] = [];
    const live = car(108, 14);
    const start = { ...live };
    const path: string[] = [];
    for (let n = 0; n < 30; n++) {
      const m = new Map<string, unknown>();
      memos.push(m);
      step(live, (k, f) => { const v = f(); if (v !== undefined) m.set(k, v); return v; });
      path.push(`${live.x},${live.z},${live.vx},${live.vz},${live.yaw},${live.yawRate}`);
    }
    assert.ok(flying.has("5"), "ran over live");
    const replay = { ...start };
    for (let n = 0; n < 30; n++) {
      step(replay, (k) => memos[n].get(k) as any);
      assert.strictEqual(`${replay.x},${replay.z},${replay.vx},${replay.vz},${replay.yaw},${replay.yawRate}`, path[n], `step ${n}`);
    }
  });
});

describe("run over: server", function () {
  this.timeout(30000);
  let colyseus: ColyseusTestServer;
  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => await colyseus.cleanup());

  type Input = { data: any; send(): void };
  async function drive(input: Input, n: number, stage: (d: any, i: number) => void = () => {}, until?: () => boolean) {
    for (let i = 0; i < n && !until?.(); i++) {
      const d = input.data;
      d.mx = 0; d.mz = 0; d.throttle = 0; d.steer = 0; d.fire = false; d.jump = false; d.sprint = false; d.use = false; d.nade = false;
      stage(d, i);
      input.send();
      await sleep(STEP_MS);
    }
  }
  async function join() {
    const room = (await colyseus.createRoom("town", { br: false })) as unknown as GameRoom;
    const client = await colyseus.connectTo(room as any, { name: "Ann" });
    await client.waitForInitialState?.();
    const input = client.input({ type: PlayerInput }) as unknown as Input;
    let k = 0;
    for (const c of room.carsById.values()) {
      const body = room.bodies.get(c.id)!;
      body.ai = null; c.driver = ""; c.vx = 0; c.vz = 0; c.y = 0;
      c.x = -150 + (k % 10) * 6; c.z = 150 - Math.floor(k / 10) * 7; c.yaw = 0;
      k++;
    }
    for (const npc of room.state.npcs.values()) { npc.state = NpcState.Hidden; npc.x = 1000; }
    // (and they stay hidden: no respawns for the length of the test)
    for (const b of (room.peds as any).brains.values()) b.until = Number.MAX_SAFE_INTEGER;
    return { room, client, input, p: room.state.players.get(client.sessionId)! as Player };
  }
  /** Someone lying KO in the road at (x, z), staying put till they're hit. */
  function victim(room: GameRoom, key: string, x: number, z: number): Npc {
    const npc = room.state.npcs.get(key)!;
    npc.state = NpcState.KO; npc.x = x; npc.y = 0; npc.z = z; npc.vx = npc.vy = npc.vz = 0;
    return npc;
  }

  it("a driver runs someone over: launched in the step that hit them, from where the driver saw them; the driver gets the splat", async () => {
    const { room, client, input, p } = await join();
    const splats: any[] = [];
    client.onMessage("splat", (m) => splats.push(m));
    const c = [...room.carsById.values()][0];
    c.x = 100; c.z = 124; c.yaw = Math.PI / 2;
    p.x = 100; p.z = 124 - 2.2; p.y = 0; p.vx = p.vy = p.vz = 0; p.mode = Mode.Foot; p.veh = -1; p.grounded = true;
    const npc = victim(room, "3", 125, 124.3);
    await sleep(300); // (the rewind history records them)
    await drive(input, 2, (d, n) => { d.use = n === 0; });
    assert.strictEqual(p.mode, Mode.Driving, "driving");
    let frontAtHit = NaN;
    room.clock.setInterval(() => { if (Number.isNaN(frontAtHit) && npc.state === NpcState.Flying) frontAtHit = p.x + HATCH.halfL; }, 1);
    await drive(input, 90, (d) => { d.throttle = 100; }, () => npc.state !== NpcState.KO);
    await sleep(150);
    assert.strictEqual(npc.state, NpcState.Flying, "flying");
    assert.ok(frontAtHit > 125 - NPC_HIT_R - 1.5 && frontAtHit < 125 + 1, `the bumper at ${frontAtHit.toFixed(2)} when they took off (them at 125)`);
    assert.ok(npc.vx > p.vx, `ahead of the car (${npc.vx.toFixed(1)} vs ${p.vx.toFixed(1)} m/s)`);
    assert.strictEqual(splats.length, 1);
    assert.deepStrictEqual([splats[0].n, splats[0].x, splats[0].z], ["3", 125, 124.3]);
    // with the launch, for everyone else to play from its start as they see this car get there
    assert.strictEqual(splats[0].c, c.id);
    assert.deepStrictEqual(splats[0].l.slice(0, 3), [125, 0.05, 124.3]);
    assert.ok(splats[0].l[3] > 15 && splats[0].l[4] > 6, `launch ${splats[0].l}`);
    assert.ok(splats[0].t <= room.now && splats[0].t > room.now - 1500, `launched at ${splats[0].t} (now ${room.now})`);
    assert.strictEqual(room.state.roster.get(client.sessionId)?.score, 10, "and the points");
  });

  it("a car nobody drives still runs someone over, at its bumper too", async () => {
    const { room } = await join();
    const c = [...room.carsById.values()][1];
    c.x = 100; c.z = 124; c.yaw = Math.PI / 2; c.vx = 14; c.vz = 0;
    const npc = victim(room, "4", 112, 124);
    let frontAtHit = NaN;
    room.clock.setInterval(() => { if (Number.isNaN(frontAtHit) && npc.state === NpcState.Flying) frontAtHit = c.x + HATCH.halfL; }, 1);
    await sleep(1500);
    assert.ok(npc.state === NpcState.Flying || npc.state === NpcState.KO, `state ${npc.state}`);
    assert.ok(frontAtHit > 112 - NPC_HIT_R - 1 && frontAtHit < 112 + 0.5, `the bumper at ${frontAtHit.toFixed(2)} when they took off (them at 112)`);
  });

  it("a flight launched `age` ago is where the driver's client, reckoning it from the hit, has it", () => {
    // (Pedestrians.launchFrom on the server vs the client's own flight: stepNpcReckon from the hit)
    // (on the open ground: walls are bounced off at whatever step they meet)
    const launch = { x: 104, y: 0, z: 124, vx: 21, vy: 10, vz: 1.5 };
    for (const age of [0, 33, 80, 150, 300]) {
      const npc = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, state: NpcState.Walk } as unknown as Npc;
      const room = { now: 0, rand: Math.random, br: { outside: () => false, zone: { x: 0, z: 0 } }, state: { npcs: new Map([["1", npc]]) } };
      const peds = new Pedestrians(room as any);
      peds.launchFrom(npc, launch, age);
      // (lifted off the ground, as on the server)
      const mine = { ...launch, y: Math.max(launch.y, 0.05) };
      for (let t = 0; t < age; t += 16) stepNpcReckon(mine, Math.min(16, age - t) / 1000);
      // (the server's 1/30 s steps against the client's 16 ms: the same path all the same)
      const d = Math.hypot(npc.x - mine.x, npc.y - mine.y, npc.z - mine.z);
      assert.ok(d < 1e-6, `${age} ms in: ${d.toFixed(3)} m apart`);
      assert.strictEqual(npc.state, NpcState.Flying);
      // and on from there, tick by tick
      for (let k = 0; k < 4; k++) {
        room.now += 1000 / 30;
        peds.step(1 / 30);
        for (let t = 0; t < 1000 / 30; t += 16) stepNpcReckon(mine, Math.min(16, 1000 / 30 - t) / 1000);
      }
      assert.ok(Math.hypot(npc.x - mine.x, npc.y - mine.y, npc.z - mine.z) < 1e-5, `${age} ms in, 4 ticks on`);
    }
  });

  it("one launched a little after the server's tick (next to no latency) sets off next tick, from that instant", () => {
    const launch = { x: 104, y: 0, z: 124, vx: 21, vy: 10, vz: 1.5 };
    const npc = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, state: NpcState.Walk } as unknown as Npc;
    const room = { now: 0, rand: Math.random, br: { outside: () => false, zone: { x: 0, z: 0 } }, state: { npcs: new Map([["1", npc]]) } };
    const peds = new Pedestrians(room as any);
    peds.launchFrom(npc, launch, -6);
    peds.step(1 / 30);
    assert.deepStrictEqual([npc.x, npc.y, npc.z], [104, 0.05, 124], "not off yet this tick");
    room.now += 1000 / 30;
    peds.step(1 / 30);
    const mine = { ...launch, y: 0.05 };
    stepNpcReckon(mine, (1000 / 30 - 6) / 1000);
    assert.ok(Math.hypot(npc.x - mine.x, npc.y - mine.y, npc.z - mine.z) < 1e-5, `${npc.x} vs ${mine.x}`);
  });
});
