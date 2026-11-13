import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.ts";
import {
  Mode, PICKUP_ZOOMIES, RUN_SPEED, TICK_RATE, WALK_SPEED, Weapon, ZOOMIES_MS, ZOOMIES_RESPAWN_MS, ZOOMIES_SPEED, ticks,
} from "../src/shared/constants.ts";
import { CITY } from "../src/shared/map.ts";
import { PlayerInput, type Player } from "../src/shared/schema.ts";
import { stepPlayer, type InputLike, type PlayerSim, type SimCtx, type WorldView } from "../src/shared/sim.ts";
import type { GameRoom } from "../src/server/GameRoom.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STEP_MS = 1000 / TICK_RATE;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

describe("the zoomies (a coffee): shared step", () => {
  const world: WorldView = { cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null };
  const cup: WorldView = { ...world, pickup: () => ({ id: "40", kind: PICKUP_ZOOMIES }) };
  // running east (+x) with a pop-gun, the mouse pointing west (yaw π)
  const run: InputLike = { mx: 100, mz: 0, throttle: 0, steer: 0, aim: Math.PI, fire: false, jump: false, sprint: false, use: false, weapon: Weapon.Pistol };
  const fresh = (): PlayerSim => ({
    x: 0, y: 0, z: -22, vx: 0, vy: 0, vz: 0, yaw: 0, mode: Mode.Foot, veh: -1, lx: 0, ly: 0, lz: 0, lyaw: 0, steer: 0, yawRate: 0,
    grounded: true, weapon: Weapon.Pistol, ammo1: 10, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
  });
  let time = 0;
  const step = (s: PlayerSim, cmd: InputLike, w = world) => {
    const ctx: SimCtx = { dt: 1 / TICK_RATE, time: (time += 33), memo: (_k, f) => f() };
    stepPlayer(ctx, s, cmd, w);
    return ctx;
  };

  it("a coffee starts them: faster than a sprint, facing the run (not the mouse) until a shot, then they wear off", () => {
    const s = fresh();
    const ctx = step(s, run, cup);
    assert.strictEqual(ctx.picked, "40");
    assert.strictEqual(s.zoomies, ticks(ZOOMIES_MS / 1000));
    assert.deepStrictEqual([s.weapon, s.ammo1], [Weapon.Pistol, 10], "the gun and ammo stay");
    for (let i = 0; i < 45; i++) step(s, run);
    assert.ok(Math.abs(s.vx - ZOOMIES_SPEED) < 0.01 && ZOOMIES_SPEED > RUN_SPEED, `speed ${s.vx}`);
    assert.ok(Math.abs(wrap(s.yaw - Math.PI / 2)) < 1e-3, `faces the run, yaw ${s.yaw}`);
    // shooting turns you to the mouse, fast
    for (let i = 0; i < 6; i++) step(s, { ...run, fire: true });
    assert.ok(Math.abs(wrap(s.yaw - Math.PI)) < 1e-3, `turned to shoot, yaw ${s.yaw}`);
    // and they wear off (waited out standing still: running all that way ends in a wall), back to a run, facing the mouse (holding a gun)
    for (let i = 0; i < ticks(ZOOMIES_MS / 1000); i++) step(s, { ...run, mx: 0 });
    assert.strictEqual(s.zoomies, 0);
    for (let i = 0; i < 15; i++) step(s, run);
    assert.ok(Math.abs(s.vx - WALK_SPEED) < 0.01, `speed ${s.vx}`);
    assert.ok(Math.abs(wrap(s.yaw - Math.PI)) < 1e-3, `faces the mouse again, yaw ${s.yaw}`);
  });

  it("Shift doesn't add to them, and they end with you", () => {
    const s = fresh();
    step(s, run, cup);
    for (let i = 0; i < 45; i++) step(s, { ...run, sprint: true });
    assert.ok(Math.abs(s.vx - ZOOMIES_SPEED) < 0.01, `speed ${s.vx}`);
    s.mode = Mode.Dead;
    step(s, run);
    assert.strictEqual(s.zoomies, 0);
  });

  it("six cups on the map, spread out, each clear of the other loot and the trash cans", () => {
    const cups = CITY.pickups.filter((p) => p.kind === PICKUP_ZOOMIES);
    assert.strictEqual(cups.length, 6);
    for (const c of cups) {
      for (const p of CITY.pickups) if (p !== c) assert.ok(Math.hypot(p.x - c.x, p.z - c.z) >= 4, `cup at (${c.x}, ${c.z}) next to loot`);
      for (const b of CITY.bins) assert.ok(Math.hypot(b.x - c.x, b.z - c.z) >= 2.5, `cup at (${c.x}, ${c.z}) next to a trash can`);
    }
    // the first cup is the one nearest the middle; every other cup is a block or more from the rest
    for (const c of cups) {
      const nearest = Math.min(...cups.filter((o) => o !== c).map((o) => Math.hypot(o.x - c.x, o.z - c.z)));
      assert.ok(nearest > 40, `cup at (${c.x}, ${c.z}) only ${nearest.toFixed(1)} m from another`);
    }
  });
});

describe("the zoomies: server", function () {
  this.timeout(30000);
  let colyseus: ColyseusTestServer;
  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => await colyseus.cleanup());

  type Input = { data: any; send(): void };
  async function drive(input: Input, n: number, stage: (d: any) => void = () => {}) {
    for (let i = 0; i < n; i++) {
      const d = input.data;
      d.mx = 0; d.mz = 0; d.fire = false; d.jump = false; d.sprint = false; d.use = false; d.nade = false;
      stage(d);
      input.send();
      await sleep(STEP_MS);
    }
  }
  function place(p: Player, x: number, z: number, y: number) {
    p.x = x; p.z = z; p.y = y; p.vx = 0; p.vy = 0; p.vz = 0; p.mode = Mode.Foot; p.veh = -1; p.grounded = true;
  }

  it("drinking a cup gives you them; the cup comes back after its own wait; a new life starts without them", async () => {
    const r = (await colyseus.createRoom("town", { br: false })) as unknown as GameRoom;
    const client = await colyseus.connectTo(r as any, { name: "Ann" });
    await client.waitForInitialState?.();
    const input = client.input({ type: PlayerInput }) as unknown as Input;
    const p = r.state.players.get(client.sessionId)!;
    const [key, pk] = [...r.state.pickups.entries()].find(([, q]) => q.kind === PICKUP_ZOOMIES)!;
    place(p, pk.x, pk.z, pk.y);
    await drive(input, 6);
    assert.strictEqual(r.state.pickups.get(key)!.active, false, "drunk");
    assert.ok(p.zoomies > ticks(ZOOMIES_MS / 1000) - 12, `zoomies ${p.zoomies}`);
    const back = (r as any).pickupRespawn.get(key) - (r as any).now;
    assert.ok(Math.abs(back - ZOOMIES_RESPAWN_MS) < 500, `back in ${back} ms`);
    await drive(input, 25, (d) => { d.mx = 100; });
    assert.ok(Math.hypot(p.vx, p.vz) > RUN_SPEED + 1, `running at ${Math.hypot(p.vx, p.vz).toFixed(2)} m/s`);
    r.spawnPlayer(p);
    assert.strictEqual(p.zoomies, 0);
  });
});
