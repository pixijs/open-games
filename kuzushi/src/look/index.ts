import type { Install } from "../host/types.ts"
import { prepareActors } from "./actors.ts"
import { addAtmosphere } from "./atmosphere.ts"
import { addLighting } from "./lighting.ts"
import { installPost } from "./post.ts"
import { loadTextures } from "./textures.ts"
import { loadRoomKit, makeRoomArt } from "./rooms/index.ts"
import { makeLookWarm } from "./warm.ts"
import { addWorlds } from "./worlds.ts"

export { createActorVisual } from "./actors.ts"

/**
 * How the world looks: the stage's ink-and-paper world (the Courtyard, the Spiral or the Void) and its sun, the
 * actors' shared parts, bloom and the finishing grade. Actor visuals come from `createActorVisual` in ./actors.ts,
 * which the render systems call. vfx drives the grade's whole-frame looks through `HostContext.frame`
 * (src/art/frame.ts).
 */
export const installLook: Install = async (context) => {
  const [textures, kit] = await Promise.all([loadTextures(), loadRoomKit()])
  const sun = addLighting(context.view)
  const art = makeRoomArt(context.app.renderer, () => context.loading)
  void art.prepare("courtyard")
  const deps = { textures, kit, art, sun, camera: context.view.camera }
  const worlds = addWorlds(context, deps, context.layers.world)
  const releaseActors = prepareActors(textures, context.view.camera, worlds.occluders, () => context.ground.pale, () => context.game.view().boss, () => context.game.view().zone)
  const atmosphere = addAtmosphere(context, textures)
  const post = installPost(context)
  const warm = makeLookWarm(deps)
  return {
    update: (frame) => {
      worlds.update(frame)
      atmosphere.update(frame)
      post.update(frame)
    },
    warm: () => [warm],
    dispose: () => {
      post.dispose()
      atmosphere.dispose()
      sun.destroy()
      worlds.dispose()
      art.destroy()
      kit.destroy()
      releaseActors()
      textures.destroy()
    }
  }
}
