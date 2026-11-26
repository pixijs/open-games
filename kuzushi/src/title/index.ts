import { Container3D } from "@pixi/3d"

import type { TitleCues } from "../art/title-cues.ts"
import type { Install } from "../host/types.ts"
import { makeCast } from "./cast.ts"
import { makeDirector } from "./director.ts"
import { makeTitleFx } from "./effects.ts"
import { makeSet } from "./set.ts"
import { loadTitleTextures } from "./textures.ts"

declare global {
  interface Window {
    /** The title scene's clock, for screenshot scripts that shoot a beat: `__title.time()` is seconds into its loop. It lands once loading ends. */
    __title?: { time(): number }
  }
}

/**
 * The title's 3D scene, shown while the flow is Title: the hero posed in the courtyard's centre circle inside a
 * ring of red shapes, a huge red sun low behind them, cloud shadows and wind, and a sakuga beat on a loop, cut
 * between designed camera shots. It answers the menu through `cues`. It never touches the simulation: the cast
 * is drawn by look's actor visuals from views the title writes. Off the title it hides at once (under the launch's
 * ink cover when a zone was chosen) and does no work. While loading it holds at t = 0 and its textures go to the GPU;
 * it starts its loop as loading ends.
 */
export const installTitle = (cues: TitleCues): Install => async (context) => {
  const [textures, effects] = await Promise.all([loadTitleTextures(), makeTitleFx(context)])
  const root = new Container3D({ label: "title" })
  context.layers.world.addChild(root)
  const set = makeSet(textures, root)
  const cast = makeCast(effects.fx.kit, context.layers.actors)
  const director = makeDirector(context, cast, set, effects)
  const off = cues.on((cue) => director.cue(cue))
  void context.loaded.then(() => {
    window.__title = { time: () => director.time }
  })

  let onTitle = false
  let held = context.loading
  const show = (on: boolean) => {
    root.visible = on
    cast.node.visible = on
    set.show(on)
    effects.show(on)
    if (!on) effects.clear()
  }
  show(false)

  return {
    update: (frame) => {
      const title = context.game.view().flow === "Title"
      if (title && !onTitle) {
        show(true)
        director.reset()
      } else if (!title && onTitle) {
        director.stop()
        show(false)
      }
      onTitle = title
      if (held && !context.loading && title) {
        effects.rewind()
        director.reset()
      }
      held = context.loading
      if (title) director.update(held ? { ...frame, dt: 0 } : frame)
    },
    warm: () => [{ label: "title", uploads: () => Object.values(textures).map((texture) => texture.source) }],
    dispose: () => {
      off()
      show(false)
      director.stop()
      effects.dispose()
      cast.dispose()
      set.dispose()
      root.destroy({ children: true })
      for (const texture of Object.values(textures)) texture.destroy(true)
    }
  }
}
