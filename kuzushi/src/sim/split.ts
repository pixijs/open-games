import { Clock } from "@typeonce/ritmo"

import { blocked } from "./arena.ts"
import type { Terrain } from "./arena.ts"
import { angleOf } from "./geometry.ts"
import type { Dir } from "./geometry.ts"
import { Actor, Body, EnemyState, Game, Health, HitMark, Motion, PrevBody } from "./schema.ts"
import { ENEMY, SPLITTER } from "./tuning.ts"

/** One splitling thrown out of a killed splitter. */
export interface Piece {
  readonly x: number
  readonly z: number
  readonly dirX: number
  readonly dirZ: number
}

/** Where a splitter killed at (x, z) by a blow along `dir` breaks: two pieces either side of the blow, thrown outward. */
export const piecesOf = (terrain: Terrain, x: number, z: number, dir: Dir): ReadonlyArray<Piece> =>
  [1, -1].map((side) => {
    const outX = -dir.z * side
    const outZ = dir.x * side
    const px = x + outX * SPLITTER.splitOffset
    const pz = z + outZ * SPLITTER.splitOffset
    const clear = !blocked(terrain.solid, px, pz, ENEMY.splitling.radius)
    return { x: clear ? px : x, z: clear ? pz : z, dirX: outX, dirZ: outZ }
  })

/** A splitling, already flying out and catching itself before it acts. */
export const splitlingDraft = (piece: Piece, play: Clock.Time<60>) => {
  const body = { x: piece.x, z: piece.z, facing: angleOf(piece.dirX, piece.dirZ) }
  const { hp } = ENEMY.splitling
  return Game.Command.spawn(
    [Actor, { kind: "splitling" }],
    [Body, body],
    [PrevBody, body],
    [Motion, { vx: piece.dirX * SPLITTER.splitSpeed, vz: piece.dirZ * SPLITTER.splitSpeed }],
    [Health, { hp, max: hp }],
    [HitMark, { swing: -1 }],
    [EnemyState, { _tag: "Recover", endAt: Clock.deadline(play, SPLITTER.splitRecover) }]
  )
}
