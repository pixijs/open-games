import assert from "assert";
import { ENGINES, Gearbox, type EngineInput } from "../src/client/EngineSound.ts";
import { EngineSynth } from "../src/client/engineSynth.ts";
import { CAR_TYPES, CarLight, Mode, TICK_RATE } from "../src/shared/constants.ts";
import { carLights, stepPlayer, type InputLike, type PlayerSim, type SimCtx, type WorldView } from "../src/shared/sim.ts";

/** The gearbox, fed by the shared driving step: what the engine does on the real car's speeds. */
describe("engine sound: the gearbox", () => {
  /** Drawn frames per sim step (the game steps the gearbox once a frame, at about 60 fps). */
  const FRAMES = 2;
  const FRAME = 1 / (TICK_RATE * FRAMES);
  // the open ground the driving tests use; the car is put back on it after every step, so the
  // road never ends
  const X0 = 104, Z0 = 124;
  const fresh = (speed = 0, yaw = Math.PI / 2): PlayerSim => ({
    x: X0, y: 0, z: Z0, vx: Math.sin(yaw) * speed, vy: 0, vz: Math.cos(yaw) * speed, yaw, mode: Mode.Driving, veh: 1,
    lx: 0, ly: 0, lz: 0, lyaw: 0, steer: 0, yawRate: 0, grounded: true, weapon: 0,
    ammo1: 0, ammo2: 0, ammo3: 0, ammo4: 0, cd: 0, timer: 0, zoomies: 0, charge: 0, coyote: 0, stench: 0,
  });
  const pedal = (throttle: number, handbrake = false): InputLike => ({
    mx: 0, mz: 0, throttle: throttle * 100, steer: 0, aim: 0, fire: false, jump: handbrake,
    sprint: false, use: false, weapon: 0,
  });
  const forward = (p: PlayerSim) => p.vx * Math.sin(p.yaw) + p.vz * Math.cos(p.yaw);
  /** A seeded random, so the pops are the same every run. */
  const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  interface Frame { t: number; v: number; gear: number; rpm: number; load: number; shifted: number; pops: number; limiter: boolean }
  let time = 0;
  /** Drive `p` for `sec` with `cmd`, reading the pedals the way Game does for our own car. */
  function drive(kind: number, box: Gearbox, p: PlayerSim, cmd: InputLike, sec: number, log: Frame[] = []) {
    const world: WorldView = { cars: () => [], car: () => null, carKind: () => kind, pickup: () => null, bin: () => -1, poles: () => [], npcs: () => [], manhole: () => null, snatch: () => null };
    const t0 = log.length ? log[log.length - 1].t : 0;
    for (let i = 0; i < Math.round(sec * TICK_RATE); i++) {
      const ctx: SimCtx = { dt: 1 / TICK_RATE, time: (time += 33), memo: (_k, f) => f() };
      stepPlayer(ctx, p, cmd, world);
      p.x = X0; p.z = Z0;
      const lights = carLights(p, cmd), braking = !!(lights & CarLight.Brake);
      const input: EngineInput = {
        vF: forward(p), drive: braking ? 0 : cmd.throttle / 100, brake: braking ? 1 : 0, handbrake: cmd.jump, spin: 0, air: false,
      };
      for (let f = 0; f < FRAMES; f++) {
        box.step(FRAME, input);
        const { gear, rpm, load, shifted, pops, limiter } = box;
        log.push({ t: t0 + (i * FRAMES + f + 1) * FRAME, v: input.vF, gear, rpm, load, shifted, pops, limiter });
      }
    }
    return log;
  }
  const shifts = (log: Frame[]) => log.filter((f) => f.shifted !== 0);
  const fmt = (log: Frame[]) => shifts(log).map((f) => `${f.shifted > 0 ? "↑" : "↓"}${f.gear}@${f.t.toFixed(2)}s/${f.v.toFixed(1)}m/s`).join(" ");

  for (const [kind, type] of CAR_TYPES.entries()) {
    const n = ENGINES[kind].gears.length;

    const eng = ENGINES[kind];
    it(`${type.name}: flat out from a standstill climbs through all ${n} gears once each, easing off and dropping at every shift`, () => {
      const box = new Gearbox(kind);
      const log = drive(kind, box, fresh(), pedal(1), 8);
      const ups = shifts(log);
      assert.deepStrictEqual(ups.map((f) => f.gear), Array.from({ length: n - 1 }, (_, i) => i + 2), fmt(log));
      assert.ok(ups.every((f) => f.shifted === 1), fmt(log));
      // pulling away, the clutch slips (or the converter holds its stall speed): the revs flare at once
      const launch = log.find((f) => f.t >= 0.15)!;
      assert.ok(launch.rpm > eng.launch - 0.05, `revs ${launch.rpm.toFixed(2)} at 0.15 s`);
      for (const s of ups) {
        const i = log.indexOf(s), before = log[i - 1].rpm;
        assert.ok(before > eng.upFull - 0.05, `shifted into ${s.gear} at revs ${before.toFixed(2)}`);
        assert.ok(Math.abs(s.load - eng.cut) < 1e-9, `the throttle eases to ${eng.cut} shifting into ${s.gear} (${s.load})`);
        // (the wheels keep gaining through the cut, so it lands a little above the ratio's drop)
        const after = Math.min(...log.slice(i, i + Math.ceil(ENGINES[kind].shift / FRAME) + 2).map((f) => f.rpm));
        assert.ok(after < before - 0.15, `revs ${before.toFixed(2)} → ${after.toFixed(2)} shifting into ${s.gear}`);
      }
      // top gear at top speed: pulling hard, well short of the redline (as a real car at that speed)
      const end = log[log.length - 1];
      assert.strictEqual(end.gear, n);
      assert.ok(end.rpm > 0.55 && end.rpm < 0.85, `revs ${end.rpm.toFixed(2)} at ${end.v.toFixed(1)} m/s`);
      assert.ok(!log.some((f) => f.limiter), "never on the limiter");
      assert.ok(log.every((f) => f.rpm <= 1));
    });

    it(`${type.name}: a light throttle shifts earlier, and only ever up; cruising holds its gear`, () => {
      const box = new Gearbox(kind);
      const p = fresh();
      const log = drive(kind, box, p, pedal(0.4), 14);
      assert.ok(shifts(log).every((f) => f.shifted === 1), fmt(log));
      for (const s of shifts(log)) {
        const before = log[log.indexOf(s) - 1].rpm;
        assert.ok(before < 0.8, `shifted into ${s.gear} at revs ${before.toFixed(2)}`);
      }
      // up to top speed, then 10 s more of it
      drive(kind, box, p, pedal(1), 8);
      const cruise = drive(kind, box, p, pedal(1), 10);
      assert.strictEqual(shifts(cruise).length, 0, `cruising: ${fmt(cruise)}`);
      assert.strictEqual(box.gear, n);
    });

    it(`${type.name}: tapping the gas never hunts between gears`, () => {
      const box = new Gearbox(kind);
      const p = fresh(0.45 * type.maxSpeed);
      const log: Frame[] = [];
      for (let i = 0; i < 12; i++) drive(kind, box, p, pedal(i % 2 ? 0 : 1), 0.5, log);
      const s = shifts(log);
      for (let i = 2; i < s.length; i++) {
        const back = s[i].shifted !== s[i - 1].shifted && s[i - 1].shifted !== s[i - 2].shifted;
        assert.ok(!back || s[i].t - s[i - 2].t > 1.5, `hunting: ${fmt(log)}`);
      }
    });

    it(`${type.name}: braking from top speed shifts down one gear at a time to first${eng.manual ? ", blipping" : " (no blips: an automatic)"}`, () => {
      const box = new Gearbox(kind);
      const p = fresh();
      drive(kind, box, p, pedal(1), 8);
      assert.strictEqual(box.gear, n);
      const log = drive(kind, box, p, pedal(-1), 1.5);
      const downs = shifts(log).filter((f) => f.v > 0.3);
      assert.deepStrictEqual(downs.map((f) => f.gear), Array.from({ length: n - 1 }, (_, i) => n - 1 - i), fmt(log));
      assert.ok(downs.every((f) => f.shifted === -1), fmt(log));
      // a manual blips the throttle on each downshift, with the pedal off (not the drop to first, all but stopped)
      for (const d of downs.filter((f) => f.v > 1.5)) {
        const i = log.indexOf(d);
        assert.strictEqual(log.slice(i, i + 4).some((f) => f.load > 0.5), eng.manual, `a blip shifting into ${d.gear}`);
      }
    });

    it(`${type.name}: S held through the hold backs up in reverse gear, the revs rising with speed`, () => {
      const box = new Gearbox(kind);
      const log = drive(kind, box, fresh(), pedal(-1), 2.5);
      const end = log[log.length - 1];
      assert.ok(end.v < -5, `backing up at ${end.v.toFixed(1)} m/s`);
      assert.strictEqual(end.gear, -1);
      assert.ok(end.rpm > 0.55, `revs ${end.rpm.toFixed(2)}`);
    });
  }

  it("a pedal asking for reverse while rolling forward fast is the brakes: no reverse gear, no load", () => {
    const box = new Gearbox(0);
    const cruise: EngineInput = { vF: 22, drive: 1, brake: 0, handbrake: false, spin: 0, air: false };
    for (let t = 0; t < 3; t += FRAME) box.step(FRAME, cruise);
    const gear = box.gear, rpm = box.rpm;
    box.step(FRAME, { ...cruise, drive: -1 });
    assert.strictEqual(box.gear, gear);
    assert.strictEqual(box.load, 0);
    assert.ok(box.rpm <= rpm + 0.01, `revs ${rpm.toFixed(2)} → ${box.rpm.toFixed(2)}`);
  });

  it("lifting off from high revs pops in the pest control car, sometimes; never in the others", () => {
    const count = (kind: number) => {
      const box = new Gearbox(kind, false, seeded(7));
      let pops = 0;
      for (let i = 0; i < 40; i++) {
        for (let t = 0; t < 0.5; t += FRAME) pops += box.step(FRAME, { vF: 15, drive: 1, brake: 0, handbrake: false, spin: 0, air: false }).pops;
        assert.ok(box.rpm > 0.55, `revs ${box.rpm.toFixed(2)} before lifting`);
        for (let t = 0; t < 0.6; t += FRAME) pops += box.step(FRAME, { vF: 15, drive: 0, brake: 0, handbrake: false, spin: 0, air: false }).pops;
      }
      return pops;
    };
    const pest = count(2);
    assert.ok(pest >= 8, `pest control car: ${pest} pops in 40 lifts`);
    for (const kind of [0, 1, 3]) assert.strictEqual(count(kind), 0, CAR_TYPES[kind].name);
  });

  it("in the air, or a manual on the handbrake, the gas revs it to the limiter, which chops the load", () => {
    for (const [air, handbrake, vF] of [[true, false, 12], [false, true, 0]] as const) {
      const box = new Gearbox(0);
      const log: { rpm: number; load: number; limiter: boolean }[] = [];
      for (let t = 0; t < 2; t += FRAME) {
        const { rpm, load, limiter } = box.step(FRAME, { vF, drive: 1, brake: 0, handbrake, spin: 0, air });
        log.push({ rpm, load, limiter });
      }
      const on = log.findIndex((f) => f.limiter);
      assert.ok(on > 0 && on * FRAME < 1.2, `on the limiter at ${(on * FRAME).toFixed(2)} s (air ${air})`);
      const after = log.slice(on);
      assert.ok(after.every((f) => f.limiter && f.rpm <= 1 && f.rpm > 0.95));
      assert.ok(after.some((f) => f.load === 0) && after.some((f) => f.load === 1), "the load chops");
      // let go: back down to idle
      for (let t = 0; t < 2; t += FRAME) box.step(FRAME, { vF, drive: 0, brake: 0, handbrake, spin: 0, air });
      assert.ok(Math.abs(box.rpm - ENGINES[0].idle) < 0.03 || !air, `revs ${box.rpm.toFixed(2)} after letting go`);
    }
  });

  it("an automatic held on the handbrake with the gas sits at its stall speed", () => {
    const box = new Gearbox(1);
    for (let t = 0; t < 2; t += FRAME) {
      box.step(FRAME, { vF: 0, drive: 1, brake: 0, handbrake: true, spin: 0, air: false });
      assert.ok(!box.limiter);
    }
    assert.ok(Math.abs(box.rpm - ENGINES[1].launch) < 0.02, `revs ${box.rpm.toFixed(2)}`);
  });

  it("our engine starts up: the starter turns it over, it catches above idle and settles; the gas cuts the starter short", () => {
    const still: EngineInput = { vF: 0, drive: 0, brake: 0, handbrake: false, spin: 0, air: false };
    const box = new Gearbox(0, true);
    let t = 0;
    for (; t < 0.3; t += FRAME) {
      box.step(FRAME, still);
      assert.ok(box.cranking && box.rpm < 0.12, `cranking at ${t.toFixed(2)} s, revs ${box.rpm.toFixed(2)}`);
    }
    let peak = 0;
    for (; t < 0.8; t += FRAME) peak = Math.max(peak, box.step(FRAME, still).rpm);
    assert.ok(!box.cranking && peak > ENGINES[0].idle + 0.08, `caught, peak revs ${peak.toFixed(2)}`);
    for (; t < 1.5; t += FRAME) box.step(FRAME, still);
    assert.ok(Math.abs(box.rpm - ENGINES[0].idle) < 0.02, `idling at ${box.rpm.toFixed(2)}`);

    const eager = new Gearbox(0, true);
    eager.step(FRAME, still);
    eager.step(FRAME, { ...still, drive: 1 });
    assert.ok(!eager.cranking && eager.rpm > 0.3, `the gas catches it at once (revs ${eager.rpm.toFixed(2)})`);
  });
});

/** The engine's sound itself, as the AudioWorklet runs it: exhaust pulses, cylinder by cylinder, down a pipe. */
describe("engine sound: the synth", () => {
  const SR = 48000;
  function render(kind: number, rpm: number, fuel: number, sec: number, seed = 3) {
    const synth = new EngineSynth(ENGINES[kind].synth, SR, seed);
    const out = new Float32Array(Math.round(sec * SR)), block = new Float32Array(128);
    for (let i = 0; i + 128 <= out.length; i += 128) {
      synth.render(block, rpm, fuel);
      out.set(block, i);
    }
    return out;
  }
  const rmsDb = (x: Float32Array) => 10 * Math.log10(x.reduce((a, v) => a + v * v, 0) / x.length);
  /** The strongest partial between lo and hi Hz (a plain DFT, 1 Hz apart, over the last second). */
  function strongest(x: Float32Array, lo: number, hi: number) {
    const seg = x.subarray(x.length - SR);
    let best = 0, at = 0;
    for (let f = Math.round(lo); f <= hi; f++) {
      let re = 0, im = 0;
      for (let i = 0; i < seg.length; i += 2) { const a = (2 * Math.PI * f * i) / SR; re += seg[i] * Math.cos(a); im += seg[i] * Math.sin(a); }
      const m = re * re + im * im;
      if (m > best) { best = m; at = f; }
    }
    return at;
  }

  for (const [kind, type] of CAR_TYPES.entries()) {
    const p = ENGINES[kind], cyl = p.synth.fire.length;
    it(`${type.name}: fires ${cyl} times every two turns, and stays bounded from idle to the redline, on and off the throttle`, () => {
      const rpm = 0.5 * p.redline, firing = (rpm / 120) * cyl;
      const heard = strongest(render(kind, rpm, 1, 2), firing * 0.7, firing * 1.3);
      assert.ok(Math.abs(heard - firing) <= 2, `firing at ${firing.toFixed(1)} Hz, strongest at ${heard} Hz`);
      for (const r of [0, p.idle * p.redline, p.redline]) {
        for (const fuel of [0, 0.4, 1]) {
          const x = render(kind, r, fuel, 0.5);
          assert.ok(x.every((v) => Number.isFinite(v) && Math.abs(v) < 1.5), `${r} rpm, fuel ${fuel}`);
        }
      }
    });

    it(`${type.name}: the throttle makes it much louder; no two cycles quite alike`, () => {
      const rpm = 0.6 * p.redline;
      const on = rmsDb(render(kind, rpm, 1, 1)), off = rmsDb(render(kind, rpm, 0, 1));
      assert.ok(on - off > 8, `${on.toFixed(1)} dB flat out, ${off.toFixed(1)} dB off the throttle`);
      // one engine cycle (two turns) against the next: alike, but never the same
      const x = render(kind, rpm, 1, 1.2), n = Math.round((SR * 120) / rpm);
      let most = 0, sum = 0;
      for (let c = 0; c < 10; c++) {
        const a = x.subarray(SR / 2 + c * n, SR / 2 + (c + 1) * n), b = x.subarray(SR / 2 + (c + 1) * n, SR / 2 + (c + 2) * n);
        let ab = 0, aa = 0, bb = 0;
        for (let i = 0; i < n; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
        const r = ab / Math.sqrt(aa * bb);
        most = Math.max(most, r);
        sum += r;
      }
      assert.ok(most < 0.97 && sum / 10 > 0.2, `cycle to cycle correlation: mean ${(sum / 10).toFixed(2)}, most ${most.toFixed(2)}`);
    });
  }

  it("the same seed renders the same sound; another seed, another", () => {
    const a = render(0, 3000, 1, 0.3, 5), b = render(0, 3000, 1, 0.3, 5), c = render(0, 3000, 1, 0.3, 6);
    assert.deepStrictEqual(a, b);
    assert.notDeepStrictEqual(a, c);
  });

  it("an afterfire bangs out of the exhaust within 40 ms", () => {
    const synth = new EngineSynth(ENGINES[2].synth, SR, 9), block = new Float32Array(128);
    const loudest = () => { let m = 0; for (let i = 0; i < 30; i++) { synth.render(block, 4000, 0); for (const v of block) m = Math.max(m, Math.abs(v)); } return m; };
    loudest();
    const before = loudest();
    synth.pop();
    const after = loudest();
    assert.ok(after > 2 * before, `${before.toFixed(3)} → ${after.toFixed(3)}`);
  });
});
