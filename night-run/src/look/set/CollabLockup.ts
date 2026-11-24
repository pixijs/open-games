import type { BaseMaterial3D, Geometry3D, Scene3DSource } from '@pixi/3d';
import { Container3D, FlatMaterial, Material3D, Mesh3D, Model3D, SpotLight } from '@pixi/3d';

import type { Occluders } from '../../Occluders';
import { FINISH_LINE } from '../../race/route';
import { skipToneCurve } from '../toneCurve';
import { glowMaterial } from './Floodlights';
import { ShapeBuilder } from './ShapeBuilder';

const DEG = Math.PI / 180;

/** The row's layout over the finish line: its centre's height, the beam under it, and each mark's place and size. */
const ROW_Y = 6.1;
const BEAM_Y = -0.76;
const COLYSEUS = { x: -3.1, halfWidth: 3.6 };
const CROSS = { x: 1.37, half: 0.32 };
const PIXI = { x: 4.49, halfWidth: 2.2 };

/** Each model's own box, measured from the files: centre and width in their own units. */
const COLYSEUS_BOX = { cx: 0, cy: 0, width: 7.32 };
const PIXI_BOX = { cx: 0.835, cy: 0, width: 7.33 };

/** How far in front of the truss the logos hang, and how far each turns in toward the middle so its depth shows. */
const MOUNT_Z = 0.28;
const TOE_IN = 2 * DEG;

/** The arch's outer edge, from track-finish.glb: a half ring of this radius round the finish line. */
const ARCH_OUTER = 4.885;
const ARCH_BASE = -0.125;

/**
 * The truss: two steel chords and the web between them, the logos hanging in front of it, on two struts down to the
 * arch's crown and a stub up to the ×.
 */
const BEAM_LEFT = -6.7;
const BEAM_RIGHT = 6.3;
const CHORD_THICK = 0.08;
const TRUSS_DEPTH = 0.36;
const WEB_THICK = 0.03;
const WEB_BAYS = 18;
const STRUT_X = 2.4;
const STRUT_THICK = 0.1;
const STUB_THICK = 0.035;

/** The neon ×: a white-hot core in a tube of coloured light, thick enough to keep its shape through the bloom. */
const CROSS_CORE = 0.038;
const CROSS_TUBE = 0.082;
const CROSS_CORE_COLOR = 0xf2fdff;
const CROSS_TUBE_COLOR = 0x0f9fc4;

/**
 * One narrow key per logo, aimed over it so the arch's crown under the row stays out of both cones. Each key's place
 * is measured from its logo, out along the row: the wordmark's is high in front and lights its face evenly; the rose
 * mark's rakes in low from the outer side, so its face and its extrusion part.
 */
interface KeyRig {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly cone: number;
  readonly color: number;
  readonly intensity: number;
}

const COLYSEUS_KEY: KeyRig = { x: 0, y: 2.6, z: 6, cone: 31, color: 0xf6f2ff, intensity: 60 };
const PIXI_KEY: KeyRig = { x: 4.4, y: 0.7, z: 4.4, cone: 26, color: 0xffd8e6, intensity: 62 };
const KEY_PENUMBRA = 0.5;
const KEY_RANGE = 14;
const KEY_AIM_LIFT = 0.5;

/** Glow per source material, in the source's order: what keeps each enamel readable in the dark. */
type Glow = readonly [color: number, strength: number];
const COLYSEUS_GLOW: readonly Glow[] = [
  [0x8a4cf0, 0.45],
  [0x5d3ad8, 0.35],
  [0xeeeaff, 0.34],
  [0x5a3ae0, 0.45],
];
const PIXI_GLOW: readonly Glow[] = [[0xff1f70, 0.09]];

/** A win's flare: how much hotter the enamel burns on the line, how fast that dies, and when it's over. */
const WIN_GLOW = 1.6;
const WIN_DECAY = 1.2;
const WIN_TIME = 6;

interface Enamel {
  readonly material: Material3D;
  readonly strength: number;
}

interface Logo {
  readonly x: number;
  readonly key: SpotLight;
  readonly rig: KeyRig;
}

/**
 * Colyseus × PixiJS over the finish line: the two logos as real 3D models, with a neon × between them, on a steel
 * truss standing on the finish arch. The cameras only see one side at a time, so one copy turns to face whichever side
 * the camera is on; it turns while the camera crosses the line, when the row is edge on. Two spot lights, no shadows.
 */
export class CollabLockup {
  private readonly _root = new Container3D({ label: 'collab-lockup' });
  /** Everything that turns to face the camera; the keys stay in the root and are re-aimed. */
  private readonly _face = new Container3D({ label: 'collab-lockup-face' });
  private readonly _camera: Container3D;
  private readonly _colyseus: Logo;
  private readonly _pixi: Logo;
  private readonly _enamels: Enamel[] = [];
  private readonly _geometries: Geometry3D[] = [];
  private readonly _materials: (FlatMaterial | Material3D)[] = [];
  private _facing = 0;
  private _celebrated = -Infinity;
  private _glow = 1;

  /**
   * @param parent - Scene root.
   * @param sources - The two logo models.
   * @param sources.colyseus - The Colyseus logo.
   * @param sources.pixi - The PixiJS logo.
   * @param camera - The view's camera, which the row turns to face.
   */
  constructor(
    parent: Container3D,
    sources: { readonly colyseus: Scene3DSource; readonly pixi: Scene3DSource },
    camera: Container3D,
  ) {
    this._camera = camera;
    this._colyseus = this._mount(sources.colyseus, COLYSEUS_BOX, COLYSEUS, COLYSEUS_GLOW, COLYSEUS_KEY, 1, 0.6, 1);
    this._pixi = this._mount(sources.pixi, PIXI_BOX, PIXI, PIXI_GLOW, PIXI_KEY, -1, 0.2, 0.4);

    const crossCore = skipToneCurve(new FlatMaterial({ baseColor: CROSS_CORE_COLOR }));
    const crossTube = glowMaterial({ baseColor: CROSS_TUBE_COLOR });
    const core = new ShapeBuilder();
    const tube = new ShapeBuilder();

    for (const side of [-1, 1]) {
      const line = [
        CROSS.x - CROSS.half,
        -side * CROSS.half,
        MOUNT_Z,
        CROSS.x + CROSS.half,
        side * CROSS.half,
        MOUNT_Z,
      ];

      core.tube(line, CROSS_CORE, 8);
      tube.tube(line, CROSS_TUBE, 8);
    }

    this._mesh(core, crossCore, true);
    this._mesh(tube, crossTube, false);
    this._mesh(buildTruss(), new Material3D({ baseColor: 0x6a6f7c, roughness: 0.42, metallic: 0.3 }), true);

    this._root.position.set(FINISH_LINE.x, ROW_Y, FINISH_LINE.z);
    this._root.addChild(this._face, this._colyseus.key, this._pixi.key);
    parent.addChild(this._root);
  }

  /**
   * Give the cameras the row to see past, wide enough for it facing either way. Every track's arch stands on the same
   * line, so the row stays up from track to track and only its occluder goes in again.
   * @param occluders - Receives the row.
   */
  public occlude(occluders: Occluders): void {
    const bottom = BEAM_Y - TRUSS_DEPTH;
    const top = 0.9;

    occluders.addBox(
      FINISH_LINE.x,
      ROW_Y + (top + bottom) / 2,
      FINISH_LINE.z,
      Math.max(-BEAM_LEFT, BEAM_RIGHT),
      (top - bottom) / 2,
      MOUNT_Z + 0.2,
      0,
    );
  }

  /**
   * Turn to the camera's side of the line, and burn the enamel hotter for a while after a win.
   * @param time - Seconds on the game clock.
   */
  public update(time: number): void {
    this._turnTo(this._camera.position.z >= FINISH_LINE.z ? 1 : -1);

    const since = time - this._celebrated;
    const glow = since >= 0 && since < WIN_TIME ? 1 + WIN_GLOW * Math.exp(-since * WIN_DECAY) : 1;

    if (glow === this._glow) return;

    this._glow = glow;

    for (const enamel of this._enamels) enamel.material.emissive!.strength = enamel.strength * glow;
  }

  /**
   * Flare the logos, as a winner crosses the line.
   * @param time - Seconds on the game clock now.
   */
  public celebrate(time: number): void {
    this._celebrated = time;
  }

  public destroy(): void {
    this._root.destroy({ children: true });

    for (const geometry of this._geometries) geometry.destroy();
    for (const material of this._materials) material.destroy();
    for (const enamel of this._enamels) enamel.material.destroy();
  }

  private _mount(
    source: Scene3DSource,
    box: typeof PIXI_BOX,
    place: typeof PIXI,
    glow: readonly Glow[],
    rig: KeyRig,
    toeSign: number,
    coat: number,
    specular: number,
  ): Logo {
    const holder = new Container3D({ label: 'collab-logo' });
    const model = new Model3D(source);
    const scale = (place.halfWidth * 2) / box.width;
    const enamels = source.materials.map((material, i) =>
      createEnamel(material, glow[Math.min(i, glow.length - 1)], coat, specular),
    );

    forEachMesh(model, (mesh) => {
      const index = source.materials.indexOf(mesh.material as BaseMaterial3D);

      mesh.material = enamels[Math.max(0, index)].material;
      mesh.castShadow = false;
    });

    this._enamels.push(...enamels);
    model.scale.set(scale, scale, scale);
    model.position.set(-box.cx * scale, -box.cy * scale, 0);
    holder.addChild(model);
    holder.position.set(place.x, 0, MOUNT_Z);
    holder.rotation.set(0, toeSign * TOE_IN, 0);
    this._face.addChild(holder);

    const key = new SpotLight({
      color: rig.color,
      intensity: rig.intensity,
      range: KEY_RANGE,
      coneAngle: rig.cone,
      penumbra: KEY_PENUMBRA,
    });

    return { x: place.x, key, rig };
  }

  private _mesh(builder: ShapeBuilder, material: FlatMaterial | Material3D, receiveShadow: boolean): void {
    const geometry = builder.build();

    this._geometries.push(geometry);
    this._materials.push(material);
    this._face.addChild(new Mesh3D({ geometry, material, castShadow: false, receiveShadow }));
  }

  private _turnTo(facing: number): void {
    if (facing === this._facing) return;

    this._facing = facing;
    this._face.rotation.set(0, facing < 0 ? Math.PI : 0, 0);
    aimKey(this._colyseus, facing);
    aimKey(this._pixi, facing);
  }
}

const _aim = { x: 0, y: ROW_Y + KEY_AIM_LIFT, z: FINISH_LINE.z };

/** Moves a logo's key to the side the row faces, out along the row from the logo, and aims it over the logo. */
function aimKey(logo: Logo, facing: number): void {
  const out = Math.sign(logo.x) * logo.rig.x;

  logo.key.position.set(facing * (logo.x + out), logo.rig.y, facing * logo.rig.z);
  _aim.x = FINISH_LINE.x + facing * logo.x;
  logo.key.lookAt(_aim);
}

/** The truss in the row's frame: chords with a zigzag web, struts down to the arch's crown and a stub up to the ×. */
function buildTruss(): ShapeBuilder {
  const truss = new ShapeBuilder();
  const top = BEAM_Y;
  const bottom = top - TRUSS_DEPTH;
  const foot = ARCH_BASE + Math.sqrt(ARCH_OUTER * ARCH_OUTER - STRUT_X * STRUT_X) - ROW_Y;
  const strut = (bottom - foot) / 2;
  const middle = (BEAM_LEFT + BEAM_RIGHT) / 2;
  const span = (BEAM_RIGHT - BEAM_LEFT) / 2;
  const bay = (BEAM_RIGHT - BEAM_LEFT) / WEB_BAYS;

  for (const y of [top, bottom]) {
    truss.box(middle, y, 0, [span, 0, 0], [0, CHORD_THICK, 0], [0, 0, CHORD_THICK]);
  }

  for (let i = 0; i < WEB_BAYS; i++) {
    const x = BEAM_LEFT + bay * i;
    const up = i % 2 === 0;

    truss.tube([x, up ? bottom : top, 0, x + bay, up ? top : bottom, 0], WEB_THICK, 4);
  }

  truss.box(CROSS.x, top / 2, 0, [STUB_THICK, 0, 0], [0, top / 2, 0], [0, 0, STUB_THICK]);

  for (const side of [-1, 1]) {
    truss.box(side * STRUT_X, foot + strut, 0, [STRUT_THICK, 0, 0], [0, -strut, 0], [0, 0, STRUT_THICK]);
  }

  return truss;
}

/** A logo's material as lit enamel: its own colour, a clear coat, and a glow that keeps it readable at night. */
function createEnamel(source: BaseMaterial3D, glow: Glow, coat: number, specular: number): Enamel {
  const from = source instanceof Material3D ? source : null;
  const material = new Material3D({
    baseColor: source.baseColor,
    roughness: from?.roughness ?? 0.3,
    metallic: from?.metallic ?? 0,
    doubleSided: source.doubleSided,
    specular: { factor: specular },
    clearcoat: { factor: coat, roughness: from?.clearcoat?.roughness ?? 0.12 },
    emissive: { color: glow[0], strength: glow[1] },
  });

  // The Colyseus emblem's gradient is in its vertex colours.
  material.vertexColors = source.vertexColors;

  return { material, strength: glow[1] };
}

function forEachMesh(node: Container3D, visit: (mesh: Mesh3D) => void): void {
  if (node instanceof Mesh3D) visit(node);

  for (const child of node.children) if (child instanceof Container3D) forEachMesh(child, visit);
}
