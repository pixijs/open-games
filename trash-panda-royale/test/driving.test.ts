import assert from "assert";
import { CAR_REVERSE_HOLD, CarLight, Mode, TICK_RATE } from "../src/shared/constants.ts";
import { carLights, EV_CRASH, stepPlayer, type InputLike, type PlayerSim, type SimCtx, type WorldView } from "../src/shared/sim.ts";

describe("driving: brakes and drifts (shared step)", () => {
  const world: WorldView = { cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null };
  // the biggest open ground on the map (outside the town's north-east corner): nothing to hit
  // within ~20 m of (116, 124)
  const fresh = (speed: number, x = 104, z = 124, yaw = Math.PI / 2): PlayerSim => ({
    x, y: 0, z, vx: Math.sin(yaw) * speed, vy: 0, vz: Math.cos(yaw) * speed, yaw, mode: Mode.Driving, veh: 1,
    lx: 0, ly: 0, lz: 0, lyaw: 0, steer: 0, yawRate: 0, grounded: true, weapon: 0,
    ammo1: 0, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
  });
  const drive = (throttle: number, steer: number, handbrake = false): InputLike => ({
    mx: 0, mz: 0, throttle: throttle * 100, steer: steer * 100, aim: 0, fire: false, jump: handbrake,
    sprint: false, use: false, weapon: 0,
  });
  let time = 0;
  const step = (p: PlayerSim, cmd: InputLike) => {
    const ctx: SimCtx = { dt: 1 / TICK_RATE, time: (time += 33), memo: (_k, f) => f() };
    const ev = stepPlayer(ctx, p, cmd, world);
    assert.ok(!(ev & EV_CRASH), `hit something at (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);
    return ev;
  };
  const forward = (p: PlayerSim) => p.vx * Math.sin(p.yaw) + p.vz * Math.cos(p.yaw);
  /** Angle between the nose and where the car goes (degrees, + = sliding to its left). */
  const slip = (p: PlayerSim) => (Math.atan2(p.vx * Math.cos(p.yaw) - p.vz * Math.sin(p.yaw), forward(p)) * 180) / Math.PI;

  it("S brakes to a halt (not into reverse), holds it a moment, then backs up; the lights say so", () => {
    const p = fresh(20, 96, 124);
    const x0 = p.x;
    let steps = 0;
    while (forward(p) > 0.05) {
      step(p, drive(-1, 0));
      assert.strictEqual(carLights(p, drive(-1, 0)) & CarLight.Brake, CarLight.Brake);
      assert.ok(++steps < 40, "stops within 1.3 s");
    }
    const dist = p.x - x0;
    assert.ok(dist > 6 && dist < 10, `20 m/s to a halt in ${dist.toFixed(1)} m`);
    // held there (brake lights still on), then reversing (reversing lights)
    for (let i = 0; i < CAR_REVERSE_HOLD - 1; i++) {
      step(p, drive(-1, 0));
      assert.ok(Math.abs(forward(p)) < 0.05, "held at a halt");
      assert.strictEqual(carLights(p, drive(-1, 0)), CarLight.Brake);
    }
    for (let i = 0; i < 10; i++) step(p, drive(-1, 0));
    assert.ok(forward(p) < -1, `backing up at ${forward(p).toFixed(2)} m/s`);
    assert.strictEqual(carLights(p, drive(-1, 0)), CarLight.Reverse);
    // W while rolling backward brakes
    step(p, drive(1, 0));
    assert.strictEqual(carLights(p, drive(1, 0)), CarLight.Brake);
  });

  it("takes a corner on its tyres: full lock and full throttle at speed stays planted", () => {
    const p = fresh(20, 104, 108);
    let worst = 0;
    for (let i = 0; i < 30; i++) {
      step(p, drive(1, -1));
      worst = Math.max(worst, Math.abs(slip(p)));
    }
    assert.ok(worst < 6, `slip ${worst.toFixed(1)}°`);
    assert.ok(p.yawRate > 0.9, `turning left at ${p.yawRate.toFixed(2)} rad/s`);
  });

  it("a handbrake tap kicks the tail out; steering into it on the throttle holds the drift; letting go of the stick catches it", () => {
    const p = fresh(18, 100, 118);
    // 0.4 s of handbrake, turning left: the tail slides out to the right
    for (let i = 0; i < 12; i++) step(p, drive(0, -1, true));
    assert.ok(slip(p) < -12, `tail out, slip ${slip(p).toFixed(1)}°`);
    assert.strictEqual(carLights(p, drive(0, -1, true)) & CarLight.Handbrake, CarLight.Handbrake);
    // full left and full throttle: still sliding a second later, still going
    let least = Infinity;
    for (let i = 0; i < 30; i++) {
      step(p, drive(1, -1));
      least = Math.min(least, Math.abs(slip(p)));
    }
    assert.ok(least > 12, `held the drift (least slip ${least.toFixed(1)}°)`);
    assert.ok(Math.hypot(p.vx, p.vz) > 9, `speed ${Math.hypot(p.vx, p.vz).toFixed(1)} m/s`);
    // straighten the stick: gripping again within a second, without swinging the other way
    let caught = -1, other = 0;
    for (let i = 0; i < 30; i++) {
      step(p, drive(1, 0));
      if (caught < 0 && Math.abs(slip(p)) < 4) caught = i;
      other = Math.max(other, slip(p));
    }
    assert.ok(caught >= 0 && caught < 30, `caught after ${caught} steps`);
    assert.ok(other < 6, `no snap the other way (${other.toFixed(1)}°)`);
  });

  it("holding the handbrake through a turn spins the car round", () => {
    const p = fresh(18, 100, 124);
    const y0 = p.yaw;
    for (let i = 0; i < 45; i++) step(p, drive(0, -1, true));
    const turned = (((p.yaw - y0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    assert.ok(turned > 2.2 && turned < 4.2, `turned ${((turned * 180) / Math.PI).toFixed(0)}°`);
    assert.ok(Math.hypot(p.vx, p.vz) < 6, "and scrubbed most of its speed");
  });

  it("clipping a wall with the nose swings the nose away from it", () => {
    // into the map's east edge (x = MAP_HALF) at 30°, nose first: heading mostly +x, a little +z,
    // so the wall is ahead and to the car's left (its left is +x, -z)
    const yaw = Math.PI / 2 - 0.5;
    const p = fresh(15, 160, 0, yaw);
    let hit = false;
    for (let i = 0; i < 20 && !hit; i++) {
      const ctx: SimCtx = { dt: 1 / TICK_RATE, time: (time += 33), memo: (_k, f) => f() };
      hit = (stepPlayer(ctx, p, drive(0, 0), world) & EV_CRASH) !== 0;
    }
    assert.ok(hit, "reached the edge");
    // the nose turns right, away from it
    assert.ok(p.yawRate < -0.5, `yaw rate ${p.yawRate.toFixed(2)}`);
  });

  it("is deterministic, and a replay from any committed state matches the live run", () => {
    const inputs = Array.from({ length: 150 }, (_, i) => drive(Math.sin(i * 0.21), Math.cos(i * 0.13), i % 37 < 8));
    const a = fresh(15, 100, 120), b = fresh(15, 100, 120);
    let saved: PlayerSim | null = null;
    for (let i = 0; i < inputs.length; i++) {
      if (i === 70) saved = { ...a };
      const ctx: SimCtx = { dt: 1 / TICK_RATE, time: i * 33, memo: (_k, f) => f() };
      stepPlayer(ctx, a, inputs[i], world);
      const ctx2: SimCtx = { dt: 1 / TICK_RATE, time: i * 33, memo: (_k, f) => f() };
      stepPlayer(ctx2, b, inputs[i], world);
    }
    assert.deepStrictEqual(a, b);
    const r = saved!;
    for (let i = 70; i < inputs.length; i++) {
      const ctx: SimCtx = { dt: 1 / TICK_RATE, time: i * 33, memo: (_k, f) => f() };
      stepPlayer(ctx, r, inputs[i], world);
    }
    assert.deepStrictEqual(r, a);
  });
});
