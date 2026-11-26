import type { Camera3D, Container3D, DirectionalLight } from "@pixi/3d"

import type { FrameTime, HostContext } from "../host/types.ts"
import { ARENA } from "../sim/index.ts"
import type { GameView, StageId } from "../sim/index.ts"
import { buildArena } from "./arena.ts"
import { aimSun, COURTYARD_SUN } from "./lighting.ts"
import type { Occluders } from "./occlusion.ts"
import { buildRoom, gateSide } from "./rooms/index.ts"
import type { RoomDeps } from "./rooms/index.ts"
import { buildSpiral } from "./spiral.ts"
import type { LookTextures } from "./textures.ts"
import { buildVoid } from "./void.ts"

/** One world on screen (a stage's or a room's): its node in the scene, the solids that can hide an actor, its floor's tone, and its per-frame life. */
export interface World {
  readonly node: Container3D
  readonly occluders: Occluders
  /** Its floor is near white, so effects draw with ink edges on it (`HostContext.ground`). */
  readonly pale: boolean
  update(view: GameView, frame: FrameTime): void
  dispose(): void
}

const COURTYARD_OCCLUDERS: Occluders = { blocks: [...ARENA.blocks, ...ARENA.backdrop], pillars: ARENA.pillars }
/** A debug scene's open floor hides the world under it, and nothing stands on it. */
const NO_OCCLUDERS: Occluders = { blocks: [], pillars: [] }

const buildStage = (stage: StageId, textures: LookTextures, sun: DirectionalLight, camera: Camera3D): World => {
  switch (stage) {
    case "courtyard": {
      const arena = buildArena(textures)
      aimSun(sun, COURTYARD_SUN)
      return { node: arena.node, occluders: COURTYARD_OCCLUDERS, pale: false, update: () => {}, dispose: arena.dispose }
    }
    case "spiral": return buildSpiral(textures, sun, camera)
    case "void": return buildVoid(textures, sun)
  }
}

/**
 * What is on screen, as a key that changes exactly when the world must be rebuilt: the title's courtyard, a zone's
 * classic arena (the sandbox), or a room of a dungeon (its zone, index, template, mirroring, doorways and how many
 * pillars still stand, should a boss break one). A boss room's gate is built shut and opens in place, so it is left
 * out.
 */
const shownKey = (view: GameView): string => {
  if (view.flow === "Title") return "stage:courtyard"
  const room = view.room
  if (room === null) return `stage:${view.zone}`
  const gate = gateSide(view.zone, room)
  const doors = room.doors.filter((door) => door.side !== gate).map((door) => door.side)
  return `room:${view.zone}:${room.index}:${room.template}:${room.mirror.x}:${room.mirror.z}:${doors.join(",")}:${room.layout.pillars.length}`
}

const build = (view: GameView, deps: RoomDeps): World => {
  if (view.flow === "Title" || view.room === null) return buildStage(view.flow === "Title" ? "courtyard" : view.zone, deps.textures, deps.sun, deps.camera)
  void deps.art.prepare(view.zone, view.room.template)
  return buildRoom(view.zone, view.room, deps)
}

/**
 * The world on screen: the title's courtyard, a sandbox's classic arena, or the dungeon room the player is in (only
 * that room exists; it is rebuilt as a transition swaps rooms under cover). Fed the view each frame. It tells the
 * effects whether the floor on screen is pale; a debug scene's measuring grid, laid over the world, is neither pale
 * nor hides anyone.
 */
export const addWorlds = (context: HostContext, deps: RoomDeps, layer: Container3D) => {
  let shown = shownKey(context.game.view())
  let world = build(context.game.view(), deps)
  layer.addChild(world.node)
  return {
    occluders: (): Occluders => (context.game.view().debug.openFloor ? NO_OCCLUDERS : world.occluders),
    update: (frame: FrameTime) => {
      const view = context.game.view()
      const key = shownKey(view)
      if (key !== shown) {
        world.dispose()
        shown = key
        world = build(view, deps)
        layer.addChild(world.node)
      }
      world.update(view, frame)
      context.ground.pale = world.pale && !view.debug.openFloor
    },
    dispose: () => world.dispose()
  }
}
