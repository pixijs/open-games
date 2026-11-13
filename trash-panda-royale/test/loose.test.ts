import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.ts";
import { BIN_REVEAL_MS, CAR_MAX_HP, CAR_TYPES, Mode, NpcState, TICK_RATE } from "../src/shared/constants.ts";
import { CITY, LOOSE_PROPS, collideCircle, onRamp, pointInBox, polesNear } from "../src/shared/map.ts";
import { PlayerInput, type Player } from "../src/shared/schema.ts";
import { EV_CRASH, stepPlayer, wrapAngle, type InputLike, type PlayerSim, type SimCtx, type WorldView } from "../src/shared/sim.ts";
import type { GameRoom } from "../src/server/GameRoom.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STEP_MS = 1000 / TICK_RATE;
const HATCH = CAR_TYPES[0];

/**
 * A heading for a straight run through (x, z): a hatchback's circles from 6 m before it to 6 m
 * past it meet nothing but street furniture (no walls, ramps or lamp posts). Null if none.
 */
function clearRun(x: number, z: number): number | null {
  for (let k = 0; k < 16; k++) {
    const yaw = (k / 16) * Math.PI * 2, fx = Math.sin(yaw), fz = Math.cos(yaw);
    let ok = true;
    for (let d = -8; d <= 8 && ok; d += 0.25) {
      const p = { x: x + fx * d, z: z + fz * d };
      if (collideCircle(p, 0, HATCH.halfW + 0.1, true) || onRamp(p.x, p.z) || polesNear(p.x, p.z, 1.6).length) ok = false;
    }
    if (ok) return yaw;
  }
  return null;
}

/** The first spot of `kind` ("hydrant", "bin"…) at street level with a clear run through it, and that run's heading. */
function runThrough(kind: string): { i: number; x: number; z: number; yaw: number } {
  for (const [i, s] of CITY.loose.entries()) {
    const is = s.bin !== undefined ? kind === "bin" && CITY.bins[s.bin].y === 0 : CITY.props[s.prop!].model === kind && !CITY.props[s.prop!].y;
    if (!is) continue;
    const yaw = clearRun(s.x, s.z);
    if (yaw !== null) return { i, x: s.x, z: s.z, yaw };
  }
  throw new Error(`no ${kind} with a clear run through it`);
}

describe("street furniture: shared step", () => {
  const world: WorldView = {
    cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [],
    npcs: () => [], manhole: () => null, snatch: () => null,
  };
  const coast: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 0 };
  const car = (x: number, z: number, yaw: number, speed: number): PlayerSim => ({
    x, y: 0, z, vx: Math.sin(yaw) * speed, vy: 0, vz: Math.cos(yaw) * speed, yaw, mode: Mode.Driving, veh: 1, lx: 0, ly: 0, lz: 0, lyaw: 0,
    steer: 0, yawRate: 0, grounded: true, weapon: 0, ammo1: 0, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
  });
  /** `n` steps of `s` coasting; whether any of them crashed. */
  const run = (s: PlayerSim, n: number) => {
    let crashed = false;
    for (let k = 0; k < n; k++) {
      const ctx: SimCtx = { dt: 1 / TICK_RATE, time: k * STEP_MS, memo: (_k, f) => f() };
      if (stepPlayer(ctx, s, coast, world) & EV_CRASH) crashed = true;
    }
    return crashed;
  };

  it("every hydrant, bench, trash bag, oil drum and trash can is street furniture: one box each, cars go by it, walkers bump into it", () => {
    const props = CITY.props.filter((p) => LOOSE_PROPS.has(p.model));
    const spots = CITY.loose.filter((s) => s.prop !== undefined);
    assert.strictEqual(spots.length, props.length, "every one of those props");
    assert.strictEqual(CITY.loose.filter((s) => s.bin !== undefined).length, CITY.bins.length, "and every trash can");
    for (const m of LOOSE_PROPS) assert.ok(props.some((p) => p.model === m), `some ${m}`);
    for (const [i, s] of CITY.loose.entries()) {
      const boxes = CITY.boxes.filter((b) => b.loose === i);
      assert.strictEqual(boxes.length, 1, `spot ${i}: one box`);
      assert.ok(pointInBox(boxes[0], s.x, s.z), `spot ${i}: in its box`);
    }
    for (const kind of ["hydrant", "bin"]) {
      const r = runThrough(kind);
      assert.ok(!collideCircle({ x: r.x, z: r.z }, 0, 0.5, true), `a car's circle goes by the ${kind}`);
      assert.ok(collideCircle({ x: r.x + 0.3, z: r.z }, 0, 0.35, false), `a walker bumps into the ${kind}`);
    }
  });

  // (trash bags always lie against a dumpster: no clear run through them)
  for (const kind of ["hydrant", "bin", "bench"]) {
    it(`a car drives straight through a ${kind === "bin" ? "trash can" : kind}: no crash, not a bit slower than with nothing there`, () => {
      const r = runThrough(kind);
      const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
      const s = car(r.x - fx * 5, r.z - fz * 5, r.yaw, 10);
      // the same run (heading east) on the open ground outside the town's north-east corner (see driving.test.ts): nothing to hit
      const open = car(104, 124, Math.PI / 2, 10);
      assert.strictEqual(run(s, 30), false, "no crash");
      run(open, 30);
      const went = (s.x - r.x) * fx + (s.z - r.z) * fz;
      assert.ok(went > HATCH.halfL + 0.5, `past it (${went.toFixed(2)} m)`);
      assert.ok(Math.abs(Math.hypot(s.vx, s.vz) - Math.hypot(open.vx, open.vz)) < 1e-4, `${Math.hypot(s.vx, s.vz)} m/s vs ${Math.hypot(open.vx, open.vz)}`);
      assert.ok(Math.abs(wrapAngle(s.yaw - r.yaw)) < 1e-6, "not turned");
    });
  }
});

describe("street furniture: server", function () {
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
  async function join(r: GameRoom, name: string) {
    const client = await colyseus.connectTo(r as any, { name });
    await client.waitForInitialState?.();
    const input = client.input({ type: PlayerInput }) as unknown as Input;
    return { client, input, sid: client.sessionId, p: r.state.players.get(client.sessionId)! as Player };
  }

  it("a car driven through a trash can someone hides in knocks its lid off and pops them out, and drives on", async () => {
    const r = (await colyseus.createRoom("town", { br: false })) as unknown as GameRoom;
    const a = await join(r, "Ann"), b = await join(r, "Bob");
    // nobody else around: cars parked far off, townsfolk gone
    let k = 0;
    for (const c of r.carsById.values()) {
      const body = r.bodies.get(c.id)!;
      body.ai = null; c.driver = ""; c.vx = 0; c.vz = 0; c.y = 0;
      c.x = -150 + (k % 10) * 6; c.z = 150 - Math.floor(k / 10) * 7; c.yaw = 0;
      k++;
    }
    for (const npc of r.state.npcs.values()) { npc.state = NpcState.Hidden; npc.x = 1000; }

    // Bob hides in the can
    const run = runThrough("bin"), bi = CITY.loose[run.i].bin!, can = CITY.bins[bi];
    b.p.x = can.x + 0.95; b.p.z = can.z; b.p.y = 0; b.p.vx = b.p.vy = b.p.vz = 0; b.p.mode = Mode.Foot; b.p.veh = -1; b.p.grounded = true;
    await Promise.all([drive(a.input, 3), drive(b.input, 3, (d, i) => { d.use = i === 1; })]);
    assert.strictEqual(b.p.mode, Mode.Hidden, "Bob's in the can");
    await Promise.all([drive(a.input, Math.ceil(BIN_REVEAL_MS / STEP_MS)), drive(b.input, Math.ceil(BIN_REVEAL_MS / STEP_MS))]);

    // Ann gets into a car out in the open, then (the same car) lines up 6 m short of the can
    const c = [...r.carsById.values()][0];
    c.x = 100; c.z = 124; c.yaw = Math.PI / 2;
    a.p.x = 100; a.p.z = 124 - 2.2; a.p.y = 0; a.p.vx = a.p.vy = a.p.vz = 0; a.p.mode = Mode.Foot; a.p.veh = -1; a.p.grounded = true;
    await sleep(300); // (the rewind history records the car there)
    await drive(a.input, 2, (d, n) => { d.use = n === 0; });
    assert.strictEqual(a.p.mode, Mode.Driving, "Ann's driving");
    const fx = Math.sin(run.yaw), fz = Math.cos(run.yaw);
    a.p.x = can.x - fx * 6; a.p.z = can.z - fz * 6; a.p.yaw = run.yaw; a.p.vx = fx * 16; a.p.vz = fz * 16; a.p.yawRate = 0;
    let feed = "";
    b.client.onMessage("feed", (m: { text: string }) => { feed = m.text; });
    await Promise.all([
      drive(a.input, 60, (d) => { d.throttle = 100; }, () => (a.p.x - can.x) * fx + (a.p.z - can.z) * fz > 5),
      drive(b.input, 30),
    ]);
    assert.ok((a.p.x - can.x) * fx + (a.p.z - can.z) * fz > 5, "Ann drove on through it");
    await Promise.all([drive(a.input, 20, (d) => { d.throttle = 100; }), drive(b.input, 20)]);
    assert.strictEqual(a.p.mode, Mode.Driving);
    assert.strictEqual(c.hp, CAR_MAX_HP, "no crash");
    assert.notStrictEqual(b.p.mode, Mode.Hidden, "Bob popped out");
    assert.strictEqual(b.p.hp, 100, "unhurt: the can took the hit, and he's flung off to its side");
    assert.strictEqual(r.state.bins.get(String(bi))!.lidOff, true, "lid off");
    await sleep(100);
    assert.match(feed, /Ann found Bob in a trash can/);
  });
});
