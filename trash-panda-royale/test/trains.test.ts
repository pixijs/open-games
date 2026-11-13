import assert from "assert";
import { GRAVITY, Mode, PLAYER_RADIUS, TICK_RATE, TRAIN_CARS, TRAIN_GAP, TRAIN_ROOF } from "../src/shared/constants.ts";
import {
  EV_COUPLE, EV_FALL_OFF, EV_LAND, EV_ROOF_LAND, EV_TRAIN_HIT, stepPlayer, wrapAngle,
  type InputLike, type PlayerSim, type WorldView,
} from "../src/shared/sim.ts";
import { CAR_OFFSETS, carLocalZ, LOCO_OBSTACLES, trainCarPose, trainPointWorld, trainU, type CarPose } from "../src/shared/train.ts";

const DT = 1 / TICK_RATE;
const STEP_MS = 1000 / TICK_RATE;
const world: WorldView = { cars: () => [], car: () => null, carKind: () => 0, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null };
const idle: InputLike = { mx: 0, mz: 0, throttle: 0, steer: 0, aim: 0, fire: false, jump: false, sprint: false, use: false, weapon: 0 };
const pose = (slot: number, t: number): CarPose => trainCarPose(slot, t, { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, halfL: 0, halfW: 0, roof: 0 });

/** A rider standing on train car `slot` at (lx, car-local lz), at room time `t`. */
function rider(slot: number, t: number, lx: number, lzCar: number): PlayerSim {
  const u = trainU(slot, lzCar);
  const w = trainPointWorld(slot, t, lx, u, { x: 0, z: 0 });
  return {
    x: w.x, y: TRAIN_ROOF, z: w.z, vx: 0, vy: 0, vz: 0, yaw: pose(slot, t).yaw, mode: Mode.Train, veh: slot,
    lx, ly: TRAIN_ROOF, lz: u, lyaw: 0, steer: 0, yawRate: 0, grounded: true, weapon: 0,
    ammo1: 0, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
  };
}

/** World-space stick input pointing along train car `slot` (+1 = toward the loco), or across it (+1 = its left). */
function along(slot: number, t: number, dir: number, sideways = false): Pick<InputLike, "mx" | "mz"> {
  const y = pose(slot, t).yaw;
  // car forward = (sin y, cos y); car left (+X local) = (cos y, -sin y)
  const fx = sideways ? Math.cos(y) : Math.sin(y), fz = sideways ? -Math.sin(y) : Math.cos(y);
  return { mx: Math.round(fx * 100 * dir), mz: Math.round(fz * 100 * dir) };
}

interface Trace { ev: number; s: PlayerSim; t: number }

/** Run `n` steps from room time `t0`, shaping each input with `cmd(state, t, i)`. */
function run(s: PlayerSim, t0: number, n: number, cmd: (s: PlayerSim, t: number, i: number) => Partial<InputLike>): Trace[] {
  const out: Trace[] = [];
  for (let i = 0; i < n; i++) {
    const t = Math.round(t0 + i * STEP_MS);
    const ev = stepPlayer({ dt: DT, time: t, memo: (_k, f) => f() }, s, { ...idle, ...cmd(s, t, i) }, world);
    out.push({ ev, s: { ...s }, t });
  }
  return out;
}

const count = (tr: Trace[], bit: number) => tr.filter((x) => x.ev & bit).length;

/**
 * Walks (sprints) a rider from the last wagon over every coupling to the locomotive.
 * Checks: never leaves the train, one EV_COUPLE per coupling, and the world motion is
 * the train's motion plus a walking stride — nothing jumps at the couplings.
 */
function walkTheTrain(t0: number, corner: boolean) {
  const last = TRAIN_CARS - 1; // train 0's last wagon
  const s = rider(last, t0, 0, -2);
  let prev = { ...s }, prevT = t0;
  const tr = run(s, t0, 260, (st, t) => ({ ...along(st.veh, t, 1), sprint: true }));
  let reachedLoco = -1;
  for (let k = 0; k < tr.length; k++) {
    const { s: st, t, ev } = tr[k];
    if (st.mode !== Mode.Train) break;
    // carried = where the previous step's spot on the train is now
    const carried = trainPointWorld(prev.veh, t, prev.lx, prev.lz, { x: 0, z: 0 });
    const stride = Math.hypot(st.x - carried.x, st.z - carried.z);
    assert.ok(stride <= 0.25, `step ${k}: moved ${stride.toFixed(3)} m relative to the train (t=${t})`);
    const dU = st.lz - prev.lz;
    if (!corner) {
      // on a straight, U is exactly continuous: it advances by the walking speed along the car
      assert.ok(Math.abs(dU - st.vz * DT) < 1e-3 || Math.abs(dU) < 0.25, `U jumped by ${dU} on a straight`);
    } else {
      assert.ok(Math.abs(dU) < 0.5, `U jumped by ${dU} in a curve`);
    }
    if (st.veh === 0 && reachedLoco < 0) reachedLoco = k;
    prev = { ...st };
    prevT = t;
    void ev; void prevT;
  }
  assert.ok(reachedLoco >= 0, "walked all the way onto the locomotive");
  const onTrain = tr.slice(0, reachedLoco + 1);
  assert.strictEqual(count(onTrain, EV_FALL_OFF), 0, "never fell off on the way");
  assert.strictEqual(count(onTrain, EV_ROOF_LAND), 0, "never re-mounted on the way");
  assert.strictEqual(count(onTrain, EV_COUPLE), TRAIN_CARS - 1, "one hand-over per coupling");
  // keep running: off the front of the locomotive, exactly once
  const rest = tr.slice(reachedLoco + 1);
  assert.strictEqual(count(rest, EV_FALL_OFF), 1, "drops off the locomotive's nose once");
}

describe("train surfing", () => {
  it("sprints wagon to wagon down a whole train on a straight", () => {
    walkTheTrain(5000, false);
  });

  it("sprints wagon to wagon through a corner", () => {
    // the train rounds the first corner (s 228–256) while the rider runs its length
    walkTheTrain(17400, true);
  });

  it("walks over a coupling in the middle of a curve, at the inner edge, centre and outer edge", () => {
    // the coupling between wagon 1 and wagon 2 sits 16.4 m behind the nose: put it mid-arc (s ≈ 242)
    const half1 = pose(1, 0).halfL, half2 = pose(2, 0).halfL;
    const behindNose = CAR_OFFSETS[1] + half1 + TRAIN_GAP / 2;
    const t0 = Math.round(((242 + behindNose) / 11) * 1000) - 300;
    const turn = Math.abs(wrapAngle(pose(1, t0 + 300).yaw - pose(2, t0 + 300).yaw));
    assert.ok(turn > 0.3, `the two cars are turned ${turn.toFixed(2)} rad apart (in the curve)`);
    for (const lx of [-1.1, 0, 1.1]) {
      const s = rider(2, t0, lx, half2 - 1);
      let prev = { ...s };
      const tr = run(s, t0, 40, (st, t) => along(st.veh, t, 1));
      for (const { s: st, t } of tr) {
        const carried = trainPointWorld(prev.veh, t, prev.lx, prev.lz, { x: 0, z: 0 });
        assert.ok(Math.hypot(st.x - carried.x, st.z - carried.z) <= 0.25, `lx ${lx}: smooth across the seam`);
        prev = { ...st };
      }
      assert.strictEqual(count(tr, EV_FALL_OFF), 0, `lx ${lx}: didn't fall in the wedge`);
      assert.strictEqual(count(tr, EV_COUPLE), 1, `lx ${lx}: one hand-over`);
      assert.strictEqual(tr[tr.length - 1].s.veh, 1, `lx ${lx}: on wagon 1`);
    }
  });

  it("jumps across a coupling: stays aboard mid-air and lands on the next car without a snap", () => {
    const t0 = 5000;
    const s = rider(2, t0, 0, 2.2); // wagon 2, near its front end
    let jumped = false;
    const tr = run(s, t0, 60, (st, t) => {
      const cmd: Partial<InputLike> = { ...along(st.veh, t, 1), sprint: true };
      if (!jumped && carLocalZ(st.veh, st.lz) > 3.0) { cmd.jump = true; jumped = true; }
      return cmd;
    });
    for (let k = 1; k < tr.length; k++) {
      const a = tr[k - 1].s, b = tr[k].s;
      assert.strictEqual(b.mode, Mode.Train, `still riding at step ${k}`);
      // the height changes by at most one step of the faster of the two vertical speeds
      const dy = Math.abs(b.ly - a.ly);
      const vmax = Math.max(Math.abs(a.vy), Math.abs(b.vy)) + GRAVITY * DT;
      assert.ok(dy <= vmax * DT + 1e-6, `no snap: ly ${a.ly} -> ${b.ly}`);
    }
    const coupleAt = tr.findIndex((x) => x.ev & EV_COUPLE);
    assert.ok(coupleAt >= 0, "crossed the coupling");
    assert.ok(tr[coupleAt].s.ly > TRAIN_ROOF, "…while in the air");
    const landAt = tr.findIndex((x, k) => k >= coupleAt && (x.ev & EV_LAND));
    assert.ok(landAt >= 0, "landed on the next car");
    assert.strictEqual(tr[landAt].s.veh, 1, "…which is wagon 1");
    assert.strictEqual(tr[landAt].s.ly, TRAIN_ROOF);
  });

  it("walking off the side drops you beside the train, never under it", () => {
    const t0 = 5000;
    const s = rider(1, t0, 0, 0);
    const tr = run(s, t0, 90, (st, t) => (st.mode === Mode.Train ? along(st.veh, t, 1, true) : along(1, t, 1, true)));
    assert.strictEqual(count(tr, EV_FALL_OFF), 1, "one drop off");
    assert.strictEqual(count(tr, EV_ROOF_LAND), 0, "no re-mount");
    assert.strictEqual(count(tr, EV_TRAIN_HIT), 0, "not run over by your own train");
    assert.ok(tr.every((x) => x.s.mode !== Mode.Knocked), "never knocked");
    const end = tr[tr.length - 1].s;
    assert.strictEqual(end.mode, Mode.Foot);
    assert.ok(end.y === 0 && end.grounded, `on the ground, y=${end.y}`);
  });

  it("walking off the back of the last wagon drops you behind it", () => {
    const t0 = 5000;
    const s = rider(TRAIN_CARS - 1, t0, 0, -3);
    const tr = run(s, t0, 90, (st, t) => along(TRAIN_CARS - 1, t, -1));
    assert.strictEqual(count(tr, EV_FALL_OFF), 1, "one drop off");
    assert.strictEqual(count(tr, EV_ROOF_LAND), 0, "no re-mount");
    assert.strictEqual(count(tr, EV_TRAIN_HIT), 0, "the train leaves you behind");
  });

  it("dithering on a coupling hands over at most twice", () => {
    const t0 = 5000;
    // exactly halfway across the gap between wagon 1 and wagon 2
    const half = pose(1, t0).halfL + TRAIN_GAP / 2;
    const s = rider(1, t0, 0, -half);
    const tr = run(s, t0, 60, (st, t, i) => {
      const a = along(st.veh, t, i % 2 ? 1 : -1);
      return { mx: Math.round(a.mx * 0.2), mz: Math.round(a.mz * 0.2) };
    });
    assert.ok(count(tr, EV_COUPLE) <= 2, `handed over ${count(tr, EV_COUPLE)} times`);
    assert.strictEqual(count(tr, EV_FALL_OFF), 0);
  });

  it("dropping onto a roof from above lands on it (no snap from the apex)", () => {
    const t0 = 5000;
    const w = trainPointWorld(2, t0, 0, trainU(2, 0), { x: 0, z: 0 });
    const s: PlayerSim = { ...rider(2, t0, 0, 0), mode: Mode.Foot, veh: -1, x: w.x, z: w.z, y: 4.5, vy: 0, grounded: false };
    // match the train's velocity, as if we jumped off a wagon and are coming back down
    const p = pose(2, t0);
    s.vx = p.vx; s.vz = p.vz;
    const tr = run(s, t0, 30, () => ({}));
    const at = tr.findIndex((x) => x.ev & EV_ROOF_LAND);
    assert.ok(at > 0, "landed");
    for (let k = 1; k <= at; k++) {
      const a = tr[k - 1].s, b = tr[k].s;
      assert.ok(Math.abs(b.y - a.y) <= Math.abs(a.vy) * DT + GRAVITY * DT * DT + 0.31, `no snap at step ${k}: ${a.y} -> ${b.y}`);
    }
    assert.strictEqual(tr[at].s.mode, Mode.Train);
    assert.strictEqual(tr[at].s.ly, TRAIN_ROOF);
  });

  it("is deterministic across couplings", () => {
    const go = () => {
      const s = rider(3, 17400, 0.4, -2);
      run(s, 17400, 200, (st, t, i) => ({ ...along(st.veh, t, i % 50 < 40 ? 1 : -1), sprint: i % 3 !== 0, jump: i % 23 === 0 }));
      return JSON.stringify(s);
    };
    assert.strictEqual(go(), go());
  });

  it("the locomotive's chimney and dome are solid: a run down its middle goes round them", () => {
    for (const lx of [0, 0.3, -0.5]) {
      const s = rider(0, 9000, lx, -3);
      const tr = run(s, 9000, 70, (st, t) => ({ ...along(st.veh, t, 1), sprint: true }));
      let passed = 0;
      for (const { s: st } of tr) {
        if (st.mode !== Mode.Train) break;
        const z = carLocalZ(0, st.lz);
        for (const o of LOCO_OBSTACLES) {
          const d = Math.hypot(st.lx - o.x, z - o.z);
          assert.ok(d >= o.r + PLAYER_RADIUS - 1e-3, `inside an obstacle (r ${o.r}) by ${(o.r + PLAYER_RADIUS - d).toFixed(3)} m at lx ${st.lx.toFixed(2)}, z ${z.toFixed(2)}`);
        }
        passed = Math.max(passed, z);
      }
      assert.ok(passed > LOCO_OBSTACLES[0].z, `got past the chimney starting at lx ${lx} (reached z ${passed.toFixed(2)})`);
    }
  });

  it("train coordinates: U is metres from the nose, continuous between cars", () => {
    // car centres are CAR_OFFSETS behind the nose
    assert.strictEqual(trainU(1, 0), -CAR_OFFSETS[1]);
    assert.strictEqual(carLocalZ(1, trainU(1, 1.25)), 1.25);
    // on a straight, the end of one car and the start of the next are one gap apart in U
    const t = 5000;
    const front2 = trainPointWorld(2, t, 0, trainU(2, pose(2, t).halfL), { x: 0, z: 0 });
    const back1 = trainPointWorld(1, t, 0, trainU(1, -pose(1, t).halfL), { x: 0, z: 0 });
    assert.ok(Math.abs(Math.hypot(front2.x - back1.x, front2.z - back1.z) - TRAIN_GAP) < 1e-6);
    void wrapAngle;
  });
});
