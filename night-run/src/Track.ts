import type { Scene3DSource } from '@pixi/3d';
import { Container3D, Model3D, Quaternion, Vector3 } from '@pixi/3d';

import type { Occluders } from './Occluders';
import { CELL_RAW, GRID_SCALE, ORIENT_DEG } from './track/pieces';
import type { VenuePlan } from './track/plan';

/**
 * The trees in each piece that a camera can't see through, measured from the GLBs, in the model's own units: centre x
 * and z, the radius of the crown's widest tier, the top, and where the crown starts.
 */
const PIECE_SOLIDS: Readonly<Record<string, readonly (readonly [number, number, number, number, number])[]>> = {
  'track-corner': [
    [4.29, -0.84, 0.78, 4.0, 1],
    [2.79, -3.03, 0.85, 4.94, 1],
    [1.42, -4.1, 0.85, 4.94, 1],
  ],
  'decoration-empty': [
    [-2.52, 2.79, 0.78, 4.0, 1],
    [-4.24, 1.29, 0.92, 4.94, 1],
    [1.56, -2.37, 0.78, 4.0, 1],
  ],
  'decoration-forest': [
    [3.15, 3.05, 0.92, 4.94, 1],
    [1.43, -2.72, 0.78, 4.22, 1],
    [0.74, 1.07, 0.9, 5.33, 1],
    [0.74, 2.7, 0.85, 4.6, 1],
    [-3.45, -3.14, 0.78, 4.0, 1],
    [-3.47, 3.63, 0.78, 4.0, 1],
    [3.61, -3.84, 0.92, 4.94, 1],
  ],
  'decoration-tents': [[-2.95, 3.68, 0.78, 4.2, 1]],
};
/**
 * The canopy tents in each piece, in the model's units: the centre x and z of the square roof, half its side, and its
 * own turn. Each stands open on four thin posts, so only the roof, from {@link CANOPY_EAVE} up to {@link CANOPY_TOP},
 * blocks a view.
 */
const PIECE_CANOPIES: Readonly<Record<string, readonly (readonly [number, number, number, number])[]>> = {
  'decoration-tents': [
    [-2.47, -2.19, 2, -0.066],
    [2.29, 2.29, 2, 0.169],
  ],
};
const CANOPY_EAVE = 1.5;
const CANOPY_TOP = 3;
/** A tree's trunk radius, in the model's units. */
const TRUNK_RADIUS = 0.2;
/** The finish arch in track-finish.glb, in the model's units: a half ring round its centre, this deep either side. */
const ARCH_INNER = 5;
const ARCH_OUTER = 7.02;
const ARCH_HALF_DEPTH = 1.5;

const _q = new Quaternion();
const _yAxis = new Vector3(0, 1, 0);

function placeModel(
  source: Scene3DSource,
  parent: Container3D,
  x: number,
  y: number,
  z: number,
  yawRad: number,
): Container3D {
  const root = new Model3D(source);

  root.position.set(x, y, z);
  _q.setFromAxisAngle(_yAxis, yawRad);
  root.quaternion.copyFrom(_q);
  parent.addChild(root);

  return root;
}

/** A model's height in world units, from its own `y`: the group sits half a unit down, and each piece half a unit up. */
function worldY(y: number): number {
  return (0.5 + y) * GRID_SCALE - 0.5;
}

/**
 * Tell the cameras about the trees, tents and arch in one placed piece.
 * @param occluders - Receives the solids.
 * @param key - The piece's model.
 * @param px - Where its centre sits in the track group, x.
 * @param pz - Where its centre sits in the track group, z.
 * @param yaw - Its turn about the vertical.
 */
function addPieceOccluders(occluders: Occluders, key: string, px: number, pz: number, yaw: number): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);

  if (key === 'track-finish') {
    occluders.addArch(
      px * GRID_SCALE,
      worldY(0),
      pz * GRID_SCALE,
      ARCH_INNER * GRID_SCALE,
      ARCH_OUTER * GRID_SCALE,
      ARCH_HALF_DEPTH * GRID_SCALE,
    );

    return;
  }

  for (const [lx, lz, radius, top, crown] of PIECE_SOLIDS[key] ?? []) {
    occluders.addCone(
      (px + lx * c + lz * s) * GRID_SCALE,
      (pz - lx * s + lz * c) * GRID_SCALE,
      worldY(0),
      worldY(crown),
      worldY(top),
      radius * GRID_SCALE,
      TRUNK_RADIUS * GRID_SCALE,
    );
  }

  for (const [lx, lz, half, turn] of PIECE_CANOPIES[key] ?? []) {
    occluders.addBox(
      (px + lx * c + lz * s) * GRID_SCALE,
      (worldY(CANOPY_EAVE) + worldY(CANOPY_TOP)) / 2,
      (pz - lx * s + lz * c) * GRID_SCALE,
      half * GRID_SCALE,
      ((CANOPY_TOP - CANOPY_EAVE) / 2) * GRID_SCALE,
      half * GRID_SCALE,
      yaw + turn,
    );
  }
}

/**
 * Place a venue's road pieces, then its scenery, in the plan's order, and tell the cameras about every tree, tent and
 * the arch. The walls' colliders come from the plan too, for the physics to add.
 * @param parent - Where the track goes.
 * @param sources - The loaded models, by name.
 * @param occluders - Receives the trees, tents and arch the cameras have to see past.
 * @param plan - The venue.
 * @returns The track group, holding every piece.
 */
export function buildTrack(
  parent: Container3D,
  sources: Record<string, Scene3DSource>,
  occluders: Occluders,
  plan: VenuePlan,
): Container3D {
  const trackGroup = new Container3D({ label: 'track' });

  trackGroup.scale.set(GRID_SCALE, GRID_SCALE, GRID_SCALE);
  trackGroup.position.set(0, -0.5, 0);
  parent.addChild(trackGroup);

  for (const placements of [plan.pieces, plan.scenery]) {
    for (const { gx, gz, key, orient } of placements) {
      const source = sources[key];

      if (!source) continue;

      const px = (gx + 0.5) * CELL_RAW;
      const pz = (gz + 0.5) * CELL_RAW;
      const yaw = (ORIENT_DEG[orient] * Math.PI) / 180;

      placeModel(source, trackGroup, px, 0.5, pz, yaw);
      addPieceOccluders(occluders, key, px, pz, yaw);
    }
  }

  return trackGroup;
}
