import { Container3D } from "@pixi/3d"

import type { HostContext } from "../host/types.ts"
import { ArcPool } from "../vfx/arcs.ts"
import { makeCues } from "../vfx/cues.ts"
import type { Clocks } from "../vfx/cues.ts"
import { isInked, setImpact } from "../vfx/frame.ts"
import { cosmeticRng } from "../vfx/fx.ts"
import type { Fx, Layers } from "../vfx/fx.ts"
import { makeImpacts } from "../vfx/impacts.ts"
import { framesOf, loadKit } from "../vfx/kit.ts"
import { SpriteLayer } from "../vfx/particles.ts"
import { Screen } from "../vfx/screen.ts"

export interface TitleFx {
  /** What vfx's drawing helpers take: the title's own layers, cues, arcs, screen and impacts, on the title's clock. */
  readonly fx: Fx
  /** Camera-facing wind streaks, drawn over the world. */
  readonly air: SpriteLayer
  /** Advances every effect by `dt` seconds of title time; 0 holds them on their drawing. */
  update(dt: number): void
  /** Hides or shows everything the effects draw. */
  show(on: boolean): void
  /** Ends every effect at once and gives the frame back clean. */
  clear(): void
  /** Starts the effects' random draws over, as on a fresh page: the title does so as loading ends. */
  rewind(): void
  dispose(): void
}

/** Seeds the title effects' random draws: wind, sprays, crescents' strokes and shards. */
const RANDOM_SEED = 0x7171

/**
 * The title's effects: the same hand-drawn atlas, crescents, screen layer and rationed impact frames the game's
 * effects use (from src/vfx), in layers of its own that run on the title's clock, so the title's beats play while
 * the game's effects stand still and never share a pool with a run.
 */
export const makeTitleFx = async (context: HostContext): Promise<TitleFx> => {
  const kit = await loadKit()
  const root = new Container3D({ label: "title-fx" })
  context.layers.effects.addChild(root)
  const layer = (label: string, capacity: number, billboard: "horizontal" | "spherical", blendMode: "normal" | "add", order: number) =>
    new SpriteLayer({ frames: kit.frames, capacity, billboard, blendMode, label, parent: root, onTop: billboard === "spherical", order })
  const layers: Layers = {
    floor: layer("title-floor", 260, "horizontal", "normal", 500),
    flat: layer("title-flat", 400, "horizontal", "normal", 0.4),
    flatGlow: layer("title-flat-glow", 80, "horizontal", "add", 0.3),
    glow: layer("title-glow", 120, "spherical", "add", 0.2),
    face: layer("title-face", 60, "spherical", "normal", 0.1)
  }
  const air = layer("title-air", 80, "spherical", "normal", 0.15)
  const all = [...Object.values(layers), air]
  const screen = new Screen(kit.focusLines, kit.screenSlashes, kit.vignette)
  context.layers.screen.addChild(screen.root)
  const resize = () => screen.resize(context.app.screen.width, context.app.screen.height)
  resize()
  context.app.renderer.on("resize", resize)
  const cues = makeCues()
  const clocks: Clocks = { game: 0, real: 0 }
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
  let now = 0
  let random = cosmeticRng(RANDOM_SEED)
  const fx: Fx = {
    context,
    kit,
    f: framesOf(kit),
    cues,
    impacts: makeImpacts(cues, context.frame, screen, () => now, () => reducedMotion.matches),
    arcs: new ArcPool(kit, root),
    layers,
    screen,
    frame: context.frame,
    rng: () => random()
  }

  const clear = () => {
    cues.clear()
    fx.arcs.hideAll()
    for (const each of all) each.clear()
    screen.clear()
    setImpact(context.frame, "none")
  }

  return {
    fx,
    air,
    update: (dt) => {
      now += dt
      clocks.game = dt
      clocks.real = dt
      cues.update(clocks)
      screen.setInked(isInked(context.frame.get()))
      const camera = context.view.camera.position
      for (const each of all) {
        each.sortFrom(camera)
        each.update(clocks)
      }
    },
    show: (on) => {
      root.visible = on
      screen.root.visible = on
    },
    clear,
    rewind: () => {
      random = cosmeticRng(RANDOM_SEED)
    },
    dispose: () => {
      clear()
      context.app.renderer.off("resize", resize)
      for (const each of all) each.destroy()
      fx.arcs.destroy()
      root.destroy({ children: true })
      screen.root.destroy({ children: true })
    }
  }
}
