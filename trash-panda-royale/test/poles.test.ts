import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.ts";
import { Mode, NpcState, POLE_KNOCK_LOSS, POLE_R, TICK_RATE } from "../src/shared/constants.ts";
import { CITY, collideCircle, polesNear } from "../src/shared/map.ts";
import { PlayerInput, type Player } from "../src/shared/schema.ts";
import {
  EV_CRASH, poleFall, poleFallYaw, stepPlayer, wrapAngle, type InputLike, type PlayerSim, type PoleKnock, type SimCtx, type WorldView,
} from "../src/shared/sim.ts";
import type { GameRoom } from "../src/server/GameRoom.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STEP_MS = 1000 / TICK_RATE;

/**
 * A lamp post on the north kerb of the road z = -22 with nothing else within reach of it, and
 * its index: a car on the asphalt below it, heading north (+z), drives straight into it.
 */
function lonePost(): number {
  const i = CITY.poles.findIndex((q) => q.z > -17.5 && q.z < -15.5 && Math.abs(q.x) < 60
    && CITY.boxes.every((b) => b.pole !== undefined || b.maxX < q.x - 2.5 || b.minX > q.x + 2.5 || b.maxZ < -24 || b.minZ > q.z + 3));
  assert.ok(i >= 0, "a lone lamp post on the road z = -22");
  return i;
}

describe("lamp posts: shared step", () => {
  const down = new Set<number>();
  const world: WorldView = {
    cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1,
    poles: (x, z, r) => polesNear(x, z, r).filter((i) => !down.has(i)), npcs: () => [], manhole: () => null, snatch: () => null,
  };
  const coast: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 0 };
  const car = (x: number, z: number, speed: number): PlayerSim => ({
    x, y: 0, z, vx: 0, vy: 0, vz: speed, yaw: 0, mode: Mode.Driving, veh: 1, lx: 0, ly: 0, lz: 0, lyaw: 0,
    steer: 0, yawRate: 0, grounded: true, weapon: 0, ammo1: 0, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
  });
  let time = 0;
  /** One step; the posts it knocks over are down from then on (as on the server). */
  const step = (s: PlayerSim, cmd = coast, memo: SimCtx["memo"] = (_k, f) => f()) => {
    const ctx: SimCtx = { dt: 1 / TICK_RATE, time: (time += 33), memo };
    const ev = stepPlayer(ctx, s, cmd, world);
    for (const k of ctx.knocked ?? []) down.add(k.i);
    return { ev, knocked: ctx.knocked ?? [] };
  };
  beforeEach(() => down.clear());

  it("every lamp post is one: cars go by its box (the step handles them), walkers bump into it", () => {
    assert.ok(CITY.poles.length > 100, `${CITY.poles.length} posts`);
    assert.strictEqual(CITY.poles.length, CITY.props.filter((p) => p.model === "lamp").length);
    for (const [i, q] of CITY.poles.entries()) assert.strictEqual(CITY.props[q.prop].model, "lamp", `post ${i}`);
    const q = CITY.poles[lonePost()];
    assert.ok(!collideCircle({ x: q.x, z: q.z - 1 }, 0, 1, true), "a car's circle goes by its box");
    assert.ok(collideCircle({ x: q.x, z: q.z - 0.4 }, 0, 0.35, false), "a walker bumps into it");
  });

  it("closing fast, a car knocks it over and drives on a little slower; it falls the car's way", () => {
    const i = lonePost(), q = CITY.poles[i];
    const s = car(q.x, -22, 12);
    const knocks: PoleKnock[] = [];
    let before = 0, after = 0;
    for (let n = 0; n < 30; n++) {
      const v = s.vz;
      const { ev, knocked } = step(s);
      assert.ok(!(ev & EV_CRASH), "no crash");
      if (knocked.length) { before = v; after = s.vz; }
      knocks.push(...knocked);
    }
    assert.deepStrictEqual(knocks.map((k) => k.i), [i]);
    const drop = before - after;
    assert.ok(drop > POLE_KNOCK_LOSS - 0.1 && drop < POLE_KNOCK_LOSS + 0.3, `lost ${drop.toFixed(2)} m/s`);
    assert.ok(Math.abs(wrapAngle(poleFallYaw(knocks[0].fall))) < 0.03, `falls toward yaw ${poleFallYaw(knocks[0].fall)}`);
    assert.ok(s.z > q.z + 2, `drove on past it (z ${s.z.toFixed(1)})`);
  });

  it("a gentle bump stops at it, pushing or not, and it stays up", () => {
    const i = lonePost(), q = CITY.poles[i];
    // the car's front circle (1.0 m round a point 0.9 m ahead of its middle) 0.3 m short of the post
    const s = car(q.x, q.z - POLE_R - 1.0 - 0.9 - 0.3, 3);
    for (let n = 0; n < 60; n++) assert.deepStrictEqual(step(s, { ...coast, throttle: n < 10 ? 0 : 30 }).knocked, []);
    assert.ok(s.z + 0.9 + 1.0 < q.z - POLE_R + 0.05, `held at it (front at ${(s.z + 1.9).toFixed(2)}, post at ${(q.z - POLE_R).toFixed(2)})`);
    assert.ok(!down.has(i));
  });

  it("a replay knocks it over again from the memo, even though it's down by then", () => {
    const i = lonePost(), q = CITY.poles[i];
    // a client: memoised world reads per input, replayed after the post went down
    const memos: Map<string, unknown>[] = [];
    const live = car(q.x - 0.6, -22, 14);
    const start = { ...live };
    const path: string[] = [];
    for (let n = 0; n < 20; n++) {
      const m = new Map<string, unknown>();
      memos.push(m);
      step(live, coast, (k, f) => { const v = f(); if (v !== undefined) m.set(k, v); return v; });
      path.push(`${live.x},${live.z},${live.vx},${live.vz},${live.yaw}`);
    }
    assert.ok(down.has(i), "knocked over live");
    const replay = { ...start };
    for (let n = 0; n < 20; n++) {
      step(replay, coast, (k) => memos[n].get(k) as any);
      assert.strictEqual(`${replay.x},${replay.z},${replay.vx},${replay.vz},${replay.yaw}`, path[n], `step ${n}`);
    }
  });

  it("a glancing hit tips it away from the car's side", () => {
    // heading north, hit on the post's east side (the car passes to its east): it leans west of north
    const fall = wrapAngle(poleFallYaw(poleFall(0, 10, 1, 0)));
    assert.ok(Math.abs(fall + Math.PI / 4) < 0.03, `fall ${fall}`);
    // dead on: straight ahead
    assert.ok(Math.abs(wrapAngle(poleFallYaw(poleFall(10, 0, -1, 0)) - Math.PI / 2)) < 0.03);
  });
});

describe("lamp posts: server", function () {
  this.timeout(30000);
  let colyseus: ColyseusTestServer;
  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => await colyseus.cleanup());

  type Input = { data: any; send(): void };
  async function drive(input: Input, n: number, stage: (d: any, i: number) => void = () => {}) {
    for (let i = 0; i < n; i++) {
      const d = input.data;
      d.mx = 0; d.mz = 0; d.throttle = 0; d.steer = 0; d.fire = false; d.jump = false; d.sprint = false; d.use = false; d.nade = false;
      stage(d, i);
      input.send();
      await sleep(STEP_MS);
    }
    await sleep(150);
  }
  async function join() {
    const room = (await colyseus.createRoom("town", { br: false })) as unknown as GameRoom;
    const client = await colyseus.connectTo(room as any, { name: "Ann" });
    await client.waitForInitialState?.();
    const input = client.input({ type: PlayerInput }) as unknown as Input;
    // every AI car and walker out of the way
    let k = 0;
    for (const c of room.carsById.values()) {
      const body = room.bodies.get(c.id)!;
      body.ai = null; c.driver = ""; c.vx = 0; c.vz = 0; c.y = 0;
      c.x = -150 + (k % 10) * 6; c.z = 150 - Math.floor(k / 10) * 7; c.yaw = 0;
      k++;
    }
    for (const npc of room.state.npcs.values()) { npc.state = NpcState.Hidden; npc.x = 1000; }
    return { room, client, input, p: room.state.players.get(client.sessionId)! as Player };
  }

  it("a driver's car knocks one over: everyone gets which way it fell; a new round stands it up", async () => {
    const { room, input, p } = await join();
    const i = lonePost(), q = CITY.poles[i];
    const c = [...room.carsById.values()][0];
    c.x = q.x; c.z = -24; c.yaw = 0;
    p.x = q.x - 2.2; p.z = -24; p.y = 0; p.vx = p.vy = p.vz = 0; p.mode = Mode.Foot; p.veh = -1; p.grounded = true;
    await sleep(300); // (the rewind history records the parked car)
    await drive(input, 2, (d, n) => { d.use = n === 0; });
    assert.strictEqual(p.mode, Mode.Driving, "driving");
    await drive(input, 40, (d) => { d.throttle = 100; });
    const fall = room.state.poles.get(String(i));
    assert.ok(fall !== undefined, `down (car at z ${p.z.toFixed(1)}, post at ${q.z})`);
    assert.ok(Math.abs(wrapAngle(poleFallYaw(fall!))) < 0.2, `fell toward ${poleFallYaw(fall!)}`);
    assert.strictEqual(room.state.poles.size, 1, "only that one");
    assert.ok(p.z > q.z, "drove on past it");
    room.resetWorld();
    assert.strictEqual(room.state.poles.size, 0, "stands again");
  });

  it("so does a car nobody drives, rolling into one", async () => {
    const { room } = await join();
    const i = lonePost(), q = CITY.poles[i];
    const c = [...room.carsById.values()][1];
    c.x = q.x; c.z = -22; c.yaw = 0; c.vx = 0; c.vz = 11;
    await sleep(800);
    assert.ok(room.state.poles.has(String(i)), "down");
  });
});
