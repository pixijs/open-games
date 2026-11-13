import assert from "assert";
import {
  BIN_REACH, GRENADE_CHARGE_STEPS, GRENADE_FUSE_MS, GRENADE_MAX_DIST, GRENADE_MIN_DIST, Mode, TICK_RATE, Weapon, WEAPONS,
} from "../src/shared/constants.ts";
import { CITY, nearestBin } from "../src/shared/map.ts";
import {
  EV_FIRE, EV_HIDE, EV_THROW, EV_UNHIDE, GRENADE_FUSE_SUBSTEPS, grenadeLaunch, grenadePath, stepGrenade, stepPlayer,
  type InputLike, type PlayerSim, type SeenCar, type SimCtx, type WorldView,
} from "../src/shared/sim.ts";

describe("stink bombs: winding up and letting go (shared step)", () => {
  const world: WorldView = { cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: (x, y, z) => nearestBin(x, y, z, BIN_REACH), poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null };
  const EAST = Math.PI / 2;
  // standing on the road z = -22 (open asphalt for 30 m to the east), the pop-gun out
  const idle: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: EAST, fire: false, jump: false, sprint: false, use: false, weapon: Weapon.Pistol };
  const g: InputLike = { ...idle, nade: true };
  const fresh = (): PlayerSim => ({
    x: -40, y: 0, z: -22, vx: 0, vy: 0, vz: 0, yaw: 0, mode: Mode.Foot, veh: -1, lx: 0, ly: 0, lz: 0, lyaw: 0, steer: 0, yawRate: 0,
    grounded: true, weapon: Weapon.Pistol, ammo1: 10, ammo2: 0, ammo3: 0, ammo4: 2, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
  });
  let time = 5000;
  const step = (s: PlayerSim, cmd: InputLike, w = world, frozen = false) => {
    const ctx: SimCtx = { dt: 1 / TICK_RATE, time: (time += 33), memo: (_k, f) => f(), frozen };
    const ev = stepPlayer(ctx, s, cmd, w);
    return { ev, thrown: ctx.thrown, picked: ctx.picked };
  };
  /** Hold `cmd` for `n` steps (asserting nothing is thrown meanwhile), then let go with `release`. */
  const windUp = (s: PlayerSim, n: number, cmd = g, release = idle) => {
    for (let i = 0; i < n; i++) {
      const r = step(s, cmd);
      assert.ok(!(r.ev & EV_THROW) && !r.thrown, "nothing thrown while it's held");
    }
    return step(s, release);
  };
  /** Where a throw comes to rest (where it goes off), and how far that is from `s`. */
  const restOf = (s: PlayerSim, thrown: NonNullable<ReturnType<typeof step>["thrown"]>) => {
    const path = grenadePath(thrown);
    const i = (path.n - 1) * 3;
    return { x: path.xyz[i], z: path.xyz[i + 2], d: Math.hypot(path.xyz[i] - s.x, path.xyz[i + 2] - s.z) };
  };

  it("G winds it up a step at a time (holding at full power), and letting go throws it as far as it was wound up", () => {
    const s = fresh();
    for (let i = 1; i <= 12; i++) {
      step(s, g);
      assert.strictEqual(s.charge, i);
    }
    assert.deepStrictEqual([s.ammo4, s.ammo1, s.weapon], [2, 10, Weapon.Pistol], "nothing used up yet, the pop-gun still out");
    const r = step(s, idle);
    assert.ok(r.ev & EV_THROW);
    assert.deepStrictEqual(r.thrown, grenadeLaunch(s, EAST, 12 / GRENADE_CHARGE_STEPS), "the launch the server and the client both use");
    assert.deepStrictEqual([s.charge, s.ammo4, s.cd], [0, 1, WEAPONS[Weapon.Grenade].cooldown]);
    // held long, it stops at full power
    const t = fresh();
    for (let i = 0; i < GRENADE_CHARGE_STEPS + 25; i++) step(t, g);
    assert.strictEqual(t.charge, GRENADE_CHARGE_STEPS);
  });

  it("a tap is the shortest throw and full power the longest: on open ground they rest ~3 m to ~26 m away", () => {
    const dists: number[] = [];
    for (const n of [1, 5, 10, 15, 20, 25, GRENADE_CHARGE_STEPS]) {
      const s = fresh();
      const r = windUp(s, n);
      assert.ok(r.thrown, `thrown after ${n}`);
      dists.push(restOf(s, r.thrown!).d);
    }
    for (let i = 1; i < dists.length; i++) assert.ok(dists[i] > dists[i - 1] + 1, `longer the more it's wound up: ${dists.map((d) => d.toFixed(1))}`);
    assert.ok(Math.abs(dists[0] - (GRENADE_MIN_DIST + (GRENADE_MAX_DIST - GRENADE_MIN_DIST) / GRENADE_CHARGE_STEPS)) < 1, `a tap rests ${dists[0].toFixed(2)} m away`);
    assert.ok(Math.abs(dists[dists.length - 1] - GRENADE_MAX_DIST) < 1, `full power rests ${dists[dists.length - 1].toFixed(2)} m away`);
  });

  it("with the stink bomb out the click winds it up instead of throwing; with a gun out it shoots", () => {
    const s = { ...fresh(), weapon: Weapon.Grenade };
    const first = step(s, { ...idle, fire: true, weapon: Weapon.Grenade });
    assert.ok(!(first.ev & (EV_THROW | EV_FIRE)), "a click alone throws nothing");
    const r = windUp(s, 6, { ...idle, fire: true, weapon: Weapon.Grenade }, { ...idle, weapon: Weapon.Grenade });
    assert.ok(r.ev & EV_THROW);
    assert.deepStrictEqual(r.thrown, grenadeLaunch(s, EAST, 7 / GRENADE_CHARGE_STEPS));

    const p = fresh();
    const shot = step(p, { ...idle, fire: true });
    assert.ok(shot.ev & EV_FIRE);
    assert.deepStrictEqual([p.charge, p.ammo1, p.ammo4], [0, 9, 2]);
  });

  it("while winding up nothing else fires, the weapon stays put, and a grabbed can doesn't swap it", () => {
    const s = { ...fresh(), ammo2: 30 };
    step(s, g);
    // the click and a weapon change, both held through the wind-up
    let can = true;
    const loot: WorldView = { ...world, pickup: () => (can ? ((can = false), { id: "7", kind: Weapon.Shotgun }) : null) };
    for (let i = 0; i < 8; i++) {
      const r = step(s, { ...g, fire: true, weapon: Weapon.Smg }, loot);
      assert.ok(!(r.ev & (EV_FIRE | EV_THROW)), "no shot, no throw");
    }
    assert.deepStrictEqual([s.charge, s.weapon, s.ammo1, s.ammo2], [9, Weapon.Pistol, 10, 30], "still winding up, the pop-gun out, nothing fired");
    assert.strictEqual(s.ammo3, WEAPONS[Weapon.Shotgun].pickupAmmo, "the can was looted all the same");
    // the click alone doesn't keep a G wind-up going: letting go of G throws it
    const r = step(s, { ...idle, fire: true, weapon: Weapon.Smg });
    assert.ok(r.ev & EV_THROW);
    // and then the weapon change goes through
    step(s, { ...idle, weapon: Weapon.Smg });
    assert.strictEqual(s.weapon, Weapon.Smg);
  });

  it("no stink bombs, or still cooling down from the last one: G winds up nothing", () => {
    const s = { ...fresh(), ammo4: 0 };
    for (let i = 0; i < 10; i++) step(s, g);
    assert.strictEqual(s.charge, 0);
    assert.ok(!(windUp(s, 0).ev & EV_THROW));

    const t = fresh();
    windUp(t, 3);
    const cd = WEAPONS[Weapon.Grenade].cooldown;
    for (let i = 1; i < cd; i++) {
      step(t, g);
      assert.strictEqual(t.charge, 0, `still cooling down (${i})`);
    }
    step(t, g);
    assert.strictEqual(t.charge, 1, "winds up the moment the cooldown is over");
  });

  it("knocked over or frozen mid-wind-up: no throw, and the stink bomb is kept", () => {
    const s = fresh();
    for (let i = 0; i < 10; i++) step(s, g);
    s.mode = Mode.Knocked; s.timer = 20;
    const r = step(s, idle);
    assert.ok(!(r.ev & EV_THROW) && !r.thrown);
    assert.deepStrictEqual([s.charge, s.ammo4], [0, 2]);

    const t = fresh();
    for (let i = 0; i < 10; i++) step(t, g);
    const f = step(t, g, world, true);
    assert.ok(!(f.ev & EV_THROW), "frozen: the held key reads as let go, but it's a cancel");
    assert.deepStrictEqual([t.charge, t.ammo4], [0, 2]);
    for (let i = 0; i < 10; i++) step(t, g, world, true);
    assert.strictEqual(t.charge, 0, "and nothing winds up before GO");
  });

  it("from a trash can, G hops you out winding up; wound up, E by a can doesn't dive in", () => {
    const BI = CITY.bins.findIndex((b) => b.y === 0 && b.x < -100);
    const BIN = CITY.bins[BI];
    const s: PlayerSim = { ...fresh(), x: BIN.x + 0.95, z: BIN.z };
    assert.ok(step(s, { ...idle, use: true }).ev & EV_HIDE);
    const out = step(s, g);
    assert.ok(out.ev & EV_UNHIDE, "hopped out");
    assert.deepStrictEqual([s.mode, s.charge], [Mode.Foot, 1]);

    const t: PlayerSim = { ...fresh(), x: BIN.x + 0.95, z: BIN.z };
    for (let i = 0; i < 5; i++) step(t, g);
    const e = step(t, { ...g, use: true });
    assert.ok(!(e.ev & EV_HIDE), "no dive while winding up");
    assert.deepStrictEqual([t.mode, t.charge], [Mode.Foot, 6]);
  });

  it("in a car, G works with paws out, and the stink bomb keeps the car's speed", () => {
    const car: SeenCar = { id: 1, kind: 0, driven: true, wreck: false, x: -40, z: -22, yaw: EAST, vx: 0, vz: 0, halfL: 1.9, halfW: 1.0, roof: 1.45 };
    const w: WorldView = { ...world, car: () => car, carKind: () => 0 };
    const s: PlayerSim = { ...fresh(), weapon: Weapon.Fists, mode: Mode.Driving, veh: 1, yaw: EAST, vx: 12 };
    for (let i = 0; i < 9; i++) step(s, { ...g, weapon: Weapon.Fists, throttle: 100 }, w);
    assert.strictEqual(s.charge, 9);
    const r = step(s, { ...idle, weapon: Weapon.Fists, throttle: 100 }, w);
    assert.ok(r.ev & EV_THROW);
    const still = grenadeLaunch({ ...s, mode: Mode.Foot }, EAST, 9 / GRENADE_CHARGE_STEPS);
    // (s.vx is rounded to float32 at the end of the step, after the launch read it)
    assert.ok(Math.abs(r.thrown!.vx - still.vx - s.vx) < 1e-5, "the car's speed is added");
  });

  it("is deterministic with wind-ups mixed in", () => {
    const inputs: InputLike[] = Array.from({ length: 300 }, (_, i) => ({
      ...idle, mx: Math.round(Math.sin(i / 9) * 100), mz: Math.round(Math.cos(i / 13) * 100), aim: Math.sin(i / 7) * 3,
      fire: i % 11 === 0, nade: i % 47 < 17, jump: i % 37 === 0, sprint: i % 3 === 0,
    }));
    const run = () => {
      const s = { ...fresh(), ammo4: 5 };
      let throws = 0;
      inputs.forEach((cmd, i) => {
        const ctx: SimCtx = { dt: 1 / TICK_RATE, time: 9000 + i * 33, memo: (_k, f) => f() };
        if (stepPlayer(ctx, s, cmd, world) & EV_THROW) throws++;
      });
      return { s: JSON.stringify(s), throws };
    };
    const a = run();
    assert.deepStrictEqual(run(), a);
    assert.strictEqual(a.throws, 5, "every stink bomb thrown");
  });

  it("its path is the server's flight, sub-step for sub-step (two per fixed step)", () => {
    for (const power of [0, 0.4, 1]) {
      const launch = grenadeLaunch(fresh(), EAST + 0.3, power);
      const path = grenadePath(launch);
      assert.strictEqual(path.n, GRENADE_FUSE_SUBSTEPS + 1);
      // the server: one stepGrenade(1/30) per fixed step, from the step after it's thrown, until the fuse
      const g = { ...launch };
      const steps = Math.ceil(GRENADE_FUSE_MS / (1000 / TICK_RATE));
      for (let k = 1; k <= steps; k++) {
        stepGrenade(g, 1 / TICK_RATE);
        const i = 2 * k * 3;
        assert.deepStrictEqual([path.xyz[i], path.xyz[i + 1], path.xyz[i + 2]], [Math.fround(g.x), Math.fround(g.y), Math.fround(g.z)], `step ${k}`);
      }
      assert.ok(path.bounces.length >= 2, "it bounces");
      assert.ok(path.still < path.n - 1, "and lies still before it goes off");
    }
  });
});
