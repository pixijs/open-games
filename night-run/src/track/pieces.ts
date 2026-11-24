/**
 * The kit's road pieces on the grid: which piece and turn each cell of a track needs, and the wall colliders those
 * pieces stand for. Pure, so the race's physics and a headless race in a worker build the same walls.
 */

import type { WallSpec } from '../Physics';
import type { Cell } from './code';
import type { Orient, Placement } from './plan';

/** Each orient code's turn, in degrees. */
export const ORIENT_DEG: Readonly<Record<Orient, number>> = { 0: 0, 10: 180, 16: 90, 22: 270 };

/** A grid cell in the kit's model units. */
export const CELL_RAW = 9.99;
/** The scale the track group draws the kit's cells at. */
export const GRID_SCALE = 0.75;

/**
 * The piece and turn for each cell of a loop: the finish on the first cell, straights where the way in and out agree,
 * and corners turned to open onto the sides they join.
 * @param cells - The loop in race order, finish cell first.
 * @returns One placement per cell, in race order.
 */
export function piecesFor(cells: readonly Cell[]): Placement[] {
  const n = cells.length;
  const pieces: Placement[] = [];

  for (let i = 0; i < n; i++) {
    const [px, pz] = cells[(i - 1 + n) % n];
    const [gx, gz] = cells[i];
    const [nx, nz] = cells[(i + 1) % n];
    const inX = gx - px;
    const inZ = gz - pz;
    const outX = nx - gx;
    const outZ = nz - gz;

    if (inX === outX && inZ === outZ) {
      pieces.push({ gx, gz, key: i === 0 ? 'track-finish' : 'track-straight', orient: inX === 0 ? 0 : 16 });
      continue;
    }

    // A corner joins the side it's entered from, -in, and the side it leaves by, out. As Night Run's pieces show:
    // 0 opens onto -x and +z, 16 onto +x and +z, 10 onto +x and -z, 22 onto -x and -z.
    const sx = outX - inX;
    const sz = outZ - inZ;

    pieces.push({
      gx,
      gz,
      key: 'track-corner',
      orient: sx < 0 && sz > 0 ? 0 : sx > 0 && sz > 0 ? 16 : sx > 0 ? 10 : 22,
    });
  }

  return pieces;
}

/**
 * The walls the road pieces stand for: one box down each side of a straight or the finish, and segmented arcs round
 * the outside and the inside of a corner.
 * @param pieces - Road placements.
 * @returns The colliders, in the pieces' order.
 */
export function buildWallColliders(pieces: readonly Placement[]): WallSpec[] {
  const S = GRID_SCALE;
  const CELL_HALF = CELL_RAW / 2;
  const WALL_HALF_THICK = 0.25;
  const WALL_X = 4.75;
  const WALL_HALF_H = 1.5;

  const wallY = (0.5 + WALL_HALF_H) * S - 0.5;
  const hThick = WALL_HALF_THICK * S;
  const hHeight = WALL_HALF_H * S;
  const hLen = CELL_HALF * S;

  const ARC_SPAN = -Math.PI / 2;
  const ARC_CENTER_X = -CELL_HALF;
  const ARC_CENTER_Z = CELL_HALF;
  const OUTER_R = 2 * CELL_HALF - WALL_HALF_THICK;
  const OUTER_SEG = 8;
  const OUTER_SEG_HALF_LEN = ((OUTER_R * (Math.PI / 2)) / OUTER_SEG / 2) * S;
  const INNER_R = WALL_HALF_THICK;
  const INNER_SEG = 3;
  const INNER_SEG_HALF_LEN = ((INNER_R * (Math.PI / 2)) / INNER_SEG / 2) * S;

  const walls: WallSpec[] = [];

  for (const { gx, gz, key, orient } of pieces) {
    const cx = (gx + 0.5) * CELL_RAW * S;
    const cz = (gz + 0.5) * CELL_RAW * S;
    const deg = ORIENT_DEG[orient];
    const rad = (deg * Math.PI) / 180;
    const cr = Math.cos(rad);
    const sr = Math.sin(rad);

    if (key === 'track-straight' || key === 'track-finish') {
      for (const side of [-1, 1]) {
        const lx = side * WALL_X;
        const wx = cx + lx * cr * S;
        const wz = cz + -lx * sr * S;

        walls.push({
          halfExtents: [hThick, hHeight, hLen],
          position: [wx, wallY, wz],
          quaternion: [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)],
        });
      }
    } else if (key === 'track-corner') {
      const wcx = cx + (ARC_CENTER_X * cr + ARC_CENTER_Z * sr) * S;
      const wcz = cz + (-ARC_CENTER_X * sr + ARC_CENTER_Z * cr) * S;
      const arcStart = -rad;

      addArcWalls(walls, wcx, wcz, arcStart, OUTER_R, OUTER_SEG, OUTER_SEG_HALF_LEN, hThick, hHeight, ARC_SPAN, S);
      addArcWalls(walls, wcx, wcz, arcStart, INNER_R, INNER_SEG, INNER_SEG_HALF_LEN, hThick, hHeight, ARC_SPAN, S);
    }
  }

  return walls;
}

function addArcWalls(
  walls: WallSpec[],
  wcx: number,
  wcz: number,
  arcStart: number,
  radius: number,
  numSeg: number,
  segHalfLen: number,
  hThick: number,
  hHeight: number,
  arcSpan: number,
  scale: number,
): void {
  for (let i = 0; i < numSeg; i++) {
    const aMid = arcStart + ((i + 0.5) / numSeg) * arcSpan;
    const wx = wcx + radius * Math.cos(aMid) * scale;
    const wz = wcz + radius * Math.sin(aMid) * scale;
    const wallY = (0.5 + 1.5) * scale - 0.5;
    const halfAng = -aMid / 2;

    walls.push({
      halfExtents: [hThick, hHeight, segHalfLen],
      position: [wx, wallY, wz],
      quaternion: [0, Math.sin(halfAng), 0, Math.cos(halfAng)],
    });
  }
}
