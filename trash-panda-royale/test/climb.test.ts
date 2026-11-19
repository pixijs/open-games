import assert from "assert";
import { CAR_TYPES, CLIMB_SETTLE, Mode, ticks, TICK_RATE, TRAIN_ROOF } from "../src/shared/constants.ts";
import { groundHeight } from "../src/shared/map.ts";
import { EV_CLIMB, EV_JUMP, EV_TRAIN_HIT, stepPlayer, type InputLike, type PlayerSim, type SeenCar, type WorldView } from "../src/shared/sim.ts";
import { trainCarPose, trainPointWorld, trainU, type CarPose } from "../src/shared/train.ts";

/**
 * Getting onto a roof takes no button: jump into the side of a car or a train, pushing into it,
 * and you climb up when its roof is within reach.
 */
describe("climbing onto roofs (shared step)", () => {
  const DT = 1 / TICK_RATE;
  const STEP_MS = 1000 / TICK_RATE;
  const idle: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 0 };
  // open ground outside the town's north-east corner: nothing else to bump into
  const CX = 104, CZ = 124;
  const parked = (kind: number, wreck = false): SeenCar => {
    const t = CAR_TYPES[kind];
    return { id: 7, kind, driven: false, wreck, x: CX, z: CZ, yaw: 0, vx: 0, vz: 0, halfL: t.halfL, halfW: t.halfW, roof: t.roof };
  };
  const withCar = (c: SeenCar): WorldView => ({
    cars: () => [c], car: (id) => (id === c.id ? c : null), carKind: () => c.kind, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null,
  });
  const noCars: WorldView = { cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null };
  const standing = (x: number, z: number): PlayerSim => ({
    x, y: groundHeight(x, z, 0), z, vx: 0, vy: 0, vz: 0, yaw: 0, mode: Mode.Foot, veh: -1, lx: 0, ly: 0, lz: 0, lyaw: 0,
    steer: 0, yawRate: 0, grounded: true, weapon: 0, ammo1: 0, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
  });
  /** Step up to `n` times from room time `t0`, until a climb; returns the step that climbed (-1: none). */
  const run = (s: PlayerSim, world: WorldView, n: number, cmd: (i: number) => Partial<InputLike>, t0 = 5000) => {
    for (let i = 0; i < n; i++) {
      const ev = stepPlayer({ dt: DT, time: Math.round(t0 + i * STEP_MS), memo: (_k, f) => f() }, s, { ...idle, ...cmd(i) }, world);
      if (ev & EV_CLIMB) return i;
    }
    return -1;
  };
  /** Beside a car's right flank (−x), just short of touching it. */
  const besideCar = (c: SeenCar) => standing(c.x - c.halfW - 0.37, c.z);

  for (const kind of [0, 3]) {
    it(`a jump into a ${CAR_TYPES[kind].name}'s side climbs onto its roof`, () => {
      const c = parked(kind);
      const s = besideCar(c);
      const at = run(s, withCar(c), 20, (i) => ({ mx: 100, jump: i === 0 }));
      assert.ok(at >= 0, "climbed");
      assert.strictEqual(s.mode, Mode.Roof);
      assert.strictEqual(s.veh, c.id);
      assert.strictEqual(s.ly, Math.fround(c.roof));
      // on the roof, a little way in from the side we came up
      assert.ok(Math.abs(s.lx) <= c.halfW * 0.6 + 1e-6, `lx ${s.lx}`);
      assert.ok(Math.abs(s.lz) <= c.halfL * 0.5 + 1e-6, `lz ${s.lz}`);
    });
  }

  it("the stick still held after the climb: a moment to find your feet, then you walk (not straight off the far side)", () => {
    const c = parked(0);
    const s = besideCar(c);
    const at = run(s, withCar(c), 20, (i) => ({ mx: 100, jump: i === 0 }));
    assert.ok(at >= 0, "climbed");
    const lx0 = s.lx;
    const settle = ticks(CLIMB_SETTLE);
    run(s, withCar(c), settle, () => ({ mx: 100 }));
    assert.strictEqual(s.lx, lx0, "stood still while settling");
    // 0.6 s after the climb: walking across, still aboard; by 1.2 s, off the far side
    run(s, withCar(c), ticks(0.6) - settle, () => ({ mx: 100 }));
    assert.strictEqual(s.mode, Mode.Roof);
    assert.ok(s.lx > lx0 + 0.3, `walking across, lx ${lx0} -> ${s.lx}`);
    run(s, withCar(c), ticks(0.6), () => ({ mx: 100 }));
    assert.strictEqual(s.mode, Mode.Foot);
  });

  it("the jump that climbed, still held (the client holds a tap 150 ms), doesn't hop you off the roof again", () => {
    const c = parked(0);
    const s = besideCar(c);
    const at = run(s, withCar(c), 20, () => ({ mx: 100, jump: true }));
    assert.strictEqual(at, 0, "up on the jump's first step");
    let hops = 0;
    for (let i = 0; i < ticks(CLIMB_SETTLE); i++) {
      const ev = stepPlayer({ dt: DT, time: 5000 + (i + 1) * 33, memo: (_k, f) => f() }, s, { ...idle, jump: i < 4 }, withCar(c));
      if (ev & EV_JUMP) hops++;
    }
    assert.strictEqual(hops, 0);
    assert.strictEqual(s.ly, Math.fround(c.roof));
    // a jump once we've found our feet goes up as usual
    const ev = stepPlayer({ dt: DT, time: 6000, memo: (_k, f) => f() }, s, { ...idle, jump: true }, withCar(c));
    assert.ok(ev & EV_JUMP);
  });

  it("walking into a car doesn't climb it, nor does a jump along its side, nor one with the stick let go", () => {
    const c = parked(0);
    const walk = besideCar(c);
    assert.strictEqual(run(walk, withCar(c), 30, () => ({ mx: 100 })), -1);
    assert.strictEqual(walk.mode, Mode.Foot);
    const past = besideCar(c);
    assert.strictEqual(run(past, withCar(c), 30, (i) => ({ mz: 100, jump: i === 0 })), -1);
    assert.strictEqual(past.mode, Mode.Foot);
    // pressed against it, then the stick let go and a jump straight up
    const up = besideCar(c);
    assert.strictEqual(run(up, withCar(c), 30, (i) => (i < 6 ? { mx: 100 } : { jump: i === 6 })), -1);
    assert.strictEqual(up.mode, Mode.Foot);
  });

  it("a wreck can't be climbed", () => {
    const c = parked(0, true);
    const s = besideCar(c);
    run(s, withCar(c), 30, (i) => ({ mx: 100, jump: i === 0 }));
    assert.strictEqual(s.mode, Mode.Foot);
  });

  it("E beside a car still gets in (it doesn't climb)", () => {
    const c = parked(0);
    const s = besideCar(c);
    run(s, withCar(c), 1, () => ({ use: true }));
    assert.strictEqual(s.mode, Mode.Driving);
  });

  // a wagon on a straight, its left flank (+x local); 2 m toward its front: it moves on under us
  const T0 = 5000, SLOT = 2;
  const pose = (t: number): CarPose => trainCarPose(SLOT, t, { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 });
  const besideTrain = () => {
    const p = pose(T0);
    const w = trainPointWorld(SLOT, T0, p.halfW + 0.37, trainU(SLOT, 2), { x: 0, z: 0 });
    return standing(w.x, w.z);
  };
  /** The stick pushing into the wagon's left flank (toward its right). */
  const intoTrain = () => {
    const y = pose(T0).yaw;
    return { mx: Math.round(-Math.cos(y) * 100), mz: Math.round(Math.sin(y) * 100) };
  };

  it("a jump into a moving train's side climbs onto it, near the top of the jump, and it carries you", () => {
    const s = besideTrain();
    const into = intoTrain();
    const at = run(s, noCars, 20, (i) => ({ ...into, jump: i === 0 }), T0);
    assert.ok(at > 0, "climbed");
    // a 3 m roof is within reach only near the top of the jump (1.65 m, 0.37 s in)
    assert.ok(at * DT > 0.2 && at * DT < 0.5, `climbed ${(at * DT).toFixed(2)} s in`);
    assert.strictEqual(s.mode, Mode.Train);
    assert.strictEqual(s.veh, SLOT);
    assert.strictEqual(s.ly, TRAIN_ROOF);
    assert.ok(Math.abs(s.lx) <= 0.8 + 1e-6);
    // and then it carries us (stick let go)
    const t1 = Math.round(T0 + (at + 1) * STEP_MS);
    const x0 = s.x, z0 = s.z;
    run(s, noCars, 30, () => ({}), t1);
    assert.strictEqual(s.mode, Mode.Train);
    assert.ok(Math.hypot(s.x - x0, s.z - z0) > 8, "rode along");
  });

  it("a running jump at a train climbs it too; running into its side only bumps you (it doesn't run you over)", () => {
    const p = pose(T0);
    const into = intoTrain();
    const from = () => {
      const w = trainPointWorld(SLOT, T0, p.halfW + 2.5, trainU(SLOT, 2), { x: 0, z: 0 });
      return standing(w.x, w.z);
    };
    const leap = from();
    let hit = false;
    const at = run(leap, noCars, 25, (i) => ({ ...into, sprint: true, jump: i === 3 }), T0);
    assert.ok(at > 0, "climbed");
    assert.strictEqual(leap.mode, Mode.Train);
    const bump = from();
    for (let i = 0; i < 12; i++) {
      const ev = stepPlayer({ dt: DT, time: Math.round(T0 + i * STEP_MS), memo: (_k, f) => f() }, bump, { ...idle, ...into, sprint: true }, noCars);
      if (ev & EV_TRAIN_HIT) hit = true;
    }
    assert.ok(!hit, "not run over");
    assert.strictEqual(bump.mode, Mode.Foot);
  });

  it("no climbing a train without a jump, or without pushing into it, and E does nothing there", () => {
    const into = intoTrain();
    // (for as long as the wagon is beside us: walk on into the gap behind it and the next one runs us over)
    const walk = besideTrain();
    assert.strictEqual(run(walk, noCars, 12, () => into, T0), -1);
    assert.strictEqual(walk.mode, Mode.Foot);
    const up = besideTrain();
    assert.strictEqual(run(up, noCars, 20, (i) => ({ jump: i === 0 }), T0), -1);
    assert.strictEqual(up.mode, Mode.Foot);
    const use = besideTrain();
    run(use, noCars, 3, (i) => ({ ...into, use: i === 1 }), T0);
    assert.strictEqual(use.mode, Mode.Foot);
  });
});
