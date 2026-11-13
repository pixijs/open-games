import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./testServer.ts";
import { CAR_TYPES, GRENADE_CHARGE_STEPS, Mode, NpcState, PLAYER_RADIUS, TICK_RATE, Weapon, WEAPONS } from "../src/shared/constants.ts";
import { AIM_Q, pelletDamage } from "../src/shared/hitscan.ts";
import { PlayerInput, type Player } from "../src/shared/schema.ts";
import {
  grenadeLaunch, grenadePath, stepPlayer, wrapAngle, type InputLike, type PlayerSim, type SeenCar, type SimCtx, type WorldView,
} from "../src/shared/sim.ts";
import { trainCarPose, type CarPose } from "../src/shared/train.ts";
import type { GameRoom } from "../src/server/GameRoom.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STEP_MS = 1000 / TICK_RATE;

type Input = { data: any; send(): void };

/** Send `n` inputs at the tick rate, shaping each with `stage`. */
async function drive(input: Input, n: number, stage: (d: any, i: number) => void) {
  for (let i = 0; i < n; i++) {
    const d = input.data;
    d.mx = 0; d.mz = 0; d.throttle = 0; d.steer = 0; d.fire = false; d.jump = false; d.sprint = false; d.use = false; d.nade = false;
    stage(d, i);
    input.send();
    await sleep(STEP_MS);
  }
  await sleep(150);
}

function place(p: Player, x: number, z: number) {
  p.x = x; p.z = z; p.y = 0; p.vx = 0; p.vy = 0; p.vz = 0; p.mode = Mode.Foot; p.veh = -1; p.grounded = true;
}

describe("Tiny Town Mayhem server", function () {
  this.timeout(30000);
  let colyseus: ColyseusTestServer;

  before(async () => { colyseus = await testServer(); });
  beforeEach(async () => await colyseus.cleanup());

  async function join(name: string) {
    // a sandbox room: no battle-royale rounds (they would respawn and freeze the players)
    const room = (await colyseus.createRoom("town", { br: false })) as unknown as GameRoom;
    const client = await colyseus.connectTo(room as any, { name });
    await client.waitForInitialState?.();
    const input = client.input({ type: PlayerInput }) as unknown as Input;
    const p = room.state.players.get(client.sessionId)!;
    return { room, client, input, p };
  }

  async function joinExisting(room: GameRoom, name: string) {
    const client = await colyseus.connectTo(room as any, { name });
    const input = client.input({ type: PlayerInput }) as unknown as Input;
    return { client, input, p: room.state.players.get(client.sessionId)! };
  }

  /** An empty spot on the asphalt of the road z = -22. */
  const OPEN = { x: 0, z: -22 };

  function clearTraffic(room: GameRoom) {
    // park every AI car far away so tests aren't disturbed
    let i = 0;
    for (const car of room.carsById.values()) {
      const body = room.bodies.get(car.id)!;
      body.ai = null; car.driver = ""; car.vx = 0; car.vz = 0; car.y = 0;
      car.x = -150 + (i % 10) * 6; car.z = 150 - Math.floor(i / 10) * 7; car.yaw = 0;
      i++;
    }
    for (const npc of room.state.npcs.values()) { npc.state = NpcState.Hidden; npc.x = 1000; }
  }

  it("moves a player with fixed-step input", async () => {
    const { room, input, p } = await join("walker");
    clearTraffic(room);
    place(p, OPEN.x, OPEN.z);
    await drive(input, 20, (d) => { d.mx = 100; });
    assert.ok(p.x > OPEN.x + 2.5, `expected to walk east, x=${p.x}`);
    assert.strictEqual(p.mode, Mode.Foot);
  });

  it("steals a parked car and drives it", async () => {
    const { room, input, p } = await join("thief");
    clearTraffic(room);
    const car = [...room.carsById.values()][0];
    car.x = OPEN.x; car.z = OPEN.z; car.yaw = Math.PI / 2; // facing +X along the road
    place(p, OPEN.x, OPEN.z + 2.2);
    await sleep(300); // let the rewind history record the parked car
    await drive(input, 2, (d, i) => { d.use = i === 0; });
    assert.strictEqual(p.mode, Mode.Driving, "should be driving");
    assert.strictEqual(car.driver, [...room.state.players.keys()][0]);
    await drive(input, 40, (d) => { d.throttle = 100; });
    assert.ok(car.x > OPEN.x + 8, `car should have moved east, x=${car.x}`);
    assert.ok(Math.hypot(car.vx, car.vz) > 5, "car should be fast");
    // exit
    await drive(input, 2, (d, i) => { d.use = i === 0; });
    assert.strictEqual(p.mode, Mode.Foot);
    assert.strictEqual(car.driver, "");
  });

  it("rides on the roof of a car another player drives", async () => {
    const { room, input: inA, p: a } = await join("driver");
    clearTraffic(room);
    const { input: inB, p: b } = await joinExisting(room, "rider");
    const car = [...room.carsById.values()][1];
    car.x = OPEN.x; car.z = OPEN.z; car.yaw = Math.PI / 2;
    place(a, OPEN.x, OPEN.z + 2.2);
    // B, against its other flank, jumps into it (pushing into it): up onto the roof
    place(b, OPEN.x, OPEN.z - CAR_TYPES[car.kind].halfW - 0.37);
    await sleep(300);
    await Promise.all([
      drive(inA, 2, (d, i) => { d.use = i === 0; }),
      drive(inB, 15, (d, i) => { d.mz = b.mode === Mode.Foot ? 100 : 0; d.jump = i === 0; }),
    ]);
    assert.strictEqual(a.mode, Mode.Driving, "A drives");
    assert.strictEqual(b.mode, Mode.Roof, "B rides the roof");
    assert.strictEqual(b.veh, car.id);
    const bx0 = b.x;
    await Promise.all([
      drive(inA, 30, (d) => { d.throttle = 100; }),
      drive(inB, 30, () => {}),
    ]);
    assert.ok(b.x > bx0 + 4, `rider should travel with the car: ${bx0} -> ${b.x}`);
    assert.strictEqual(b.mode, Mode.Roof, "still on the roof");
    assert.ok(Math.abs(b.y - 1.45) < 0.3 || b.y > 1.4, `rider stands on the roof, y=${b.y}`);
  });

  it("climbs onto a moving train and rides it", async () => {
    const { room, input, p } = await join("hobo");
    clearTraffic(room);
    // stand next to the 2nd wagon of train 0 where it will be shortly
    const pose: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };
    trainCarPose(1, room.clock.elapsedTime + 150, pose);
    const sx = Math.cos(pose.yaw), sz = -Math.sin(pose.yaw);
    // (3 m toward its front: it moves on under us while we walk up and jump)
    const sp = Math.hypot(pose.vx, pose.vz) || 1;
    place(p, pose.x + sx * 2.1 + (pose.vx / sp) * 3, pose.z + sz * 2.1 + (pose.vz / sp) * 3);
    // walk up to its flank, then jump into it: up onto the roof
    await drive(input, 15, (d, i) => { d.mx = Math.round(-sx * 100); d.mz = Math.round(-sz * 100); d.jump = i === 4; });
    assert.strictEqual(p.mode, Mode.Train, `should be on the train (mode ${p.mode})`);
    const x0 = p.x, z0 = p.z;
    await drive(input, 30, () => {});
    assert.strictEqual(p.mode, Mode.Train, "still riding");
    const moved = Math.hypot(p.x - x0, p.z - z0);
    assert.ok(moved > 8, `rider moved with the train: ${moved.toFixed(1)} m`);
    assert.ok(Math.abs(p.y - 3) < 0.05, `on the roof, y=${p.y}`);
  });

  it("gets flattened by a train standing on the track", async () => {
    const { room, input, p } = await join("unlucky");
    clearTraffic(room);
    const pose: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };
    // stand on the rails 1.2 s ahead of the locomotive
    trainCarPose(0, room.clock.elapsedTime + 1200, pose);
    place(p, pose.x, pose.z);
    await drive(input, 50, () => {});
    assert.ok(p.mode === Mode.Knocked || p.mode === Mode.Foot || p.mode === Mode.Dead, `mode ${p.mode}`);
    assert.ok(p.hp < 100, `train should hurt: hp=${p.hp}`);
  });

  it("lag-compensated hitscan damages another player", async () => {
    const { room, input: inA, client: cA, p: a } = await join("shooter");
    clearTraffic(room);
    const { input: inB, p: b } = await joinExisting(room, "target");
    place(a, OPEN.x - 6, OPEN.z);
    place(b, OPEN.x + 6, OPEN.z);
    a.weapon = Weapon.Pistol; a.ammo1 = 20;
    await sleep(400);
    let hits = 0;
    cA.onMessage("hit", () => { hits++; });
    await Promise.all([
      drive(inA, 6, (d, i) => { d.aim = Math.PI / 2; d.weapon = Weapon.Pistol; d.fire = i === 1; }),
      drive(inB, 6, () => {}),
    ]);
    assert.ok(b.hp < 100, `target hp should drop, hp=${b.hp}`);
    assert.ok(hits >= 1, "shooter receives the hit confirmation");
    assert.strictEqual(a.ammo1, 19);
  });

  it("a shot flies along its pitch: over someone's head it misses them; those watching get only its aim", async () => {
    const { room, input: inA, client: cA, p: a } = await join("shooter");
    clearTraffic(room);
    const { input: inB, client: cB, p: b } = await joinExisting(room, "target");
    place(a, OPEN.x - 6, OPEN.z);
    place(b, OPEN.x + 6, OPEN.z);
    a.weapon = Weapon.Pistol; a.ammo1 = 20;
    await sleep(400);
    const shots: unknown[][] = [];
    cB.onMessage("shot", (m: unknown[]) => shots.push(m));
    // 12 m out, 0.25 rad up: ~4 m up as it passes them
    await Promise.all([
      drive(inA, 6, (d, i) => { d.aim = Math.PI / 2; d.pitch = 0.25 * AIM_Q; d.weapon = Weapon.Pistol; d.fire = i === 1; }),
      drive(inB, 6, () => {}),
    ]);
    await sleep(100);
    assert.strictEqual(b.hp, 100, "over their head");
    assert.strictEqual(a.ammo1, 19, "it did fire");
    assert.strictEqual(shots.length, 1, `seen by the target: ${shots.length}`);
    // [shooter, weapon, x, y, z (cm), yaw, pitch (1/AIM_Q rad)]
    const [s, w, x, y, , yaw, pitch] = shots[0] as [string, number, number, number, number, number, number];
    assert.strictEqual(s, cA.sessionId);
    assert.strictEqual(w, Weapon.Pistol);
    assert.ok(Math.abs(x - (OPEN.x - 6) * 100) <= 1 && y === 100, `from the gun: ${x}, ${y}`);
    assert.strictEqual(pitch, 2500);
    assert.ok(Math.abs(yaw - Math.round((Math.PI / 2) * AIM_Q)) <= 1, `${yaw}`);
  });

  it("a blast point-blank knocks a raccoon off its feet with all of it; one from 12 m catches it with a pellet, and no shove", async () => {
    const { room, input: inA, p: a } = await join("blaster");
    clearTraffic(room);
    const { input: inB, p: b } = await joinExisting(room, "target");
    place(a, OPEN.x - 2, OPEN.z);
    place(b, OPEN.x, OPEN.z);
    a.weapon = Weapon.Shotgun; a.ammo3 = 5;
    await sleep(400);
    const blast = () => Promise.all([
      drive(inA, 4, (d, i) => { d.aim = Math.PI / 2; d.pitch = 0; d.weapon = Weapon.Shotgun; d.fire = i === 1; }),
      drive(inB, 4, () => {}),
    ]);
    await blast();
    const all = WEAPONS[Weapon.Shotgun].pellets * WEAPONS[Weapon.Shotgun].damage;
    assert.strictEqual(b.hp, 100 - all, `all ${WEAPONS[Weapon.Shotgun].pellets} pellets: hp ${b.hp}`);
    assert.strictEqual(b.mode, Mode.Knocked, "knocked off its feet");
    assert.ok(b.vx > 5, `blown away from the shooter: vx ${b.vx}`);

    // (the Blunderbuss reloads, and the target gets back up)
    await Promise.all([drive(inA, 30, () => {}), drive(inB, 30, () => {})]);
    b.hp = 100;
    place(b, OPEN.x + 10, OPEN.z);
    place(a, OPEN.x - 2, OPEN.z);
    await sleep(100);
    await blast();
    assert.strictEqual(b.hp, 100 - Math.round(pelletDamage(Weapon.Shotgun, 12 - PLAYER_RADIUS - 0.2)), `one pellet, fallen off: hp ${b.hp}`);
    assert.strictEqual(b.mode, Mode.Foot);
    assert.ok(Math.abs(b.vx) < 0.01, `no shove: vx ${b.vx}`);
  });

  it("grabs a weapon crate inside the shared step", async () => {
    const { room, input, p } = await join("collector");
    clearTraffic(room);
    const [key, pk] = [...room.state.pickups.entries()].find(([, q]) => q.kind === Weapon.Smg)!;
    place(p, pk.x + 3, pk.z);
    p.y = pk.y;
    p.weapon = Weapon.Pistol; p.ammo2 = 0;
    // like the client: ask for whatever the step last switched us to
    await drive(input, 25, (d) => { d.mx = -100; d.weapon = p.weapon; });
    assert.strictEqual(room.state.pickups.get(key)!.active, false, "crate taken");
    assert.strictEqual(p.ammo2, WEAPONS[Weapon.Smg].pickupAmmo, "SMG ammo granted once");
    assert.strictEqual(p.weapon, Weapon.Smg, "switched to the new gun");
  });

  it("winds up a stink bomb, throws it on letting go, and it goes off where its path said", async () => {
    const { room, client: cA, input: inA, p: a } = await join("bomber");
    clearTraffic(room);
    const { client: cB, input: inB, p: b } = await joinExisting(room, "victim");
    place(a, OPEN.x - 10, OPEN.z);
    place(b, OPEN.x, OPEN.z);
    // a quick-throw: G with the pop-gun out
    a.weapon = Weapon.Pistol; a.ammo1 = 10; a.ammo4 = 2;
    await sleep(400);
    let boom: { x: number; y: number; z: number } | null = null;
    cB.onMessage("boom", (m: { x: number; y: number; z: number }) => { boom = m; });

    // held for 9 steps: wound up to 9, and the victim sees it
    await Promise.all([
      drive(inA, 9, (d) => { d.aim = Math.PI / 2; d.weapon = Weapon.Pistol; d.nade = true; }),
      drive(inB, 9, () => {}),
    ]);
    assert.strictEqual(a.charge, 9);
    assert.strictEqual((cB as any).state.players.get(cA.sessionId)?.charge, 9, "everyone sees the wind-up");
    assert.strictEqual(room.state.grenades.size, 0, "nothing thrown while it's held");

    // let go (the 10th input): thrown, keyed by that input
    await Promise.all([
      drive(inA, 1, (d) => { d.aim = Math.PI / 2; d.weapon = Weapon.Pistol; }),
      drive(inB, 1, () => {}),
    ]);
    assert.strictEqual(room.state.grenades.size, 1, "thrown on letting go");
    const g = [...room.state.grenades.values()][0];
    assert.strictEqual(g.owner, cA.sessionId);
    assert.strictEqual(g.seq, 10, "carries the seq of the input that let go");
    assert.deepStrictEqual([a.charge, a.ammo4, a.ammo1, a.weapon], [0, 1, 10, Weapon.Pistol], "one stink bomb gone, no shot, pop-gun still out");

    // the server counted the hold itself: its stink bomb goes off exactly where the shared path ends
    const path = grenadePath(grenadeLaunch(a, Math.PI / 2, 9 / GRENADE_CHARGE_STEPS));
    const end = (path.n - 1) * 3;
    await Promise.all([drive(inA, 70, () => {}), drive(inB, 70, () => {})]);
    assert.strictEqual(room.state.grenades.size, 0, "it went off");
    assert.ok(boom, "the victim heard it");
    const at = boom as unknown as { x: number; y: number; z: number };
    assert.ok(Math.hypot(at.x - path.xyz[end], at.z - path.xyz[end + 2]) < 0.02, `boom at ${at.x},${at.z}, path ends at ${path.xyz[end]},${path.xyz[end + 2]}`);
    assert.ok(b.hp < 100, `victim was hurt, hp=${b.hp}`);
  });
});

describe("shared step", () => {
  const world: WorldView = { cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null };
  const fresh = (): PlayerSim => ({
    x: 0, y: 0, z: -22, vx: 0, vy: 0, vz: 0, yaw: 0, mode: Mode.Foot, veh: -1, lx: 0, ly: 0, lz: 0, lyaw: 0, steer: 0, yawRate: 0,
    grounded: true, weapon: 1, ammo1: 10, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
  });

  const idle: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 1 };
  const ctxAt = (time = 0): SimCtx => ({ dt: 1 / TICK_RATE, time, memo: (_k, f) => f() });
  const wreckAt = (x: number, z: number): SeenCar => ({ id: 2, kind: 0, driven: false, wreck: true, x, z, yaw: 0, vx: 0, vz: 0, halfL: 1.9, halfW: 1.0, roof: 1.45 });

  it("grabs a crate: ammo, weapon and the crate's key, once", () => {
    const s = fresh();
    const w: WorldView = { ...world, pickup: (x, _y, z) => (Math.hypot(x, z + 22) < 1.5 ? { id: "7", kind: Weapon.Smg } : null) };
    const ctx = ctxAt();
    stepPlayer(ctx, s, idle, w);
    assert.strictEqual(ctx.picked, "7");
    assert.strictEqual(s.ammo2, WEAPONS[Weapon.Smg].pickupAmmo);
    assert.strictEqual(s.weapon, Weapon.Smg);
    // driving past a crate grabs nothing
    const d = { ...fresh(), mode: Mode.Driving, veh: 1 };
    const c2 = ctxAt();
    stepPlayer(c2, d, idle, w);
    assert.strictEqual(c2.picked, "");
    assert.strictEqual(d.ammo2, 0);
  });

  it("wrecks are solid but can't be stolen", () => {
    // driving east into a wreck: the car stops short of it
    const s: PlayerSim = { ...fresh(), mode: Mode.Driving, veh: 1, x: -10, yaw: Math.PI / 2 };
    const w: WorldView = { ...world, cars: () => [wreckAt(0, -22)] };
    for (let i = 0; i < 60; i++) stepPlayer(ctxAt(), s, { ...idle, throttle: 100 }, w);
    assert.ok(s.x < -1.9, `stopped by the wreck, x=${s.x.toFixed(2)}`);
    // standing next to it and pressing E does nothing
    const f: PlayerSim = { ...fresh(), x: 0, z: -22 + 1.0 + 0.6 };
    stepPlayer(ctxAt(), f, { ...idle, use: true }, { ...world, cars: () => [wreckAt(0, -22)] });
    assert.strictEqual(f.mode, Mode.Foot);
  });

  it("riding a train keeps a world yaw (no full-turn jumps) and a platform yaw", () => {
    const pose: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 };
    // ride wagon 1 for 20 s of track (it goes round corners), turning around now and then
    let t = 5000;
    trainCarPose(1, t, pose);
    const s: PlayerSim = { ...fresh(), x: pose.x, z: pose.z, y: 3, yaw: 2.9 };
    const ctx0 = ctxAt(t);
    // standing on top of it is riding it
    stepPlayer(ctx0, s, idle, world);
    assert.strictEqual(s.mode, Mode.Train);
    let prevYaw = s.yaw;
    for (let i = 0; i < 600 && s.mode === Mode.Train; i++) {
      t += 1000 / TICK_RATE;
      const aim = Math.sin(i / 40) * 3;
      stepPlayer(ctxAt(t), s, { ...idle, aim, fire: i % 50 < 25, weapon: 1 }, world);
      assert.ok(Math.abs(s.yaw - prevYaw) < 1, `yaw jumped ${prevYaw} -> ${s.yaw}`);
      trainCarPose(1, t, pose);
      assert.ok(Math.abs(wrapAngle(s.yaw - (pose.yaw + s.lyaw))) < 1e-3, "world yaw = platform yaw + lyaw");
      prevYaw = s.yaw;
    }
    assert.strictEqual(s.mode, Mode.Train, "still riding after 20 s");
  });

  it("commits float32 at the end of each step (what the wire carries)", () => {
    const s = fresh();
    s.x = 0.1; s.vx = 1 / 3;
    stepPlayer(ctxAt(), s, { ...idle, mx: 37 }, world);
    for (const f of ["x", "y", "z", "vx", "vy", "vz", "yaw", "lx", "ly", "lz", "lyaw", "steer", "yawRate"] as const) {
      assert.strictEqual(s[f], Math.fround(s[f]), `${f} is float32`);
    }
  });

  it("is deterministic (same inputs → bit-identical state)", () => {
    const inputs = Array.from({ length: 240 }, (_, i) => ({
      mx: Math.round(Math.sin(i / 9) * 100), mz: Math.round(Math.cos(i / 13) * 100), throttle: 0, steer: 0,
      aim: Math.sin(i / 7), fire: i % 11 === 0, jump: i % 37 === 0, sprint: i % 3 === 0, use: false, weapon: 1,
    }));
    const run = () => {
      const s = fresh();
      inputs.forEach((cmd, i) => stepPlayer({ dt: 1 / TICK_RATE, time: 5000 + i * 33, memo: (_k, f) => f() }, s, cmd, world));
      return JSON.stringify(s);
    };
    assert.strictEqual(run(), run());
  });
});
