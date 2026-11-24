import type { Geometry3D } from '@pixi/3d';
import { Container3D, FlatMaterial, Material3D, Mesh3D, PointLight, Vector3 } from '@pixi/3d';

import type { Occluders } from '../../Occluders';
import type { Route } from '../../race/route';
import { CELL, FINISH_LINE, ROAD_Y } from '../../race/route';
import { GANTRY_LATERAL } from '../../track/plan';
import { skipToneCurve } from '../toneCurve';
import { ShapeBuilder } from './ShapeBuilder';

const NEON_CYAN = 0x38f4ff;
const NEON_MAGENTA = 0xff36d8;

/** Lateral offset of the barrier centres, and the height of their tops. */
const BARRIER_LATERAL = 3.56;
const BARRIER_TOP = -0.125 + 0.5625;
const STRIP_RADIUS = 0.035;

/** The finish arch from track-finish.glb, in world units: a half ring round the finish line, faces either side of it. */
const ARCH_INNER = 3.75;
const ARCH_OUTER = 4.885;
const ARCH_BASE = -0.125;
const ARCH_FACE = 1.125;
const ARCH_TUBE = 0.045;

/** Underside of the crossbeam. */
const GANTRY_CLEAR = 3.9;
const GANTRY_TUBE = 0.05;

const SPILL_INTENSITY = 9;
const SPILL_RANGE = 7.5;

const _p = new Vector3();
const _q = new Vector3();

/**
 * A coloured spill light, dark until {@link Neon} hangs it. The set makes its three once, so they keep their place in
 * the view's light list whatever track is built.
 * @returns The light, off.
 */
export function createSpill(): PointLight {
  return new PointLight({ intensity: 0, range: SPILL_RANGE });
}

/**
 * The neon: strips along the barrier tops, cyan and magenta trading sides each section; the finish arch outlined;
 * and a tunnel of neon gantries over a straight, where the hero boosts. Coloured point lights under the arch and in the
 * tunnel spill onto the wet road.
 *
 * One mesh per colour; the flickering gantry tube is its own, since it changes brightness.
 */
export class Neon {
  private readonly _root = new Container3D({ label: 'neon' });
  private readonly _geometries: Geometry3D[] = [];
  private readonly _cyan: FlatMaterial;
  private readonly _magenta: FlatMaterial;
  private readonly _flicker: FlatMaterial;
  private readonly _steel: Material3D;
  /** The set's spill lights, lent for as long as this neon stands. */
  private readonly _lights: readonly PointLight[];
  /** The spill under the flickering gantry, which flickers with it; null with no tunnel. */
  private readonly _flickerLight: PointLight | null = null;
  /** The failing tube's colour at full strength: the colour its gantry would have had. */
  private readonly _flickerColor: number;

  /**
   * @param parent - Scene root.
   * @param occluders - Receives the gantries.
   * @param route - The track's route, which the strips and the tunnel follow.
   * @param gantries - Route distance of each of the tunnel's portals.
   * @param flickerGantry - Index of the portal whose tube flickers, -1 with no tunnel; the spill lights hang under it
   * and the one before.
   * @param lights - The set's three spill lights, already in the scene: under the arch, then the two in the tunnel.
   */
  constructor(
    parent: Container3D,
    occluders: Occluders,
    route: Route,
    gantries: readonly number[],
    flickerGantry: number,
    lights: readonly PointLight[],
  ) {
    const cyan = new ShapeBuilder();
    const magenta = new ShapeBuilder();
    const flicker = new ShapeBuilder();
    const steel = new ShapeBuilder();

    this._flickerColor = flickerGantry % 2 ? NEON_MAGENTA : NEON_CYAN;
    buildBarrierStrips(route, cyan, magenta);
    buildArch(cyan, magenta);

    for (let i = 0; i < gantries.length; i++) {
      buildGantry(route, gantries[i], i === flickerGantry ? flicker : i % 2 ? magenta : cyan, steel, occluders);
    }

    this._cyan = skipToneCurve(new FlatMaterial({ baseColor: NEON_CYAN }));
    this._magenta = skipToneCurve(new FlatMaterial({ baseColor: NEON_MAGENTA }));
    this._flicker = skipToneCurve(new FlatMaterial({ baseColor: this._flickerColor }));
    this._steel = new Material3D({ baseColor: 0x23252b, roughness: 0.4, metallic: 0.7 });

    this._mesh(cyan, this._cyan);
    this._mesh(magenta, this._magenta);
    this._mesh(flicker, this._flicker);
    this._mesh(steel, this._steel);

    this._lights = lights;
    this._hang(lights[0], NEON_MAGENTA, FINISH_LINE.x, 3.2, FINISH_LINE.z);

    if (flickerGantry > 0) {
      route.point(gantries[flickerGantry - 1], 0, _p);
      this._hang(lights[1], flickerGantry % 2 ? NEON_CYAN : NEON_MAGENTA, _p.x, 3.3, _p.z);
      route.point(gantries[flickerGantry], 0, _p);
      this._flickerLight = this._hang(lights[2], this._flickerColor, _p.x, 3.3, _p.z);
    }

    parent.addChild(this._root);
  }

  /**
   * The failing tube's stutter.
   * @param time - Seconds on the game clock.
   */
  public update(time: number): void {
    const slot = Math.floor(time * 17);
    const dim = hash(slot) > 0.72 ? 0.12 + 0.3 * hash(slot + 91) : 1;

    this._flicker.baseColor = scaleColor(this._flickerColor, dim);
    if (this._flickerLight) this._flickerLight.intensity = SPILL_INTENSITY * dim;
  }

  /** Free the neon and put its spill lights out; the lights stay the set's. */
  public destroy(): void {
    for (const light of this._lights) light.intensity = 0;

    this._root.destroy({ children: true });

    for (const geometry of this._geometries) geometry.destroy();

    this._geometries.length = 0;
    this._cyan.destroy();
    this._magenta.destroy();
    this._flicker.destroy();
    this._steel.destroy();
  }

  private _mesh(builder: ShapeBuilder, material: FlatMaterial | Material3D): void {
    if (builder.vertexCount === 0) return;

    const geometry = builder.build();

    this._geometries.push(geometry);
    this._root.addChild(new Mesh3D({ geometry, material, castShadow: material instanceof Material3D }));
  }

  private _hang(light: PointLight, color: number, x: number, y: number, z: number): PointLight {
    light.color = color;
    light.intensity = SPILL_INTENSITY;
    light.position.set(x, y, z);

    return light;
  }
}

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;

  return x - Math.floor(x);
}

function scaleColor(color: number, k: number): number {
  const r = Math.round(((color >> 16) & 0xff) * k);
  const g = Math.round(((color >> 8) & 0xff) * k);
  const b = Math.round((color & 0xff) * k);

  return (r << 16) | (g << 8) | b;
}

/** Route distance at the start of every section, one per route cell, the finish cell split at the line. */
function sectionStarts(route: Route): number[] {
  const arc = (Math.PI / 2) * (CELL / 2);
  const starts = [0];
  let s = CELL / 2;

  for (let i = 1; i < route.cells.length; i++) {
    starts.push(s);
    s += route.turn(s + 0.01) === 0 ? CELL : arc;
  }

  starts.push(s);

  return starts;
}

/**
 * A strip along each barrier top. The colours trade sides every section; the tiny post on the inside of a corner
 * gets none.
 */
function buildBarrierStrips(route: Route, cyan: ShapeBuilder, magenta: ShapeBuilder): void {
  const starts = sectionStarts(route);
  const points: number[] = [];

  for (let i = 0; i < starts.length; i++) {
    const s0 = starts[i];
    const s1 = i + 1 < starts.length ? starts[i + 1] : route.lapLength;
    const turn = route.turn((s0 + s1) / 2);
    const steps = Math.max(1, Math.ceil((s1 - s0) / (turn === 0 ? 8 : 0.4)));

    for (const side of [-1, 1]) {
      if (turn === side) continue;

      points.length = 0;

      for (let k = 0; k <= steps; k++) {
        route.point(s0 + ((s1 - s0) * k) / steps, side * BARRIER_LATERAL, _p);
        points.push(_p.x, BARRIER_TOP + STRIP_RADIUS * 0.6, _p.z);
      }

      ((i + (side > 0 ? 1 : 0)) % 2 ? magenta : cyan).tube(points, STRIP_RADIUS, 4, Math.PI / 4);
    }
  }
}

/** The arch's inner and outer edges on both faces: cyan inside, magenta outside. */
function buildArch(cyan: ShapeBuilder, magenta: ShapeBuilder): void {
  const steps = 12;
  const inner: number[] = [];
  const outer: number[] = [];

  for (const face of [-1, 1]) {
    inner.length = 0;
    outer.length = 0;

    const z = FINISH_LINE.z + face * (ARCH_FACE + ARCH_TUBE);

    for (let k = 0; k <= steps; k++) {
      const angle = (k / steps) * Math.PI;
      const c = Math.cos(angle);
      const s = Math.sin(angle);

      inner.push(FINISH_LINE.x + c * (ARCH_INNER - ARCH_TUBE), ARCH_BASE + s * (ARCH_INNER - ARCH_TUBE), z);
      outer.push(FINISH_LINE.x + c * (ARCH_OUTER + ARCH_TUBE), ARCH_BASE + s * (ARCH_OUTER + ARCH_TUBE), z);
    }

    cyan.tube(inner, ARCH_TUBE, 6);
    magenta.tube(outer, ARCH_TUBE, 6);
  }
}

/**
 * A portal over the road: steel posts and crossbeam, with a neon tube up the inside of one post, across, and down. The
 * cameras get its posts, and its beam down to the tube's underside.
 */
function buildGantry(route: Route, s: number, tube: ShapeBuilder, steel: ShapeBuilder, occluders: Occluders): void {
  const heading = route.point(s, -GANTRY_LATERAL, _p);

  route.point(s, GANTRY_LATERAL, _q);

  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  // Across the road, toward the driver's right.
  const rx = -fz;
  const rz = fx;
  const top = GANTRY_CLEAR + 0.22;
  const ground = ROAD_Y;
  const post = 0.12;
  const beam: readonly number[] = [rx * (GANTRY_LATERAL + post), 0, rz * (GANTRY_LATERAL + post)];
  const mx = (_p.x + _q.x) / 2;
  const mz = (_p.z + _q.z) / 2;

  for (const end of [_p, _q]) {
    steel.box(
      end.x,
      (ground + top) / 2,
      end.z,
      [rx * post, 0, rz * post],
      [0, (top - ground) / 2, 0],
      [fx * post, 0, fz * post],
    );
  }

  steel.box(mx, top - 0.11, mz, beam, [0, 0.11, 0], [fx * 0.16, 0, fz * 0.16]);
  occluders.addColumn(_p.x, _p.z, ground, top, post);
  occluders.addColumn(_q.x, _q.z, ground, top, post);
  occluders.addBox(
    mx,
    (top + GANTRY_CLEAR - 2 * GANTRY_TUBE) / 2,
    mz,
    GANTRY_LATERAL + post,
    (top - GANTRY_CLEAR + 2 * GANTRY_TUBE) / 2,
    0.16,
    heading,
  );

  // The tube runs on the posts' and beam's inner faces, so it never hangs lower than the beam.
  const inset = GANTRY_LATERAL - post - GANTRY_TUBE;
  const low = BARRIER_TOP + 0.1;
  const high = GANTRY_CLEAR - GANTRY_TUBE;
  const lx = mx - rx * inset;
  const lz = mz - rz * inset;
  const hx = mx + rx * inset;
  const hz = mz + rz * inset;

  tube.tube([lx, low, lz, lx, high, lz], GANTRY_TUBE, 6);
  tube.tube([lx, high, lz, hx, high, hz], GANTRY_TUBE, 6);
  tube.tube([hx, high, hz, hx, low, hz], GANTRY_TUBE, 6);
}
