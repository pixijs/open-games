/**
 * Car engines: a gearbox that turns how the car moves and what its driver's feet do into revs
 * and load, and a voice that makes the sound. The gearbox is plain logic (no audio), so the
 * tests can drive it. The voice runs an EngineSynth (engineSynth.ts: exhaust pulses, cylinder by
 * cylinder, down a pipe) in an AudioWorklet, through a muffler, with the tyres on the road, and
 * for other cars, distance: it's late and duller far off, so a car going by shifts in pitch.
 */
import { CAR_REVERSE_SPEED, CAR_TYPES } from "../shared/constants.js";
import type { SynthSpec } from "./engineSynth.js";

export interface EngineProfile {
  /** Where each forward gear tops out (its redline), × the car's top speed. */
  gears: number[];
  /** The redline (revolutions a minute) and the idle (× the redline). */
  redline: number;
  idle: number;
  /**
   * A manual: the clutch slips pulling away, a shift lifts off the throttle completely, and
   * braking it blips each downshift. An automatic: the torque converter holds the revs at its
   * stall speed pulling away (and on the brakes), slips a little under load, and a shift only
   * eases the throttle (`cut`) while the revs slur down.
   */
  manual: boolean;
  /** Upshift at these revs flat out, and on the lightest throttle. */
  upFull: number;
  upLight: number;
  /** Downshift below these revs: coasting or on the throttle, and braking. */
  down: number;
  downBrake: number;
  /** The revs pulling away: the clutch's slip, or the converter's stall speed. */
  launch: number;
  /** How long an upshift takes (s), and how much throttle stays on through it. */
  shift: number;
  cut: number;
  /** Chance that lifting off at high revs pops, and the most pops it makes. */
  pops: number;
  popsMax: number;
  /** The exhaust and the cylinders. */
  synth: SynthSpec;
  /** The muffler's cutoff (Hz) and the body's boom (Hz). */
  muffler: number;
  boom: number;
  level: number;
}

const I4 = [0, 0.25, 0.5, 0.75];

/**
 * One per car type (CAR_TYPES order). The gearing is a real car's, for the speeds of this town:
 * first runs to about 50 km/h, and flat out at top speed the engine is in third, well short of
 * its redline.
 */
export const ENGINES: EngineProfile[] = [
  // hatchback: a little four-cylinder, five-speed manual
  {
    gears: [0.56, 0.98, 1.4], redline: 6800, idle: 850 / 6800, manual: true,
    upFull: 0.93, upLight: 0.55, down: 0.25, downBrake: 0.4, launch: 0.45, shift: 0.22, cut: 0.2, pops: 0, popsMax: 0,
    synth: {
      fire: [0, 0.253, 0.497, 0.752], weight: [1, 0.8, 1.12, 0.88], jitterOn: 0.14, jitterOff: 0.24, wobble: 0.03,
      rise: 0.45, decay: 1.6, rasp: 0.9, raspDecay: 2.5, turb: 1.6, knock: 0, pipe: 7.5, reflect: -0.45, damp: 0.55, intake: 0.08, overrun: 0.24,
    },
    muffler: 1000, boom: 120, level: 1,
  },
  // taxi: a smooth V6 and an automatic, it has fares to think of
  {
    gears: [0.6, 1.05, 1.55], redline: 6200, idle: 700 / 6200, manual: false,
    upFull: 0.86, upLight: 0.4, down: 0.2, downBrake: 0.28, launch: 0.36, shift: 0.35, cut: 0.55, pops: 0, popsMax: 0,
    synth: {
      fire: [0, 1, 2, 3, 4, 5].map((i) => i / 6), weight: [1, 0.9, 1.06, 0.88, 1.03, 0.93], jitterOn: 0.12, jitterOff: 0.2, wobble: 0.025,
      rise: 0.5, decay: 2, rasp: 0.6, raspDecay: 2, turb: 1.4, knock: 0, pipe: 9, reflect: -0.4, damp: 0.65, intake: 0.05, overrun: 0.2,
    },
    muffler: 750, boom: 100, level: 0.95,
  },
  // pest control car: a cross-plane V8 (each bank fires unevenly: the burble), a manual, and it pops
  {
    gears: [0.55, 0.92, 1.3], redline: 6500, idle: 750 / 6500, manual: true,
    upFull: 0.93, upLight: 0.55, down: 0.25, downBrake: 0.42, launch: 0.5, shift: 0.16, cut: 0.2, pops: 0.3, popsMax: 3,
    synth: {
      // firing order 1-8-4-3-6-5-7-2: banks L R R L R L L R, the right bank's pipe a touch longer and quieter
      fire: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => i / 8 + ([0, 1, 1, 0, 1, 0, 0, 1][i] ? 0.012 : 0)),
      weight: [1, 0.84, 0.8, 1.04, 0.86, 0.97, 1.02, 0.8], jitterOn: 0.14, jitterOff: 0.3, wobble: 0.03,
      rise: 0.35, decay: 1.4, rasp: 0.8, raspDecay: 2.2, turb: 1.8, knock: 0, pipe: 6, reflect: -0.5, damp: 0.45, intake: 0.1, overrun: 0.26,
    },
    muffler: 1200, boom: 90, level: 1.05,
  },
  // ice-cream van: an old four-cylinder diesel, clattering, and an automatic
  {
    gears: [0.5, 0.9, 1.35], redline: 4300, idle: 750 / 4300, manual: false,
    upFull: 0.86, upLight: 0.4, down: 0.2, downBrake: 0.28, launch: 0.42, shift: 0.45, cut: 0.55, pops: 0, popsMax: 0,
    synth: {
      fire: I4, weight: [1, 0.85, 1.1, 0.9], jitterOn: 0.15, jitterOff: 0.16, wobble: 0.035,
      rise: 0.3, decay: 2.4, rasp: 0.6, raspDecay: 1.5, turb: 1.6, knock: 0.9, pipe: 10, reflect: -0.35, damp: 0.6, intake: 0.05, overrun: 0.3,
    },
    muffler: 900, boom: 85, level: 1.05,
  },
  // garbage truck: a big straight-six diesel, slow to rev and knocking, and a lazy automatic
  {
    gears: [0.45, 0.85, 1.45], redline: 3200, idle: 650 / 3200, manual: false,
    upFull: 0.86, upLight: 0.45, down: 0.22, downBrake: 0.3, launch: 0.4, shift: 0.55, cut: 0.6, pops: 0, popsMax: 0,
    synth: {
      fire: [0, 1, 2, 3, 4, 5].map((i) => i / 6), weight: [1, 0.9, 1.08, 0.92, 1.04, 0.9], jitterOn: 0.12, jitterOff: 0.14, wobble: 0.03,
      rise: 0.25, decay: 2.6, rasp: 0.5, raspDecay: 1.4, turb: 2, knock: 1, pipe: 12, reflect: -0.3, damp: 0.7, intake: 0.08, overrun: 0.32,
    },
    muffler: 650, boom: 70, level: 1.15,
  },
];

/** What the car and its driver do, this frame. */
export interface EngineInput {
  /** Speed along the nose (m/s, + = forward). */
  vF: number;
  /** The engine pulling: 0..1 forward, below 0 backing up. */
  drive: number;
  /** The brakes (0..1). */
  brake: number;
  handbrake: boolean;
  /** How hard the rear wheels spin or slide (0..1). */
  spin: number;
  /** In the air: the wheels turn free. */
  air: boolean;
}

/** Reverse tops out a little past the reversing speed. */
const REVERSE_TOP = CAR_REVERSE_SPEED * 1.1;
/** The starter turns the engine over this long (s) before it catches, at about 240 rpm. */
const CRANK = 0.5;
const CRANK_RPM = 240;
/** The rev limiter cuts in and out this many times a second. */
const LIMIT_HZ = 14;
/** An automatic's torque converter slips this much (× the revs left) under full load. */
const CONVERTER_SLIP = 0.12;

/**
 * Revs, load and gear from how the car moves (`step`, once a frame). Revs are 0..1 of the
 * redline. Forward gears go by the revs the wheels would give in them: up when the revs reach
 * `upFull` flat out (`upLight` on a light throttle), down as the car slows (sooner braking).
 * See EngineProfile.manual for how a manual and an automatic differ. In the air, or a manual
 * on the handbrake, the revs run free up to the limiter. Lifting off from high revs can pop.
 */
export class Gearbox {
  readonly p: EngineProfile;
  /** Speed at each forward gear's redline (m/s). */
  readonly tops: number[];
  /** −1 reverse, 1.. forward. */
  gear = 1;
  rpm: number;
  load = 0;
  /** This step: +1 shifted up, −1 down, 0 neither. */
  shifted = 0;
  /** This step: how many pops to play. */
  pops = 0;
  /** On the rev limiter. */
  limiter = false;
  /** The starter is turning it over. */
  cranking = false;
  private shiftT = 0;
  private cool = 0;
  private blipT = 0;
  private crank: number;
  /** Where in its chop the limiter is (0..1), −1 off it. */
  private limitPhase = -1;
  private lastPull = 0;
  private popAt: number[] = [];
  private time = 0;

  constructor(readonly kind: number, starting = false, private rng: () => number = Math.random) {
    this.p = ENGINES[kind] ?? ENGINES[0];
    const top = (CAR_TYPES[kind] ?? CAR_TYPES[0]).maxSpeed;
    this.tops = this.p.gears.map((g) => g * top);
    this.crank = starting ? CRANK : 0;
    this.rpm = starting ? 0 : this.p.idle;
  }

  /** The revs with the wheels at `v` m/s in gear `g` (1 = the redline; it can be past it). */
  wheelRpm(g: number, v: number) {
    return g < 0 ? v / REVERSE_TOP : v / this.tops[g - 1];
  }

  step(dt: number, i: EngineInput): this {
    const p = this.p;
    this.time += dt;
    this.shifted = 0;
    this.pops = 0;
    this.limiter = false;
    const v = Math.abs(i.vF);
    // (never into reverse rolling forward: a pedal that says so for a frame is the brakes)
    const back = i.drive < 0 && i.vF < 1;
    const thr = Math.min(1, Math.max(0, i.drive)), pull = back ? Math.min(1, -i.drive) : thr;
    this.cool = Math.max(0, this.cool - dt);

    // the starter turns it over (each compression slows it), then it catches with a flare (at
    // once if we're already going)
    if (this.crank > 0) {
      this.crank = pull > 0 || v > 1 ? 0 : this.crank - dt;
      this.cranking = this.crank > 0;
      if (this.cranking) {
        this.rpm = (CRANK_RPM / p.redline) * (1 + 0.15 * Math.sin(this.time * 2 * Math.PI * 8));
        this.load = 0;
        return this;
      }
      this.rpm = Math.max(this.rpm, Math.min(0.3, 1.9 * p.idle));
      this.blipT = 0.12;
    }

    // the gear: reverse backing up; forward, by the revs the wheels would give
    const n = this.tops.length;
    if (back || (this.gear < 0 && i.vF < -0.3)) this.gear = -1;
    else {
      if (this.gear < 0) this.gear = 1;
      // (all but stopped: straight back to first)
      if (this.gear > 1 && v < 1.5) { this.gear = 1; this.shifted = -1; }
      if (!i.air) {
        // never over the redline: a shove (a crash, a train) moves it up quietly
        while (thr < 0.1 && this.gear < n && this.wheelRpm(this.gear, v) > 1.02) this.gear++;
        const w = this.wheelRpm(this.gear, v), up = p.upLight + (p.upFull - p.upLight) * thr;
        if (this.cool <= 0) {
          // (up when you hear it get there, as long as it's the wheels and not wheelspin)
          if (thr > 0.1 && this.gear < n && this.rpm > up && w > up - 0.12) {
            this.gear++;
            this.shifted = 1;
            this.shiftT = p.shift;
            this.cool = p.shift + 0.25;
            // (a flat-out shift barks, sometimes: the more it pops, the more often)
            if (thr > 0.8 && this.rng() < p.pops * 0.4) this.popAt.push(this.time + p.shift * 0.4);
          } else if (this.gear > 1 && w < (i.brake > 0 ? p.downBrake : p.down)) {
            this.gear--;
            this.shifted = -1;
            this.cool = 0.18;
            if (i.brake > 0 && p.manual) this.blipT = 0.09;
          }
        }
      }
    }

    // where the revs want to be: free (in the air, or a manual on the handbrake with the
    // throttle), or held by the wheels, with the clutch or the converter slipping pulling away
    // and the tyres spinning up. An automatic held on the handbrake sits at its stall speed.
    const free = i.air || (i.handbrake && pull > 0 && p.manual);
    let target: number;
    if (free) target = pull > 0 ? 1.05 : p.idle;
    else if (i.handbrake && pull > 0) target = Math.max(this.wheelRpm(this.gear, v), p.launch * pull);
    else {
      const w = this.wheelRpm(this.gear, v);
      target = Math.max(p.idle, w);
      if (!p.manual && pull > 0) target += CONVERTER_SLIP * pull * Math.max(0, 1 - w);
      if (Math.abs(this.gear) === 1 && pull > 0) target = Math.max(target, p.launch * (p.manual ? 0.8 + 0.2 * pull : pull));
      target += 0.35 * i.spin * thr;
    }
    if (this.blipT > 0) target += 0.12;
    // (a manual's revs drop fast as the clutch goes in; an automatic's slur down through the shift)
    const tau = free ? (target > this.rpm ? 0.3 : 0.45)
      : this.shiftT > 0 ? p.shift * (p.manual ? 0.25 : 0.45)
      : target > this.rpm ? 0.03 : 0.06;
    this.rpm += (target - this.rpm) * (1 - Math.exp(-dt / tau));

    // load: the throttle, eased (or cut) through an upshift; a downshift's blip; the limiter chopping it
    let load = pull;
    if (this.shiftT > 0) { this.shiftT -= dt; load = pull * p.cut; }
    if (this.blipT > 0) { this.blipT -= dt; load = Math.max(load, 0.65); }
    if (pull > 0 && target >= 1 && (this.limitPhase >= 0 || this.rpm >= 0.985)) {
      this.limiter = true;
      this.limitPhase = (Math.max(0, this.limitPhase) + dt * LIMIT_HZ) % 1;
      const cut = this.limitPhase < 0.45;
      this.rpm = cut ? 0.965 : 1;
      if (cut) load = 0;
    } else this.limitPhase = -1;
    this.rpm = Math.min(1, Math.max(0, this.rpm));
    this.load = load;

    // lifting off from high revs: a few pops out of the exhaust
    if (this.lastPull > 0.5 && pull < 0.1 && this.rpm > 0.5 && p.popsMax > 0 && this.rng() < p.pops) {
      const k = 1 + Math.floor(this.rng() * p.popsMax);
      let t = this.time + 0.04;
      for (let j = 0; j < k; j++, t += 0.05 + this.rng() * 0.12) this.popAt.push(t);
    }
    this.lastPull = pull;
    if (this.popAt.length) {
      const due = this.popAt.filter((t) => t <= this.time);
      this.pops = due.length;
      if (due.length) this.popAt = this.popAt.filter((t) => t > this.time);
    }
    return this;
  }
}

/** The engine's level, and the tyres' on the road at top speed. */
const GAIN = 1;
const ROAD = 0.05;
/** Idling, the engine burns this much fuel (× full throttle), less as the revs rise off idle. */
const IDLE_FUEL = 0.38;
/** Speed of sound (m/s): a car's sound is this late reaching us. */
const SOUND_SPEED = 343;

/**
 * An engine's sound: the gearbox's revs and load drive an EngineSynth (in the "engine"
 * AudioWorklet, which must be loaded first), through the muffler and the body's boom. With it, the
 * tyres' roar on the road, and a whine for the reverse gear (and the starter motor). Then the
 * distance to us: a delay (its change is the Doppler shift of a car going by) and the air
 * dulling the highs.
 */
export class EngineVoice {
  private node: AudioWorkletNode;
  private rpm: AudioParam;
  private fuel: AudioParam;
  private muffler: BiquadFilterNode;
  private muffler2: BiquadFilterNode;
  private road: AudioBufferSourceNode;
  private roadBand: BiquadFilterNode;
  private roadGain: GainNode;
  private whine: OscillatorNode;
  private whineGain: GainNode;
  private delay: DelayNode;
  private air: BiquadFilterNode;
  private out: GainNode;
  private lastFuel = 0;
  private placed = false;
  private stopped = false;

  constructor(private ctx: BaseAudioContext, noise: AudioBuffer, dest: AudioNode, readonly p: EngineProfile, seed = (Math.random() * 2 ** 32) >>> 0) {
    const c = ctx, t = c.currentTime;
    this.node = new AudioWorkletNode(c, "engine", {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { spec: p.synth, seed },
    });
    this.rpm = this.node.parameters.get("rpm")!;
    this.fuel = this.node.parameters.get("fuel")!;
    // the tone through the muffler (steep: four poles), with the body's boom; the noise only
    // trimmed at both ends
    const split = c.createChannelSplitter(2);
    this.node.connect(split);
    this.muffler = c.createBiquadFilter();
    this.muffler.type = "lowpass";
    this.muffler.frequency.value = p.muffler;
    this.muffler.Q.value = 0.55;
    this.muffler2 = c.createBiquadFilter();
    this.muffler2.type = "lowpass";
    this.muffler2.frequency.value = p.muffler;
    this.muffler2.Q.value = 1.3;
    const boom = c.createBiquadFilter();
    boom.type = "peaking";
    boom.frequency.value = p.boom;
    boom.Q.value = 1.2;
    boom.gain.value = 4;
    const engine = c.createGain();
    engine.gain.value = GAIN * p.level;
    split.connect(this.muffler, 0).connect(this.muffler2).connect(boom).connect(engine);
    const hiss = c.createBiquadFilter();
    hiss.type = "bandpass";
    hiss.frequency.value = 1600;
    hiss.Q.value = 0.35;
    split.connect(hiss, 1).connect(engine);

    this.road = c.createBufferSource();
    this.road.buffer = noise;
    this.road.loop = true;
    this.roadBand = c.createBiquadFilter();
    this.roadBand.type = "bandpass";
    this.roadBand.Q.value = 0.7;
    this.roadBand.frequency.value = 700;
    this.roadGain = c.createGain();
    this.roadGain.gain.value = 0;

    this.whine = c.createOscillator();
    this.whine.type = "triangle";
    this.whine.frequency.value = 300;
    this.whineGain = c.createGain();
    this.whineGain.gain.value = 0;

    const mix = c.createGain();
    this.delay = c.createDelay(0.4);
    this.air = c.createBiquadFilter();
    this.air.type = "lowpass";
    this.air.frequency.value = 20000;
    this.out = c.createGain();
    this.out.gain.value = 0;
    engine.connect(mix);
    this.road.connect(this.roadBand).connect(this.roadGain).connect(mix);
    this.whine.connect(this.whineGain).connect(mix);
    mix.connect(this.delay).connect(this.air).connect(this.out).connect(dest);
    this.road.start(t, Math.random() * noise.duration);
    this.whine.start(t);
  }

  /** Sound the gearbox's revs and load, at `vol` (1 = right here), the car going `vF` m/s, `dist` m from us. */
  set(b: Gearbox, vF: number, vol: number, dist = 0) {
    if (this.stopped) return;
    const p = this.p, t = this.ctx.currentTime;
    // idling, the idle control feeds it a little fuel; off the throttle above that, none (engine braking)
    const nearIdle = Math.min(1, Math.max(0, (p.idle * 1.6 - b.rpm) / (p.idle * 0.6)));
    const fuel = b.cranking ? 0.03 : Math.max(b.load, IDLE_FUEL * nearIdle);
    this.rpm.setTargetAtTime(b.rpm * p.redline, t, 0.015);
    // (fuel dropping, a shift or the limiter or lifting off, cuts in sharply)
    this.fuel.setTargetAtTime(fuel, t, fuel < this.lastFuel ? 0.008 : 0.025);
    this.lastFuel = fuel;
    const cutoff = p.muffler * (0.55 + 0.35 * fuel + 0.3 * b.rpm);
    this.muffler.frequency.setTargetAtTime(cutoff, t, 0.03);
    this.muffler2.frequency.setTargetAtTime(cutoff, t, 0.03);
    const speed = Math.abs(vF);
    this.roadGain.gain.setTargetAtTime(ROAD * Math.min(1.3, speed / 25) ** 1.5, t, 0.1);
    this.roadBand.frequency.setTargetAtTime(500 + 20 * speed, t, 0.1);
    // the reverse gear's whine, rising with speed; or the starter motor's, slowing on each compression
    const whine = b.cranking ? 1 : b.gear < 0 ? Math.min(1, speed / 2) : 0;
    this.whine.frequency.setTargetAtTime(b.cranking ? 260 * (b.rpm * p.redline / CRANK_RPM) : 150 + 115 * speed, t, 0.02);
    this.whineGain.gain.setTargetAtTime(0.012 * whine, t, 0.06);
    // the distance: late by the time sound takes to get here (a car closing in sounds higher,
    // one going away lower), and duller far off
    if (!this.placed) {
      this.delay.delayTime.value = dist / SOUND_SPEED;
      this.out.gain.setTargetAtTime(vol, t, 0.05);
      this.placed = true;
    } else {
      this.delay.delayTime.setTargetAtTime(Math.min(0.39, dist / SOUND_SPEED), t, 0.05);
      this.out.gain.setTargetAtTime(vol, t, 0.05);
    }
    this.air.frequency.setTargetAtTime(Math.max(2500, 20000 / (1 + dist / 14)), t, 0.1);
  }

  /** An afterfire out of the exhaust. */
  pop() {
    if (!this.stopped) this.node.port.postMessage("pop");
  }

  /** Fade out, then stop and let go of the nodes. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.06);
    this.node.port.postMessage({ stop: 0.5 });
    this.road.stop(t + 0.5);
    this.whine.stop(t + 0.5);
    this.road.onended = () => { this.node.disconnect(); this.out.disconnect(); };
  }
}
