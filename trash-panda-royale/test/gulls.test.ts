import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.ts";
import {
  GULL_CEIL, GULL_CLEAR, GULL_CLIMB, GULL_HATCH_MS, GULL_POOP_S, GULL_SPEED, Mode, PICKUP_FOOD, PlayerStatus, POOP_IMMUNE_MS, RoundPhase, TICK_RATE, Weapon, WEAPONS, ticks,
} from "../src/shared/constants.ts";
import { CITY, groundHeight, segmentClear } from "../src/shared/map.ts";
import { PlayerInput, type Player } from "../src/shared/schema.ts";
import { dropLanding, EV_DROP, EV_POOP, EV_SNATCH, stepPlayer, type InputLike, type PlayerSim, type SimCtx, type WorldView } from "../src/shared/sim.ts";
import type { GameRoom } from "../src/server/GameRoom.ts";

const DT = 1 / TICK_RATE;
const STEP_MS = 1000 / TICK_RATE;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idle = (): InputLike => ({ mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 0 });
const gull = (x: number, y: number, z: number): PlayerSim => ({
  x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0, mode: Mode.Gull, veh: -1, lx: 0, ly: 0, lz: 0, lyaw: 0, steer: 0, yawRate: 0,
  grounded: false, weapon: 0, ammo1: 0, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
});
const noWorld = (snatch: WorldView["snatch"] = () => null): WorldView => ({
  cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch,
});
function step(p: PlayerSim, cmd: InputLike, w = noWorld()) {
  const ctx: SimCtx = { dt: DT, time: 0, memo: (_k, f) => f() };
  return { ev: stepPlayer(ctx, p, cmd, w), ctx };
}
/** The open ground outside the town's north-east corner (no buildings: see driving.test.ts). */
const OPEN = { x: 150, z: 150 };

describe("seagulls: the shared step", () => {
  it("flies along the stick at its speed, climbs with Space, dives with Shift, holds its height otherwise", () => {
    const p = gull(OPEN.x, 10, OPEN.z - 60);
    for (let k = 0; k < 3 * TICK_RATE; k++) step(p, { ...idle(), mz: 100 });
    assert.ok(Math.abs(p.vz - GULL_SPEED) < 0.3, `cruising at ${p.vz.toFixed(2)} m/s`);
    assert.ok(Math.abs(p.y - 10) < 0.01, `held its height: ${p.y}`);
    assert.ok(Math.abs(p.yaw) < 0.05, "faces where it flies");
    const y0 = p.y;
    for (let k = 0; k < TICK_RATE; k++) step(p, { ...idle(), jump: true });
    assert.ok(p.y - y0 > GULL_CLIMB * 0.6, `climbed ${(p.y - y0).toFixed(2)} m in a second`);
    const y1 = p.y;
    for (let k = 0; k < 15; k++) step(p, { ...idle(), sprint: true });
    assert.ok(p.y < y1 - 2, "dove");
  });

  it("never lower than GULL_CLEAR over what's under it, flutters up and over a wall in its way, never past the ceiling", () => {
    // diving into the street: it pulls up GULL_CLEAR over it
    const p = gull(OPEN.x, 3, OPEN.z);
    for (let k = 0; k < 2 * TICK_RATE; k++) step(p, { ...idle(), sprint: true });
    assert.ok(Math.abs(p.y - (groundHeight(p.x, p.z, 1) + GULL_CLEAR)) < 0.05, `skims the street at ${p.y.toFixed(2)}`);
    // the tallest building in town, flown straight at, low: it climbs it and comes out over its roof
    const b = CITY.buildings.filter((q) => q.box && q.roof).sort((u, v) => v.roof! - u.roof!)[0];
    const bx = (b.box!.minX + b.box!.maxX) / 2, bz = (b.box!.minZ + b.box!.maxZ) / 2;
    const q = gull(bx, 2, b.box!.minZ - 6);
    let maxY = 0;
    for (let k = 0; k < 8 * TICK_RATE; k++) { step(q, { ...idle(), mz: 100 }); maxY = Math.max(maxY, q.y); }
    assert.ok(q.z > bz, `got past the building (z ${q.z.toFixed(1)})`);
    assert.ok(maxY > b.roof!, `flew over its ${b.roof} m roof`);
    // the sky has a lid
    const r = gull(OPEN.x, GULL_CEIL - 1, OPEN.z);
    for (let k = 0; k < 2 * TICK_RATE; k++) step(r, { ...idle(), jump: true });
    assert.ok(r.y <= GULL_CEIL + 1e-6);
  });

  it("a dropping every GULL_POOP_S, from under its tail, landing on the street below", () => {
    const p = gull(OPEN.x, 12, OPEN.z);
    const drops: number[] = [];
    let launch = null as null | NonNullable<SimCtx["poop"]>;
    for (let k = 0; k < 5 * TICK_RATE; k++) {
      const { ev, ctx } = step(p, { ...idle(), fire: true });
      if (ev & EV_POOP) { drops.push(k); launch ??= ctx.poop!; }
    }
    assert.ok(drops.length >= 2, `${drops.length} droppings`);
    for (let i = 1; i < drops.length; i++) assert.strictEqual(drops[i] - drops[i - 1], ticks(GULL_POOP_S));
    const land = dropLanding(launch!);
    assert.ok(Math.hypot(land.x - OPEN.x, land.z - OPEN.z) < 0.5 && Math.abs(land.y - groundHeight(land.x, land.z, 1)) < 0.01, "straight down onto the street");
    assert.ok(land.t > 0.6 && land.t < 1.4, `falls for ${land.t.toFixed(2)} s`);
  });

  it("E snatches the loot under its feet and lets go of it; shooed, it tumbles a moment, then flies again", () => {
    const p = gull(OPEN.x, 2, OPEN.z);
    const w = noWorld((x, y, z) => (Math.hypot(x - OPEN.x, z - OPEN.z) < 1.6 && y < 3 ? { id: "7", kind: PICKUP_FOOD } : null));
    let r = step(p, { ...idle(), use: true }, w);
    assert.ok(r.ev & EV_SNATCH);
    assert.strictEqual(r.ctx.snatched, "7");
    assert.strictEqual(p.veh, PICKUP_FOOD, "carries it");
    r = step(p, idle(), w);
    r = step(p, { ...idle(), use: true }, w);
    assert.ok(r.ev & EV_DROP);
    assert.strictEqual(r.ctx.dropped!.kind, PICKUP_FOOD);
    assert.strictEqual(p.veh, -1);
    // shooed (the server's doing): no control while it tumbles
    p.timer = ticks(1.2); p.y = 15;
    const x0 = p.x;
    for (let k = 0; k < 10; k++) step(p, { ...idle(), mx: 100, fire: true });
    assert.ok(Math.abs(p.x - x0) < 1, "the stick does nothing while it tumbles");
    for (let k = 0; k < 2 * TICK_RATE; k++) step(p, { ...idle(), mx: 100 });
    assert.ok(p.x - x0 > 5, "flies again");
  });
});

// ----------------------------------------------------------------------------- in a round
type Input = { data: any; send(): void };
async function drive(input: Input, n: number, stage: (d: any, i: number) => void = () => {}) {
  for (let i = 0; i < n; i++) {
    const d = input.data;
    d.mx = 0; d.mz = 0; d.throttle = 0; d.steer = 0; d.fire = false; d.jump = false; d.sprint = false; d.use = false; d.nade = false;
    stage(d, i);
    input.send();
    await sleep(STEP_MS);
  }
}
async function waitFor(cond: () => boolean, ms = 5000, what = "condition") {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe("seagulls in a round", function () {
  this.timeout(30000);
  let colyseus: ColyseusTestServer;
  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => await colyseus.cleanup());
  /** (the fumes barely move: nobody's gassed while we play) */
  const SLOW = { countdownMs: 300, victoryMs: 400, pace: 0.05 };

  async function three() {
    const r = (await colyseus.createRoom("town", { br: SLOW })) as unknown as GameRoom;
    const join = async (name: string) => {
      const client = await colyseus.connectTo(r as any, { name });
      await client.waitForInitialState?.();
      const input = client.input({ type: PlayerInput }) as unknown as Input;
      const sid = client.sessionId;
      const got: { type: string; m: any }[] = [];
      client.onMessage("*", (type: any, m: any) => got.push({ type: String(type), m }));
      return { client, input, sid, got, p: r.state.players.get(sid)! as Player, info: () => r.state.roster.get(sid)! };
    };
    const a = await join("Ann"), b = await join("Bob"), c = await join("Cat");
    const all = [a.input, b.input, c.input];
    await Promise.all([drive(a.input, 30), drive(b.input, 30), drive(c.input, 30), waitFor(() => r.state.round.phase === RoundPhase.Live, 3000, "live")]);
    return { r, a, b, c, all };
  }
  const idleAll = (inputs: Input[], ms: number) => Promise.all(inputs.map((i) => drive(i, Math.ceil(ms / STEP_MS))));

  it("knocked out, a raccoon hatches as a gull where it fell, and is sent its own surroundings; V watches instead, and back", async () => {
    const { r, a, b, c, all } = await three();
    b.p.x = 0; b.p.z = -22;
    r.combat.damagePlayer(b.p, b.sid, 500, a.sid, WEAPONS[Weapon.Pistol].name);
    await idleAll(all, 300);
    assert.strictEqual(b.info().status, PlayerStatus.Out);
    assert.strictEqual(b.p.mode, Mode.Dead);
    await Promise.all([idleAll(all, GULL_HATCH_MS + 400), waitFor(() => b.p.mode === Mode.Gull, GULL_HATCH_MS + 2000, "hatched")]);
    assert.ok(Math.hypot(b.p.x - 0, b.p.z + 22) < 6, `hatched near its tombstone (${b.p.x.toFixed(1)}, ${b.p.z.toFixed(1)})`);
    assert.ok(b.got.some((g) => g.type === "gull" && g.m.s === b.sid), "told it hatched");
    await idleAll(all, 300);
    assert.strictEqual(r.interest.watching(b.sid), b.sid, "sent its own surroundings");
    assert.strictEqual(r.state.round.alive, 2, "doesn't count for the round");
    // nothing hurts it
    r.combat.damagePlayer(b.p, b.sid, 500, a.sid, WEAPONS[Weapon.Pistol].name);
    assert.strictEqual(b.p.mode, Mode.Gull);
    // V: watch someone instead (its body off the map), and back to flying, from where it landed
    const at = { x: b.p.x, z: b.p.z }, cd = 17;
    b.p.cd = cd;
    b.client.send("gull", { on: false });
    await idleAll(all, 200);
    assert.strictEqual(b.p.mode, Mode.Dead);
    assert.notStrictEqual(r.interest.watching(b.sid), b.sid, "watching someone");
    // (too soon: V is heeded once every 1.5 s)
    b.client.send("gull", { on: true });
    await idleAll(all, 300);
    assert.strictEqual(b.p.mode, Mode.Dead, "too soon");
    await idleAll(all, 1300);
    b.client.send("gull", { on: true });
    await Promise.all([idleAll(all, 300), waitFor(() => b.p.mode === Mode.Gull, 2000, "flying again")]);
    assert.ok(Math.hypot(b.p.x - at.x, b.p.z - at.z) < 2, "takes off from where it landed (V is no teleport)");
    assert.ok(b.p.cd > 0 && b.p.cd <= cd, "its dropping no readier (V is no reload)");
    // the round's over: everyone's a raccoon again
    r.combat.damagePlayer(c.p, c.sid, 500, a.sid, WEAPONS[Weapon.Pistol].name);
    await Promise.all([idleAll(all, 1500), waitFor(() => r.state.round.phase === RoundPhase.Countdown && r.state.round.number === 2, 4000, "round 2")]);
    assert.strictEqual(b.p.mode, Mode.Foot);
  });

  it("a gull that only just hatched can't be blasted back into a raccoon (the shooter's rewind still has it a body)", async () => {
    const { r, a, b, all } = await three();
    const sp = CITY.spawns[0];
    a.p.x = sp.x; a.p.z = sp.z; a.p.y = 0; a.p.mode = Mode.Foot;
    b.p.x = sp.x + 2.5; b.p.z = sp.z; b.p.y = 0;
    await Promise.all([drive(a.input, 10), drive(b.input, 10)]);
    r.combat.damagePlayer(b.p, b.sid, 500, a.sid, WEAPONS[Weapon.Pistol].name);
    await Promise.all([idleAll(all, GULL_HATCH_MS + 2000), waitFor(() => b.p.mode === Mode.Gull, GULL_HATCH_MS + 2500, "hatched")]);
    // point-blank, the moment it hatched: Ann still sees the body there
    a.p.weapon = Weapon.Shotgun; a.p.ammo3 = 10;
    r.combat.fire(a.sid, a.p, Math.PI / 2, 0, false, 0, 1);
    assert.strictEqual(b.p.mode, Mode.Gull, "still a gull");
    // and nothing knocks a gull about
    r.combat.knock(b.p, 5, 5, 5, 30);
    assert.strictEqual(b.p.mode, Mode.Gull);
  });

  it("a dropping on a raccoon splats it (once in a while), and scores; a shot shoos the gull, and it lets go of its loot", async () => {
    const { r, a, b, all } = await three();
    r.combat.damagePlayer(b.p, b.sid, 500, a.sid, WEAPONS[Weapon.Pistol].name);
    await Promise.all([idleAll(all, GULL_HATCH_MS + 400), waitFor(() => b.p.mode === Mode.Gull, GULL_HATCH_MS + 2000, "hatched")]);
    // Ann stands on a sidewalk corner in town (clear of loot, in the circle); Bob's gull hovers right over her
    const ax = CITY.spawns[0].x, az = CITY.spawns[0].z;
    const hover = () => { b.p.x = ax; b.p.z = az; b.p.y = 7; b.p.vx = b.p.vy = b.p.vz = 0; };
    a.p.x = ax; a.p.z = az; a.p.y = 0; a.p.vx = a.p.vy = a.p.vz = 0; a.p.mode = Mode.Foot;
    hover();
    const score0 = b.info().score;
    await Promise.all([drive(a.input, 45), drive(b.input, 45, (d, i) => { hover(); d.fire = i === 1; })]);
    const hit = a.got.find((g) => g.type === "pooped");
    assert.ok(hit, "Ann was pooped on");
    assert.strictEqual(hit!.m.v, a.sid);
    assert.strictEqual(hit!.m.b, b.sid);
    assert.strictEqual(hit!.m.h, 1);
    assert.strictEqual(b.info().score, score0 + 10, "+10 for the gull");
    // another one right after (its droppings ready again at once): it slides off (no screen splat, no score)
    b.p.cd = 0;
    await Promise.all([drive(a.input, 45), drive(b.input, 45, (d, i) => { hover(); d.fire = i === 1; })]);
    const second = a.got.filter((g) => g.type === "pooped");
    assert.ok(second.length >= 2, "the second one landed too");
    assert.strictEqual(second[1].m.h, 0, `within ${POOP_IMMUNE_MS} ms: no screen splat`);
    assert.strictEqual(b.info().score, score0 + 10);
    // Ann shoots the gull: it's shooed (tumbling), and the loot it carried falls
    const key = r.loot.add(Weapon.Shotgun, { x: ax, y: 7, z: az }, { x: ax, y: 7, z: az }, r.now, b.sid);
    b.p.veh = Weapon.Shotgun;
    // (held there a moment: Ann's shot is judged against where she saw it, a little in the past)
    // (6 m off, wherever nothing stands in the way)
    const yaw = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => (k * Math.PI) / 4).find((y) => segmentClear(ax, 1, az, ax + Math.sin(y) * 6, 1.55, az + Math.cos(y) * 6))!;
    assert.ok(yaw !== undefined, "a clear line to shoot along");
    const perch = () => { b.p.x = ax + Math.sin(yaw) * 6; b.p.z = az + Math.cos(yaw) * 6; b.p.y = 1.5; b.p.vx = b.p.vy = b.p.vz = 0; };
    await Promise.all([drive(a.input, 24), drive(b.input, 24, perch)]);
    a.p.weapon = Weapon.Pistol; a.p.ammo1 = 10;
    r.combat.fire(a.sid, a.p, yaw, Math.atan2(1.5 + 0.1 - 1, 6), false, 0, 1);
    assert.ok(b.p.timer > 0, "shooed: tumbling");
    assert.strictEqual(b.p.veh, -1, "let go of the loot");
    const pk = r.state.pickups.get(key)!;
    assert.strictEqual(pk.carrier, "");
    await Promise.all([idleAll(all, 1200), waitFor(() => pk.active, 3000, "the loot to land")]);
    assert.ok(pk.y < 0.5, "on the street");
  });

  it("a gull snatches loot out of a can (it empties, and fills again later); let go, it lands loose, and anyone grabs it once", async () => {
    const { r, a, b, all } = await three();
    r.combat.damagePlayer(b.p, b.sid, 500, a.sid, WEAPONS[Weapon.Pistol].name);
    await Promise.all([idleAll(all, GULL_HATCH_MS + 400), waitFor(() => b.p.mode === Mode.Gull, GULL_HATCH_MS + 2000, "hatched")]);
    const [canKey, can] = [...r.state.pickups.entries()].find(([k, q]) => !q.loose && q.active && q.kind === Weapon.Smg && q.y < 0.5)!;
    b.p.x = can.x; b.p.z = can.z; b.p.y = can.y + 1.5; b.p.vx = b.p.vy = b.p.vz = 0;
    await drive(b.input, 4, (d, i) => { d.use = i === 1; });
    assert.strictEqual(can.active, false, "the can's empty");
    assert.strictEqual(b.p.veh, Weapon.Smg, "the gull has it");
    const [looseKey, loose] = [...r.state.pickups.entries()].find(([, q]) => q.loose && q.carrier === b.sid)!;
    assert.strictEqual(loose.kind, Weapon.Smg);
    // flies off and lets go of it over a sidewalk corner in town
    const sp = CITY.spawns[0];
    b.p.x = sp.x; b.p.z = sp.z; b.p.y = 6;
    await drive(b.input, 4, (d, i) => { b.p.x = sp.x; b.p.z = sp.z; b.p.vx = b.p.vz = 0; d.use = i === 1; });
    assert.strictEqual(loose.carrier, "");
    await Promise.all([idleAll(all, 1300), waitFor(() => loose.active, 3000, "landed")]);
    assert.ok(Math.hypot(loose.x - sp.x, loose.z - sp.z) < 1.5 && loose.y < 0.5, "landed under where it was let go of");
    // Ann walks onto it: SMG ammo, and it's gone for good
    a.p.x = loose.x - 3; a.p.z = loose.z; a.p.y = 0; a.p.mode = Mode.Foot; a.p.ammo2 = 0;
    await drive(a.input, 25, (d) => { d.mx = 100; d.weapon = a.p.weapon; });
    assert.strictEqual(a.p.ammo2, WEAPONS[Weapon.Smg].pickupAmmo, "Ann has the SMG's ammo");
    await idleAll(all, 1300);
    assert.ok(!r.state.pickups.has(looseKey), "gone for good");
    assert.ok(r.state.pickups.has(canKey) && !r.state.pickups.get(canKey)!.loose, "the can's still there (refilling)");
  });
});
