import type { FlatMaterialOptions, Geometry3D, ShaderBit } from '@pixi/3d';
import { Container3D, FlatMaterial, Material3D, Mesh3D, SpotLight, Sprite3D, Vector3 } from '@pixi/3d';
import { Texture } from 'pixi.js';

import type { Occluders } from '../../Occluders';
import type { Route } from '../../race/route';
import { ROAD_Y } from '../../race/route';
import type { TowerSpec } from '../../track/plan';
import { BANK_OFFSET, LAMP_CONE, LAMP_INTENSITY, LAMP_PENUMBRA, LAMP_RANGE } from '../../track/plan';
import type { LensFx } from '../LensFx';
import { skipToneCurve } from '../toneCurve';
import { LampPool, RANK_INTERVAL } from './LampPool';
import { ShapeBuilder } from './ShapeBuilder';

const LAMP_COLOR = 0xffe2b8;
/** Seconds a lamp takes to fade out before it moves to another tower, and to fade in there. */
const LAMP_FADE = 0.5;

/** The lamp bank: a grid of lamps on a panel, in a housing set back behind it. */
const BANK_HALF_WIDTH = 1.15;
const BANK_HALF_HEIGHT = 0.62;
const BANK_COLUMNS = 4;
const BANK_ROWS = 2;
const HOUSING_DEPTH = 0.18;
const POLE_RADIUS = 0.14;

/** How far down its throw a light shaft fades out, and its radius there. */
const BEAM_REACH = 0.82;
const BEAM_SPREAD = 0.34;
const BEAM_COLOR = 0xc49663;

const HALO_SIZE = 7;
const HALO_COLOR = 0xffc98a;

/** Lens flares fade out as the camera's subject, and so the camera, gets this far from a tower. */
const FLARE_NEAR = 12;
const FLARE_FAR = 46;
const FLARE_INTENSITY = 0.85;
/** Cosine of the half-angle inside which a tower flares the lens. */
const FLARE_CONE = Math.cos((62 * Math.PI) / 180);

const BEAM_GPU = /*wgsl*/ `
  let beamEye = camera.uCameraPosition - input.vPosition;
  let beamFacing = abs(dot(normal, normalize(beamEye)));
  let beamAlong = input.vUV.y;

  // Faint rays fanning out from the lamps, the way rain catches the light.
  let beamRays = 0.7 + 0.3 * sin(input.vUV.x * 75.4 + beamAlong * 2.0) * sin(input.vUV.x * 31.4 - 1.3);

  alpha *= beamFacing * beamFacing * beamRays
    * smoothstep(0.0, 0.1, beamAlong) * pow(1.0 - beamAlong, 1.8)
    * smoothstep(0.4, 3.0, length(beamEye));
`;

const BEAM_GL = /*glsl*/ `
  vec3 beamEye = uCameraPosition - vPosition;
  float beamFacing = abs(dot(normal, normalize(beamEye)));
  float beamAlong = vUV.y;

  float beamRays = 0.7 + 0.3 * sin(vUV.x * 75.4 + beamAlong * 2.0) * sin(vUV.x * 31.4 - 1.3);

  alpha *= beamFacing * beamFacing * beamRays
    * smoothstep(0.0, 0.1, beamAlong) * pow(1.0 - beamAlong, 1.8)
    * smoothstep(0.4, 3.0, length(beamEye));
`;

/**
 * A soft light shaft: brightest where the cone faces the eye, fading at its silhouette so it never reads as a solid
 * slab, fading in from the lamp and out down its throw, and away as the camera comes close enough to clip it.
 */
const beamBit: ShaderBit = {
  name: 'racing-light-shaft',
  gpu: { fragment: { material: BEAM_GPU } },
  gl: { fragment: { material: BEAM_GL } },
};

const _foot = new Vector3();
const _aim = new Vector3();
const _focus = new Vector3();

/**
 * A floodlight's lamp, dark until {@link Floodlights} puts it on a tower. The set makes its lamps once, so the lights
 * keep their place in the view's light list whatever track is built.
 * @returns The light, off.
 */
export function createLamp(): SpotLight {
  return new SpotLight({
    color: LAMP_COLOR,
    intensity: 0,
    range: LAMP_RANGE,
    coneAngle: LAMP_CONE,
    penumbra: LAMP_PENUMBRA,
    castShadow: false,
  });
}

/**
 * Floodlight towers round the outside of the track: a steel pole, a lamp bank aimed down at the road with a
 * {@link SpotLight} behind it, a light shaft through the rain, and a halo round the lamps. Every tower asks the lens
 * for a flare that fades with the subject's distance, a stand-in for the camera, which follows it.
 *
 * The lights are the set's, lent for as long as these towers stand: one per tower, in order, while they last. With
 * more towers than lights, a {@link LampPool} gives them to the towers nearest the road ahead of what the camera
 * watches, and a light fades out, moves and fades in again as the camera goes on.
 *
 * Poles and housings are one mesh, the lamp panels one more, and every shaft a third.
 */
export class Floodlights {
  private readonly _root = new Container3D({ label: 'floodlights' });
  private readonly _fx: LensFx;
  private readonly _steelGeometry: Geometry3D;
  private readonly _steelMaterial: Material3D;
  private readonly _lampGeometry: Geometry3D;
  private readonly _lampMaterial: FlatMaterial;
  private readonly _beamGeometry: Geometry3D;
  private readonly _beamMaterial: FlatMaterial;
  private readonly _haloMaterial: FlatMaterial;
  /** Lamp centres and aim directions, xyz interleaved, for the flares. */
  private readonly _lamps: Float32Array;
  private readonly _aims: Float32Array;
  private readonly _lights: readonly SpotLight[];
  /** The tower each light stands on, or -1 for one left dark. */
  private readonly _lightTowers: number[];
  /** Per tower: where its light hangs and the point it looks at, xyz interleaved, and its share of full intensity. */
  private readonly _lightAt: Float64Array;
  private readonly _lightAim: Float64Array;
  private readonly _power: Float64Array;
  /** Moves the lights when there are more towers than lights; null when every tower has its own. */
  private readonly _pool: LampPool | null = null;
  private readonly _route: Route;
  /** How far each light has faded in on the tower it stands on, 0 to 1. */
  private readonly _fade: Float64Array;
  private _clock = 0;
  private _rankIn = 0;

  /**
   * @param parent - Scene root.
   * @param fx - The lens requests.
   * @param occluders - Receives each pole.
   * @param route - The track's route, which the towers stand beside.
   * @param towers - Where each stands and aims.
   * @param lights - The set's lamps, already in the scene; a tower past the last has no light.
   * @param art - The set's lamp-panel and halo textures, which outlast these towers.
   */
  constructor(
    parent: Container3D,
    fx: LensFx,
    occluders: Occluders,
    route: Route,
    towers: readonly TowerSpec[],
    lights: readonly SpotLight[],
    art: { readonly lamp: Texture; readonly halo: Texture },
  ) {
    this._fx = fx;
    this._route = route;
    this._lights = lights;
    this._lightTowers = lights.map((_, i) => (i < towers.length ? i : -1));
    this._fade = new Float64Array(lights.length).fill(1);
    this._lamps = new Float32Array(towers.length * 3);
    this._aims = new Float32Array(towers.length * 3);
    this._lightAt = new Float64Array(towers.length * 3);
    this._lightAim = new Float64Array(towers.length * 3);
    this._power = new Float64Array(towers.length);

    const groundAims: number[] = [];

    const steel = new ShapeBuilder();
    const lamps = new ShapeBuilder();
    const beams = new ShapeBuilder();

    this._haloMaterial = glowMaterial({ baseColorTexture: art.halo, baseColor: HALO_COLOR });

    for (let i = 0; i < towers.length; i++) {
      const tower = towers[i];

      route.point(tower.s, tower.lateral, _foot);
      route.point(tower.aimS, tower.aimLateral, _aim);

      const groundY = ROAD_Y;
      const top = groundY + tower.height;

      steel.tube([_foot.x, groundY, _foot.z, _foot.x, top + 0.2, _foot.z], POLE_RADIUS, 8);
      occluders.addColumn(_foot.x, _foot.z, groundY, top + 0.2, POLE_RADIUS);

      // The bank faces the aim point: f forward, r across, u up its face.
      let fx = _aim.x - _foot.x;
      let fy = _aim.y - top;
      let fz = _aim.z - _foot.z;
      const throwLength = Math.hypot(fx, fy, fz);

      fx /= throwLength;
      fy /= throwLength;
      fz /= throwLength;

      const rl = Math.hypot(fx, fz);
      const rx = -fz / rl;
      const rz = fx / rl;
      const ux = fy * rz;
      const uy = fz * rx - fx * rz;
      const uz = -fy * rx;
      // The bank stands off the pole toward the track, clear of it however steeply it tilts.
      const bx = _foot.x + (fx / rl) * BANK_OFFSET;
      const by = top;
      const bz = _foot.z + (fz / rl) * BANK_OFFSET;

      steel.box(
        bx - fx * HOUSING_DEPTH,
        by - fy * HOUSING_DEPTH,
        bz - fz * HOUSING_DEPTH,
        [rx * (BANK_HALF_WIDTH + 0.08), 0, rz * (BANK_HALF_WIDTH + 0.08)],
        [ux * (BANK_HALF_HEIGHT + 0.08), uy * (BANK_HALF_HEIGHT + 0.08), uz * (BANK_HALF_HEIGHT + 0.08)],
        [fx * HOUSING_DEPTH, fy * HOUSING_DEPTH, fz * HOUSING_DEPTH],
      );
      // An arm from the pole to the housing's back.
      steel.tube([_foot.x, top, _foot.z, bx - fx * HOUSING_DEPTH * 2, by, bz - fz * HOUSING_DEPTH * 2], 0.07, 6);
      lamps.quad(
        bx + fx * 0.005,
        by + fy * 0.005,
        bz + fz * 0.005,
        rx * BANK_HALF_WIDTH,
        0,
        rz * BANK_HALF_WIDTH,
        -ux * BANK_HALF_HEIGHT,
        -uy * BANK_HALF_HEIGHT,
        -uz * BANK_HALF_HEIGHT,
        fx,
        fy,
        fz,
      );

      this._lightAt[i * 3] = bx + fx * 0.3;
      this._lightAt[i * 3 + 1] = by + fy * 0.3;
      this._lightAt[i * 3 + 2] = bz + fz * 0.3;
      this._lightAim[i * 3] = _aim.x;
      this._lightAim[i * 3 + 1] = _aim.y;
      this._lightAim[i * 3 + 2] = _aim.z;
      this._power[i] = tower.power;
      groundAims.push(_aim.x, _aim.z);

      if (lights[i]) this._hang(lights[i], i);

      addBeam(beams, bx, by, bz, fx, fy, fz, throwLength);

      const halo = new Sprite3D({ material: this._haloMaterial, width: HALO_SIZE, height: HALO_SIZE });

      // Out in front of the panel, so the tilted bank doesn't cut into the glow's bright middle.
      halo.position.set(bx + fx * 0.7, by + fy * 0.7, bz + fz * 0.7);
      this._root.addChild(halo);

      this._lamps[i * 3] = bx;
      this._lamps[i * 3 + 1] = by;
      this._lamps[i * 3 + 2] = bz;
      this._aims[i * 3] = fx;
      this._aims[i * 3 + 1] = fy;
      this._aims[i * 3 + 2] = fz;
    }

    this._steelGeometry = steel.build();
    this._steelMaterial = new Material3D({ baseColor: 0x2b2e35, roughness: 0.45, metallic: 0.7 });
    this._root.addChild(
      new Mesh3D({ label: 'floodlight-steel', geometry: this._steelGeometry, material: this._steelMaterial }),
    );

    this._lampGeometry = lamps.build();
    this._lampMaterial = skipToneCurve(new FlatMaterial({ baseColorTexture: art.lamp }));
    this._root.addChild(
      new Mesh3D({
        label: 'floodlight-lamps',
        geometry: this._lampGeometry,
        material: this._lampMaterial,
        castShadow: false,
        receiveShadow: false,
      }),
    );

    this._beamGeometry = beams.build();
    this._beamMaterial = glowMaterial({ baseColor: BEAM_COLOR, doubleSided: true, extraBits: [beamBit] });
    this._root.addChild(
      new Mesh3D({
        geometry: this._beamGeometry,
        material: this._beamMaterial,
        castShadow: false,
        receiveShadow: false,
      }),
    );

    parent.addChild(this._root);

    if (towers.length > lights.length) this._pool = new LampPool(groundAims, lights.length);
  }

  /**
   * Flare the lamps near what the camera watches, and, with more towers than lights, move the lights toward the road
   * it's about to see.
   * @param dt - Seconds since the last frame.
   * @param x - The subject, x.
   * @param z - The subject, z.
   * @param focusS - Route distance of the road the camera is about to see.
   */
  public update(dt: number, x: number, z: number, focusS: number): void {
    if (this._pool) this._move(dt, focusS);

    const lamps = this._lamps;
    const aims = this._aims;

    for (let i = 0; i < lamps.length / 3; i++) {
      const lx = lamps[i * 3];
      const ly = lamps[i * 3 + 1];
      const lz = lamps[i * 3 + 2];
      const near = 1 - smoothstep(FLARE_NEAR, FLARE_FAR, Math.hypot(lx - x, lz - z));

      this._fx.beam(
        lx,
        ly,
        lz,
        LAMP_COLOR,
        FLARE_INTENSITY * near,
        aims[i * 3],
        aims[i * 3 + 1],
        aims[i * 3 + 2],
        FLARE_CONE,
      );
    }
  }

  /** The tower each of the set's lamps is given to, -1 for one left dark; a moving lamp counts as on its new tower. */
  public get lightTowers(): readonly number[] {
    return this._pool?.towers ?? this._lightTowers;
  }

  /**
   * Rank the towers every {@link RANK_INTERVAL}, then fade each light out of a tower it has lost, move it, and fade it
   * in on its new one. The first ranking places the lights at once.
   */
  private _move(dt: number, focusS: number): void {
    const pool = this._pool!;
    const lights = this._lights;

    this._clock += dt;
    this._rankIn -= dt;

    if (this._rankIn <= 0) {
      this._rankIn = RANK_INTERVAL;
      this._route.point(focusS, 0, _focus);

      if (pool.rank(_focus.x, _focus.z, this._clock)) {
        for (let i = 0; i < lights.length; i++) {
          this._lightTowers[i] = pool.towers[i];
          this._fade[i] = 1;
          if (pool.towers[i] >= 0) this._hang(lights[i], pool.towers[i]);
        }
      }
    }

    for (let i = 0; i < lights.length; i++) {
      const target = pool.towers[i];

      if (this._lightTowers[i] !== target) {
        this._fade[i] = Math.max(0, this._fade[i] - dt / LAMP_FADE);

        if (this._fade[i] === 0) {
          this._lightTowers[i] = target;
          if (target >= 0) this._hang(lights[i], target);
        }
      } else {
        this._fade[i] = Math.min(1, this._fade[i] + dt / LAMP_FADE);
      }

      const at = this._lightTowers[i];

      lights[i].intensity = at >= 0 ? LAMP_INTENSITY * this._power[at] * this._fade[i] : 0;
    }
  }

  /** Hang a light on a tower, lit full. */
  private _hang(light: SpotLight, tower: number): void {
    const at = this._lightAt;
    const aim = this._lightAim;

    light.intensity = LAMP_INTENSITY * this._power[tower];
    light.position.set(at[tower * 3], at[tower * 3 + 1], at[tower * 3 + 2]);
    light.lookAt(_aim.set(aim[tower * 3], aim[tower * 3 + 1], aim[tower * 3 + 2]));
  }

  /** Free the towers and put their lamps out; the lamps and the art stay the set's. */
  public destroy(): void {
    for (const light of this._lights) light.intensity = 0;

    this._root.destroy({ children: true });
    this._steelGeometry.destroy();
    this._steelMaterial.destroy();
    this._lampGeometry.destroy();
    this._lampMaterial.destroy();
    this._beamGeometry.destroy();
    this._beamMaterial.destroy();
    this._haloMaterial.destroy();
  }
}

/**
 * An unlit glow: additive, unfogged and without depth writes, so it only ever brightens what's behind it.
 * @param options - Colour, texture and extra bits.
 * @returns New material.
 */
export function glowMaterial(options: FlatMaterialOptions): FlatMaterial {
  const material = skipToneCurve(new FlatMaterial({ ...options, alphaMode: 'blend', fog: false }));

  material.state.blendMode = 'add';

  return material;
}

/** A shaft from the lamp bank down its throw, `BEAM_REACH` of the way to the road. */
function addBeam(
  beams: ShapeBuilder,
  x: number,
  y: number,
  z: number,
  fx: number,
  fy: number,
  fz: number,
  throwLength: number,
): void {
  const first = beams.vertexCount;
  const length = throwLength * BEAM_REACH;
  const radius = length * BEAM_SPREAD;

  beams.frustum(BANK_HALF_WIDTH / radius, 20).aim(first, x, y, z, fx, fy, fz, radius, length);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));

  return t * t * (3 - 2 * t);
}

/**
 * Warm lamps in a dark grid: a white-hot core in a warm ring, so bloom turns each one into a point of glare.
 * @returns The lamp panel's texture, for every tower.
 */
export function createLampTexture(): Texture {
  const cell = 64;
  const canvas = document.createElement('canvas');

  canvas.width = BANK_COLUMNS * cell;
  canvas.height = BANK_ROWS * cell;

  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#16171b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let row = 0; row < BANK_ROWS; row++) {
    for (let col = 0; col < BANK_COLUMNS; col++) {
      const cx = (col + 0.5) * cell;
      const cy = (row + 0.5) * cell;
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, cell * 0.44);

      gradient.addColorStop(0, '#ffffff');
      gradient.addColorStop(0.55, '#fff4dc');
      gradient.addColorStop(0.85, '#ffc070');
      gradient.addColorStop(1, '#3a2a1a');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.44, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return Texture.from({ resource: canvas, autoGenerateMipmaps: true });
}

/** A soft round glow with a long tail, for the halo the rain makes round a bright lamp. */
export function createHaloTexture(): Texture {
  const size = 128;
  const canvas = document.createElement('canvas');

  canvas.width = canvas.height = size;

  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);

  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.1, 'rgba(255,255,255,0.6)');
  gradient.addColorStop(0.3, 'rgba(255,255,255,0.2)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.05)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  return Texture.from({ resource: canvas, autoGenerateMipmaps: true });
}
