import type { Scene3DSource, View3D } from '@pixi/3d';
import { Container3D, Material3D, Mesh3D, PlaneGeometry } from '@pixi/3d';

import type { LensFx } from './look/LensFx';
import { GRASS_COLOR } from './look/NightLook';
import { NightSet } from './look/NightSet';
import type { Occluders } from './Occluders';
import type { PhysicsWorld } from './Physics';
import type { Course } from './race/course';
import type { RacingLine } from './race/line/RacingLine';
import type { Route } from './race/route';
import { buildTrack } from './Track';
import type { TrackDef } from './track/code';
import type { VenuePlan } from './track/plan';
import { planVenue } from './track/plan';

/** The ground plane's size before it's scaled to a track, Night Run's. */
const PLANE_SIZE = 200;
const GROUND_Y = -0.13;
const SLAB_Y = -0.125;
const SLAB_HALF_HEIGHT = 0.01;

/** What a venue holds now, as the test hooks report it. */
export interface VenueStats {
  /** Models in the track group: road pieces and scenery. */
  models: number;
  walls: number;
  /** Static bodies: the ground slab and the walls. */
  statics: number;
  occluders: number;
  /** Occluders refused for a full table; any is a camera that can clip a tree. */
  occludersDropped: number;
  setLights: number;
  /** The tower each of the set's spot lights is given to, -1 for one left dark. */
  lightTowers: number[];
  towers: number;
  gantries: number;
  tvSpots: number;
  /** The physics slab's centre and half extent, and the plane's size. */
  ground: { x: number; z: number; half: number; plane: number };
  /** How long the last build took, in milliseconds. */
  buildMs: number;
  treeSeed: number;
}

/** What a venue is built into and from. */
export interface VenueParts {
  view: View3D;
  sources: Record<string, Scene3DSource>;
  physics: PhysicsWorld;
  occluders: Occluders;
  fx: LensFx;
  course: Course;
}

/**
 * The world a track is raced in: the grass, the road and its scenery, the walls, and the night set. One lasts the page;
 * {@link Venue.build} tears the last track down and puts the next up in one go, so no frame draws half of either and
 * no physics step runs without ground. The ground, the set's lights, the physics world and the occluders are kept, so
 * nothing that holds them goes stale and the view's light list never changes.
 */
export class Venue {
  /** Holds the track and the set, ahead of the trucks in the scene. */
  public readonly root = new Container3D({ label: 'venue' });
  /** The grass, moved and scaled to each track. */
  public readonly ground: Mesh3D;
  public readonly set: NightSet;
  /** The plan of the track built, null before the first build. */
  public plan: VenuePlan | null = null;

  private readonly _parts: VenueParts;
  private _track: Container3D | null = null;
  private _buildMs = 0;
  private _treeSeed = 0;

  /**
   * Puts the grass and the set's lights in the scene, where the track will go; builds no track.
   * @param parts - What it builds into and from.
   */
  constructor(parts: VenueParts) {
    this._parts = parts;
    this.ground = new Mesh3D({
      geometry: new PlaneGeometry({ width: PLANE_SIZE, height: PLANE_SIZE }),
      material: new Material3D({ baseColor: GRASS_COLOR, metallic: 0, roughness: 0.9 }),
      castShadow: false,
      receiveShadow: true,
    });
    this.ground.rotation.set(-Math.PI / 2, 0, 0);
    this.ground.position.set(0, GROUND_Y, 0);
    parts.view.root.addChild(this.ground);
    parts.view.root.addChild(this.root);
    this.set = new NightSet(
      this.root,
      parts.fx,
      { colyseus: parts.sources['colyseus-logo'], pixi: parts.sources['pixijs-logo'] },
      parts.view.camera,
    );
  }

  /**
   * Put a track up in place of the last: teardown in reverse build order, the course swapped before any occluder goes
   * in (the occluders keep only what's near the course's road), then the ground, walls, track and set.
   * @param def - The track.
   * @param route - Its route.
   * @param line - Its racing line.
   * @param treeSeed - Seeds a custom track's trees.
   * @returns Its plan.
   */
  public build(def: TrackDef, route: Route, line: RacingLine, treeSeed: number): VenuePlan {
    const { sources, physics, occluders, course } = this._parts;
    const start = performance.now();

    this.set.teardown();
    // No resource flags: the models share their GLB sources with the next track's and with the trucks.
    this._track?.destroy({ children: true });
    this._track = null;
    physics.clearStatics();
    occluders.clear();
    course.set(def, route, line);

    const plan = planVenue(def, route, treeSeed);
    const { x, z, half, plane } = plan.ground;

    // The plane lies in its own x and y before its quarter turn down.
    this.ground.position.set(x, GROUND_Y, z);
    this.ground.scale.set(plane / PLANE_SIZE, plane / PLANE_SIZE, 1);
    physics.addStaticGround([x, SLAB_Y, z], [half, SLAB_HALF_HEIGHT, half]);

    for (const wall of plan.walls) physics.addStaticBox(wall);

    this._track = buildTrack(this.root, sources, occluders, plan);
    this.set.build({ group: this._track, ground: this.ground }, route, plan, occluders);
    this.plan = plan;
    this._treeSeed = treeSeed;
    this._buildMs = performance.now() - start;

    return plan;
  }

  /** What the venue holds now. */
  public stats(): VenueStats {
    const { physics, occluders } = this._parts;
    const plan = this.plan;
    const scale = this.ground.scale.x;

    return {
      models: this._track?.children.length ?? 0,
      walls: Math.max(0, physics.staticCount - 1),
      statics: physics.staticCount,
      occluders: occluders.count,
      occludersDropped: occluders.dropped,
      setLights: this.set.lightCount,
      lightTowers: [...this.set.lightTowers],
      towers: plan?.towers.length ?? 0,
      gantries: plan?.gantries.length ?? 0,
      tvSpots: plan?.tvSpots.length ?? 0,
      ground: {
        x: this.ground.position.x,
        z: this.ground.position.z,
        half: plan?.ground.half ?? 0,
        plane: PLANE_SIZE * scale,
      },
      buildMs: Math.round(this._buildMs * 10) / 10,
      treeSeed: this._treeSeed,
    };
  }
}
