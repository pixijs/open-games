import type { ShaderBit } from '@pixi/3d';
import {
  Container3D,
  FlatMaterial,
  Geometry3D,
  Mesh3D,
  ParticleContainer3D,
  PointLight,
  Quaternion,
  SpotLight,
  Vector3,
} from '@pixi/3d';
import { Texture } from 'pixi.js';

import { clamp } from '../MathUtils';
import type { TruckPose } from '../race/truck';
import { BODY_PIVOT, MAX_RACERS, truckPoint } from '../race/truck';
import type { LensFx } from './LensFx';
import { brakeAmount, LAMP_LAYOUTS } from './trucks/lamps';
import type { LampLayout } from './trucks/lamps';
import { BEAM_SHAPE, headlightBeamBit, headlightBeamLiteBit } from './trucks/lightBits';
import { skipToneCurve } from './toneCurve';
import { LightTrails } from './trucks/LightTrails';

const DEG_TO_RAD = Math.PI / 180;

// -- Lamps --

/** How far a lens sits proud of the body, so it never fights the modelled lamp for depth. */
const LENS_LIFT = 0.004;
const HEAD_LENS_COLOR = 0xfff6e6;
const TAIL_LENS_COLOR = 0xff2412;
/** The tail lamp's overexposed middle, so it reads as a light rather than red paint. */
const TAIL_CORE_COLOR = 0xff8f7a;
const TAIL_CORE_SIZE = 0.5;

// -- Lights --

const SPOT_COLOR = 0xffe4bc;
const SPOT_INTENSITY = 70;
const SPOT_RANGE = 18;
const SPOT_CONE = 27;
const SPOT_PENUMBRA = 0.55;
/** How far the headlight aims below level, so it lays a pool on the road ahead. */
const SPOT_PITCH = 4 * DEG_TO_RAD;
/** The spot sits this far above the lenses, for a less grazing pool on the road. */
const SPOT_LIFT = 0.12;
/**
 * A headlight dips with another truck in its beam closer than {@link DIP_FAR} metres, by the square of how far in it is
 * from {@link DIP_NEAR}, so the truck ahead is lit about as it would be at {@link DIP_FAR}, and never below
 * {@link DIP_MIN}: a full-strength pool a metre or two away bleaches the truck ahead's roof and bed to white, as on the
 * grid, where every truck stands right behind another.
 */
const DIP_NEAR = 1;
const DIP_FAR = 8;
const DIP_MIN = 0.02;
/**
 * A truck counts as in the beam within this many metres of its axis, plus this much per metre ahead, and the dip eases
 * in over {@link DIP_EDGE} metres at the beam's sides and just in front of the lamps, so it never jumps.
 */
const DIP_HALF_WIDTH = 1.1;
const DIP_SPREAD = 0.45;
const DIP_EDGE = 0.8;

const TAIL_LIGHT_COLOR = 0xff2a14;
const TAIL_LIGHT_INTENSITY = 0.1;
const TAIL_LIGHT_RANGE = 1.6;
/**
 * How far behind the tail lamps the red glow sits. Point lights cast no shadow, so it stays out of reach of the truck's
 * own bed and cab and lights only the road behind.
 */
const TAIL_LIGHT_BACK = 0.9;
/** Lamp-frame height of the red glow, high enough that the road under it gets a pool rather than a hot spot. */
const TAIL_LIGHT_Y = 0.3;

// -- Beams --

const BEAM_COLOR = 0xfff0dc;
/** Glow per unit of lit rain a view ray crosses. */
const BEAM_ALPHA = 0.35;
/** A touch below level, so the road cuts as little of the beam as it can. */
const BEAM_PITCH = 1 * DEG_TO_RAD;
const BEAM_SEGMENTS = 24;
/**
 * Screens with fewer pixels than this, at the display's resolution, sum fewer samples per beam pixel; the threshold
 * `NightLook` gates bloom at.
 */
const BEAM_FULL_PIXELS = 1.2e6;

// -- Halos and flares --

const HEAD_HALO_COLOR = 0xffe8c8;
const HEAD_HALO_SIZE = 0.42;
const HEAD_HALO_ALPHA = 0.5;
const TAIL_HALO_COLOR = 0xff2a18;
const TAIL_HALO_SIZE = 0.42;
const TAIL_HALO_ALPHA = 0.5;
/** Halos sit this far out from their lens, so a camera-facing quad clears the body panel the lens is on. */
const HALO_OUT = 0.08;
const FLARE_COLOR = 0xffe6c4;
const FLARE_INTENSITY = 1;
const FLARE_CONE = Math.cos(28 * DEG_TO_RAD);

// -- Trails --

/** Seconds of path a trail covers. */
const TRAIL_SECONDS = 0.5;
const TRAIL_SAMPLES = 30;
const TRAIL_DT = TRAIL_SECONDS / (TRAIL_SAMPLES - 1);
/** Samples back that brake lamps compare speed over. */
const BRAKE_LAG = 5;
/** Ribbons per truck: tail left, tail right, head left, head right. */
const TRAILS_PER_TRUCK = 4;
const TAIL_TRAIL_WIDTH = 0.032;
const TAIL_TRAIL_ALPHA = 0.5;
const HEAD_TRAIL_WIDTH = 0.028;
const HEAD_TRAIL_ALPHA = 0.14;
/** How much a trail narrows by its tail. */
const TRAIL_TAPER = 0.55;
const TAIL_TRAIL_RGB: readonly [number, number, number] = [1, 0.07, 0.03];
const HEAD_TRAIL_RGB: readonly [number, number, number] = [1, 0.8, 0.52];
/** A tail trail while its truck boosts: hot blue-purple. */
const BOOST_TRAIL_RGB: readonly [number, number, number] = [0.42, 0.3, 1];

const _xAxis = new Vector3(1, 0, 0);
const _yAxis = new Vector3(0, 1, 0);
const _p = new Vector3();
const _qTilt = new Quaternion();

/** One truck's lamps: the frame on its body and what hangs off it, and the path its lamps have traced. */
interface LampSet {
  readonly layout: LampLayout;
  readonly frame: Container3D;
  readonly spot: SpotLight;
  readonly tailLight: PointLight;
  /** Lenses and beams, for swapping the beam material. */
  readonly beams: Mesh3D[];
  /** Per lamp, a ring of past world positions, x y z per sample. */
  readonly paths: Float32Array[];
  /** Per sample, ground speed and whether it was boosting. */
  readonly speeds: Float32Array;
  readonly boosts: Float32Array;
  /** Ring slot of the newest sample, and how many are filled. */
  head: number;
  count: number;
  /** Seconds since the last sample was taken. */
  since: number;
}

/**
 * Headlights, tail lights and light trails on every truck in the race.
 *
 * Each truck's body gets a lamp frame, in world units, holding its glowing lenses, two soft volumetric headlight cones,
 * a headlight spot and a red tail glow, so they all pitch and roll with the body. One truck's spot, the one the camera
 * follows, casts a shadow. One mesh draws every light trail and one particle container every lamp halo; the trails
 * follow where each truck's lamps have been over the last half second.
 */
export class TruckLights {
  private readonly _fx: LensFx;
  /** World-space effects: the trails and the halos. */
  private readonly _root = new Container3D({ label: 'truck-lights' });
  private readonly _sets: (LampSet | null)[] = [];
  private readonly _discGeometry: Geometry3D;
  private readonly _quadGeometry: Geometry3D;
  private readonly _beamGeometry: Geometry3D;
  private readonly _headLensMaterial: FlatMaterial;
  private readonly _tailLensMaterial: FlatMaterial;
  private readonly _tailCoreMaterial: FlatMaterial;
  private readonly _beamMaterial: FlatMaterial;
  private readonly _beamLiteMaterial: FlatMaterial;
  private _activeBeam: FlatMaterial;
  private readonly _haloTexture: Texture;
  private readonly _halos: ParticleContainer3D;
  private readonly _trails: LightTrails;
  private _shadowSlot = -1;
  /** Headlamp strength, 0 to 1: the spots, halos and flares scale by it, and the beams show only at full. */
  private _headlamps = 1;

  /**
   * @param parent - Scene root.
   * @param fx - The lens requests.
   */
  constructor(parent: Container3D, fx: LensFx) {
    this._fx = fx;
    this._discGeometry = createDiscGeometry(16);
    this._quadGeometry = createQuadGeometry();
    this._beamGeometry = createBeamGeometry();
    this._headLensMaterial = skipToneCurve(new FlatMaterial({ baseColor: HEAD_LENS_COLOR, fog: false }));
    this._tailLensMaterial = skipToneCurve(new FlatMaterial({ baseColor: TAIL_LENS_COLOR, fog: false }));
    this._tailCoreMaterial = skipToneCurve(new FlatMaterial({ baseColor: TAIL_CORE_COLOR, fog: false }));
    this._beamMaterial = createBeamMaterial(headlightBeamBit);
    this._beamLiteMaterial = createBeamMaterial(headlightBeamLiteBit);
    this._activeBeam = this._beamMaterial;

    for (let i = 0; i < MAX_RACERS; i++) this._sets.push(null);

    this._haloTexture = createHaloTexture();
    this._halos = new ParticleContainer3D({
      texture: this._haloTexture,
      capacity: MAX_RACERS * TRAILS_PER_TRUCK,
      blendMode: 'add',
      label: 'lamp-halos',
    });
    skipToneCurve(this._halos.material);
    this._root.addChild(this._halos);
    this._trails = new LightTrails(this._root, MAX_RACERS * TRAILS_PER_TRUCK, TRAIL_SAMPLES);

    for (let i = 0; i < MAX_RACERS * TRAILS_PER_TRUCK; i++) this._trails.hide(i);

    parent.addChild(this._root);
  }

  /**
   * Hang a truck's lamps on its body.
   * @param slot - The truck's slot, 0 to 3.
   * @param color - Its colour index, which picks the lamp layout.
   * @param body - The body node; its parent scales the model, which the lamp frame undoes.
   * @param modelScale - That scale.
   */
  public attach(slot: number, color: number, body: Container3D, modelScale: number): void {
    this.detach(slot);
    this._sets[slot] = this._buildLamps(LAMP_LAYOUTS[color], body, modelScale, slot === this._shadowSlot);
  }

  /**
   * Take a truck's lamps off; its trails vanish.
   * @param slot - The truck's slot.
   */
  public detach(slot: number): void {
    const set = this._sets[slot];

    if (!set) return;

    set.frame.destroy({ children: true });
    this._sets[slot] = null;

    for (let i = 0; i < TRAILS_PER_TRUCK; i++) {
      this._trails.hide(slot * TRAILS_PER_TRUCK + i);
      this._halos.setParticleAt(slot * TRAILS_PER_TRUCK + i, 0, 0, 0, 0);
    }
  }

  /**
   * Forget where a truck's lamps have been, so a truck moved by hand doesn't streak a trail to its new place.
   * @param slot - The truck's slot.
   */
  public cut(slot: number): void {
    const set = this._sets[slot];

    if (set) set.count = 0;
  }

  /**
   * Choose the truck whose headlight casts a shadow: the one the camera follows.
   * @param slot - Its slot, or -1 for none.
   */
  public setShadowCaster(slot: number): void {
    if (slot === this._shadowSlot) return;

    this._shadowSlot = slot;

    for (let i = 0; i < this._sets.length; i++) {
      const set = this._sets[i];

      if (set) set.spot.castShadow = i === slot;
    }
  }

  /**
   * Turn every truck's headlamps down, as on the podium where the trucks face the lens, or back up.
   * @param strength - 0 (off) to 1 (full).
   */
  public setHeadlamps(strength: number): void {
    if (strength === this._headlamps) return;

    this._headlamps = strength;

    for (let i = 0; i < this._sets.length; i++) {
      const beams = this._sets[i]?.beams;

      if (beams) for (let b = 0; b < beams.length; b++) beams[b].visible = strength >= 1;
    }
  }

  /**
   * Match the screen: a small one sums fewer samples per beam pixel.
   * @param width - Screen width in CSS pixels.
   * @param height - Screen height in CSS pixels.
   * @param resolution - The display's resolution, not the renderer's, so the beams stay put while the governor steps.
   */
  public layout(width: number, height: number, resolution: number): void {
    const material =
      width * height * resolution * resolution >= BEAM_FULL_PIXELS ? this._beamMaterial : this._beamLiteMaterial;

    if (material === this._activeBeam) return;

    this._activeBeam = material;

    for (let i = 0; i < this._sets.length; i++) {
      const beams = this._sets[i]?.beams;

      if (beams) for (let b = 0; b < beams.length; b++) beams[b].material = material;
    }
  }

  /**
   * Trace the lamps and redraw the trails and halos.
   * @param dt - Seconds since the last frame.
   * @param poses - Each truck's pose by slot, or null for an empty slot.
   */
  public update(dt: number, poses: readonly (Readonly<TruckPose> | null)[]): void {
    for (let slot = 0; slot < this._sets.length; slot++) {
      const set = this._sets[slot];
      const pose = poses[slot];

      if (!set) continue;

      // A truck taken out of the race for now (a dropped player's) shows no lamps at all.
      if (!pose) {
        set.spot.intensity = 0;
        set.tailLight.intensity = 0;

        for (let i = 0; i < TRAILS_PER_TRUCK; i++) {
          this._trails.hide(slot * TRAILS_PER_TRUCK + i);
          this._halos.setParticleAt(slot * TRAILS_PER_TRUCK + i, 0, 0, 0, 0);
        }

        continue;
      }

      this._trace(set, pose, dt);
      this._draw(set, slot, pose, dip(pose, poses));
    }

    this._halos.upload();
    this._trails.upload();
  }

  public destroy(): void {
    for (let i = 0; i < this._sets.length; i++) this.detach(i);

    this._sets.length = 0;
    this._trails.destroy();
    this._root.destroy({ children: true });
    this._haloTexture.destroy(true);
    this._discGeometry.destroy();
    this._quadGeometry.destroy();
    this._beamGeometry.destroy();
    this._headLensMaterial.destroy();
    this._tailLensMaterial.destroy();
    this._tailCoreMaterial.destroy();
    this._beamMaterial.destroy();
    this._beamLiteMaterial.destroy();
  }

  /** The lamp frame on one truck's body, with its lenses, beams and lights. */
  private _buildLamps(layout: LampLayout, body: Container3D, modelScale: number, shadow: boolean): LampSet {
    const lampFrame = new Container3D({ label: 'lamps' });

    // The body sits under the model's scale; undo it so the frame is in world units.
    lampFrame.scale.set(1 / modelScale, 1 / modelScale, 1 / modelScale);
    body.addChild(lampFrame);

    const [hx, hy, hz] = layout.head;
    const [tx, ty, tz] = layout.tail;
    const beams: Mesh3D[] = [];

    for (const side of [1, -1]) {
      const head = new Mesh3D({
        geometry: layout.headRound ? this._discGeometry : this._quadGeometry,
        material: this._headLensMaterial,
        castShadow: false,
        receiveShadow: false,
      });

      head.position.set(side * hx, hy, hz + LENS_LIFT);
      head.scale.set(layout.headSize[0], layout.headSize[1], 1);
      lampFrame.addChild(head);

      const tail = new Mesh3D({
        geometry: this._quadGeometry,
        material: this._tailLensMaterial,
        castShadow: false,
        receiveShadow: false,
      });

      // The lens faces +z; turn it round to face out of the tailgate.
      tail.position.set(side * tx, ty, tz - LENS_LIFT);
      tail.rotation.set(0, Math.PI, 0);
      tail.scale.set(layout.tailSize[0], layout.tailSize[1], 1);
      lampFrame.addChild(tail);

      const core = new Mesh3D({
        geometry: this._quadGeometry,
        material: this._tailCoreMaterial,
        castShadow: false,
        receiveShadow: false,
      });

      core.position.set(side * tx, ty, tz - 2 * LENS_LIFT);
      core.rotation.set(0, Math.PI, 0);
      core.scale.set(layout.tailSize[0] * TAIL_CORE_SIZE, layout.tailSize[1] * TAIL_CORE_SIZE, 1);
      lampFrame.addChild(core);

      const beam = new Mesh3D({
        geometry: this._beamGeometry,
        material: this._activeBeam,
        castShadow: false,
        receiveShadow: false,
      });

      beam.position.set(side * hx, hy, hz);
      beam.rotation.set(BEAM_PITCH, 0, 0);
      beam.visible = this._headlamps >= 1;
      lampFrame.addChild(beam);
      beams.push(beam);
    }

    const spot = new SpotLight({
      color: SPOT_COLOR,
      intensity: SPOT_INTENSITY,
      range: SPOT_RANGE,
      coneAngle: SPOT_CONE,
      penumbra: SPOT_PENUMBRA,
      castShadow: shadow,
    });

    // A spot shines down its -z: turn it to face forward, then tip it down.
    spot.position.set(0, hy + SPOT_LIFT, hz + 0.05);
    spot.quaternion.setFromAxisAngle(_yAxis, Math.PI);
    spot.quaternion.multiply(_qTilt.setFromAxisAngle(_xAxis, -SPOT_PITCH));
    lampFrame.addChild(spot);

    const tailLight = new PointLight({
      color: TAIL_LIGHT_COLOR,
      intensity: TAIL_LIGHT_INTENSITY,
      range: TAIL_LIGHT_RANGE,
    });

    tailLight.position.set(0, TAIL_LIGHT_Y, tz - TAIL_LIGHT_BACK);
    lampFrame.addChild(tailLight);

    return {
      layout,
      frame: lampFrame,
      spot,
      tailLight,
      beams,
      paths: Array.from({ length: TRAILS_PER_TRUCK }, () => new Float32Array(TRAIL_SAMPLES * 3)),
      speeds: new Float32Array(TRAIL_SAMPLES),
      boosts: new Float32Array(TRAIL_SAMPLES),
      head: 0,
      count: 0,
      since: 0,
    };
  }

  /** Take a sample of the lamps' world positions every {@link TRAIL_DT}, into the ring. */
  private _trace(set: LampSet, pose: Readonly<TruckPose>, dt: number): void {
    set.since += dt;

    if (set.count > 0 && set.since < TRAIL_DT) return;

    set.since = set.count > 0 ? set.since % TRAIL_DT : 0;
    set.head = (set.head + 1) % TRAIL_SAMPLES;
    set.count = Math.min(TRAIL_SAMPLES, set.count + 1);

    const o = set.head * 3;
    const { head, tail } = set.layout;

    writePoint(set.paths[0], o, lampPoint(pose, tail[0], tail[1], tail[2]));
    writePoint(set.paths[1], o, lampPoint(pose, -tail[0], tail[1], tail[2]));
    writePoint(set.paths[2], o, lampPoint(pose, head[0], head[1], head[2]));
    writePoint(set.paths[3], o, lampPoint(pose, -head[0], head[1], head[2]));
    set.speeds[set.head] = pose.speed;
    set.boosts[set.head] = pose.boosting ? 1 : 0;
  }

  private _draw(set: LampSet, slot: number, pose: Readonly<TruckPose>, dipped: number): void {
    const { head: lampHead, tail: lampTail } = set.layout;
    const first = slot * TRAILS_PER_TRUCK;
    const brake = brakeAmount(this._speedAt(set, BRAKE_LAG), pose.speed, BRAKE_LAG * TRAIL_DT);

    set.tailLight.intensity = TAIL_LIGHT_INTENSITY * (1 + 1.4 * brake);
    set.spot.intensity = SPOT_INTENSITY * this._headlamps * dipped;

    // Halos stand off each lens along the body's forward axis.
    const fx = Math.sin(pose.yaw) * Math.cos(pose.pitch);
    const fy = -Math.sin(pose.pitch);
    const fz = Math.cos(pose.yaw) * Math.cos(pose.pitch);
    const tailSize = TAIL_HALO_SIZE * (1 + 0.35 * brake);
    const tailAlpha = Math.min(1, TAIL_HALO_ALPHA + 0.4 * brake);

    for (let i = 0; i < TRAILS_PER_TRUCK; i++) {
      const tail = i < 2;
      const lamp = tail ? lampTail : lampHead;
      const out = tail ? -HALO_OUT : HALO_OUT;

      lampPoint(pose, i % 2 === 0 ? lamp[0] : -lamp[0], lamp[1], lamp[2]);
      this._halos.setParticleAt(
        first + i,
        _p.x + fx * out,
        _p.y + fy * out,
        _p.z + fz * out,
        tail ? tailSize : HEAD_HALO_SIZE,
        0,
        tail ? TAIL_HALO_COLOR : HEAD_HALO_COLOR,
        tail ? tailAlpha : HEAD_HALO_ALPHA * this._headlamps,
      );
    }

    lampPoint(pose, 0, lampHead[1], lampHead[2]);
    this._fx.beam(
      _p.x,
      _p.y,
      _p.z,
      FLARE_COLOR,
      FLARE_INTENSITY * this._headlamps,
      fx,
      fy - Math.sin(SPOT_PITCH),
      fz,
      FLARE_CONE,
    );

    this._writeTrails(set, first, pose);
  }

  /** Ground speed `back` samples ago, or the oldest there is. */
  private _speedAt(set: LampSet, back: number): number {
    if (set.count === 0) return 0;

    const k = Math.min(back, set.count - 1);

    return set.speeds[(set.head - k + TRAIL_SAMPLES) % TRAIL_SAMPLES];
  }

  private _writeTrails(set: LampSet, first: number, pose: Readonly<TruckPose>): void {
    const trails = this._trails;
    const last = TRAIL_SAMPLES - 1;
    const { head, tail } = set.layout;

    for (let k = 0; k < TRAIL_SAMPLES; k++) {
      const u = k / last;
      const fade = (1 - u) * Math.sqrt(1 - u);
      const narrow = 1 - TRAIL_TAPER * u;
      // Sample 0 is the lamps now; the rest walk back through the ring, holding the oldest once it runs out.
      const ring =
        (set.head - Math.min(Math.max(k - 1, 0), Math.max(set.count - 1, 0)) + TRAIL_SAMPLES) % TRAIL_SAMPLES;
      const brake = brakeAmount(this._speedAt(set, k + BRAKE_LAG), this._speedAt(set, k), BRAKE_LAG * TRAIL_DT);
      const boost = k === 0 ? (pose.boosting ? 1 : 0) : set.boosts[ring];
      const tailR = TAIL_TRAIL_RGB[0] + (BOOST_TRAIL_RGB[0] - TAIL_TRAIL_RGB[0]) * boost;
      const tailG = TAIL_TRAIL_RGB[1] + (BOOST_TRAIL_RGB[1] - TAIL_TRAIL_RGB[1]) * boost;
      const tailB = TAIL_TRAIL_RGB[2] + (BOOST_TRAIL_RGB[2] - TAIL_TRAIL_RGB[2]) * boost;
      const tailAlpha = set.count === 0 ? 0 : TAIL_TRAIL_ALPHA * fade * (0.75 + 0.5 * brake + 0.4 * boost);
      const headAlpha = set.count === 0 ? 0 : HEAD_TRAIL_ALPHA * fade;

      for (let i = 0; i < TRAILS_PER_TRUCK; i++) {
        const isTail = i < 2;
        let x: number;
        let y: number;
        let z: number;

        if (k === 0 || set.count === 0) {
          const lamp = isTail ? tail : head;

          lampPoint(pose, i % 2 === 0 ? lamp[0] : -lamp[0], lamp[1], lamp[2]);
          x = _p.x;
          y = _p.y;
          z = _p.z;
        } else {
          const path = set.paths[i];
          const o = ring * 3;

          x = path[o];
          y = path[o + 1];
          z = path[o + 2];
        }

        trails.set(
          first + i,
          k,
          x,
          y,
          z,
          (isTail ? TAIL_TRAIL_WIDTH : HEAD_TRAIL_WIDTH) * narrow,
          isTail ? tailR : HEAD_TRAIL_RGB[0],
          isTail ? tailG : HEAD_TRAIL_RGB[1],
          isTail ? tailB : HEAD_TRAIL_RGB[2],
          isTail ? tailAlpha : headAlpha,
        );
      }
    }
  }
}

/** A point in a truck's lamp frame, in world space, into `_p`. */
function lampPoint(pose: Readonly<TruckPose>, x: number, y: number, z: number): Vector3 {
  return truckPoint(pose, x, y + BODY_PIVOT, z, _p);
}

/**
 * How strongly a truck's headlight shines: 1 with the road ahead clear, dipping as another truck comes close in its
 * beam ({@link DIP_NEAR} to {@link DIP_FAR}).
 */
function dip(pose: Readonly<TruckPose>, poses: readonly (Readonly<TruckPose> | null)[]): number {
  const fx = Math.sin(pose.yaw);
  const fz = Math.cos(pose.yaw);
  let strength = 1;

  for (let i = 0; i < poses.length; i++) {
    const other = poses[i];

    if (!other || other === pose) continue;

    const dx = other.x - pose.x;
    const dz = other.z - pose.z;
    const ahead = dx * fx + dz * fz;
    const far = clamp((ahead - DIP_NEAR) / (DIP_FAR - DIP_NEAR), 0, 1);
    const aside = clamp((Math.abs(dx * fz - dz * fx) - DIP_HALF_WIDTH - ahead * DIP_SPREAD) / DIP_EDGE, 0, 1);
    const behind = clamp(1 - ahead / DIP_EDGE, 0, 1);

    strength = Math.min(strength, Math.max(far * far, aside, behind));
  }

  return DIP_MIN + (1 - DIP_MIN) * strength;
}

function writePoint(path: Float32Array, o: number, p: Vector3): void {
  path[o] = p.x;
  path[o + 1] = p.y;
  path[o + 2] = p.z;
}

/** A unit disc in the XY plane facing +z. */
function createDiscGeometry(segments: number): Geometry3D {
  const positions = new Float32Array((segments + 1) * 3);
  const indices = new Uint16Array(segments * 3);

  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;

    positions[(i + 1) * 3] = Math.cos(a);
    positions[(i + 1) * 3 + 1] = Math.sin(a);
    indices[i * 3] = 0;
    indices[i * 3 + 1] = i + 1;
    indices[i * 3 + 2] = ((i + 1) % segments) + 1;
  }

  return new Geometry3D({ positions, indices });
}

/** A square from -1 to 1 in the XY plane facing +z. */
function createQuadGeometry(): Geometry3D {
  return new Geometry3D({
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  });
}

/**
 * The beam's cone, {@link BEAM_SHAPE}, from the lens to its far end, wound to face inward: drawn with back faces
 * culled, it shows only the far wall, so every pixel the beam covers runs the shader once.
 */
function createBeamGeometry(): Geometry3D {
  const around = BEAM_SEGMENTS + 1;
  const positions = new Float32Array(around * 2 * 3);
  const indices = new Uint16Array(BEAM_SEGMENTS * 6);

  for (let j = 0; j < 2; j++) {
    const z = j * BEAM_SHAPE.length;
    const depth = z - BEAM_SHAPE.apex;

    for (let i = 0; i < around; i++) {
      const a = (i / BEAM_SEGMENTS) * Math.PI * 2;
      const v = (j * around + i) * 3;

      positions[v] = Math.cos(a) * BEAM_SHAPE.slopeX * depth;
      positions[v + 1] = Math.sin(a) * BEAM_SHAPE.slopeY * depth;
      positions[v + 2] = z;
    }
  }

  for (let i = 0; i < BEAM_SEGMENTS; i++) {
    const k = i * 6;
    const b = i + around;

    indices[k] = i;
    indices[k + 1] = b;
    indices[k + 2] = i + 1;
    indices[k + 3] = i + 1;
    indices[k + 4] = b;
    indices[k + 5] = b + 1;
  }

  return new Geometry3D({ positions, indices });
}

/** An additive, unlit, unfogged beam material drawn by one of the beam bits. */
function createBeamMaterial(bit: ShaderBit): FlatMaterial {
  const material = skipToneCurve(
    new FlatMaterial({
      baseColor: BEAM_COLOR,
      alpha: BEAM_ALPHA,
      alphaMode: 'blend',
      fog: false,
      extraBits: [bit],
    }),
  );

  material.state.blendMode = 'add';

  return material;
}

/** A soft round glow: white, its alpha falling off from the middle. */
function createHaloTexture(): Texture {
  const size = 64;
  const canvas = document.createElement('canvas');

  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);

  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.12, 'rgba(255,255,255,0.65)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.18)');
  gradient.addColorStop(0.7, 'rgba(255,255,255,0.04)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  return Texture.from({ resource: canvas });
}
