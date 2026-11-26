import { Container3D } from "@pixi/3d"

import { paletteOf } from "../art/palette.ts"
import type { Install } from "../host/types.ts"
import { installAmbient } from "./ambient.ts"
import { ArcPool } from "./arcs.ts"
import { installBeam } from "./beam.ts"
import { installBossEffects } from "./bosses.ts"
import { installCombat } from "./combat.ts"
import { installDoors } from "./doors.ts"
import { advanceClocks, makeCues } from "./cues.ts"
import { installEdges } from "./edges.ts"
import { installExits } from "./exits.ts"
import { installEnemyEffects } from "./enemies.ts"
import { installFoes } from "./foes.ts"
import { isInked } from "./frame.ts"
import { cosmeticRng } from "./fx.ts"
import type { Fx, Layers } from "./fx.ts"
import { makeImpacts } from "./impacts.ts"
import { framesOf, loadKit } from "./kit.ts"
import { SpriteLayer } from "./particles.ts"
import { Screen } from "./screen.ts"
import { installSlashes } from "./slashes.ts"
import { installSpecial } from "./special.ts"
import { installSeams } from "./seams.ts"
import { installTelegraphs } from "./telegraphs.ts"
import { installTrails } from "./trails.ts"
import { installTransitions } from "./transitions.ts"
import { installWaves } from "./waves.ts"
import { installWeapons } from "./weapons/index.ts"

/**
 * Every transient effect, drawn like hand-made anime effects: SVG drawings rasterised once, played on twos
 * on the game clock (so hit-stop holds them as key poses and slow motion slows them), plus the special's
 * choreography on the real clock while the world stands frozen, and the camera's kicks.
 */
export const installVfx: Install = async (context) => {
  const kit = await loadKit()
  const root = new Container3D({ label: "vfx" })
  context.layers.effects.addChild(root)
  const layer = (label: string, capacity: number, billboard: "horizontal" | "spherical", blendMode: "normal" | "add", order: number) =>
    new SpriteLayer({ frames: kit.frames, capacity, billboard, blendMode, label, parent: root, onTop: billboard === "spherical", order })
  const layers: Layers = {
    floor: layer("vfx-floor", 600, "horizontal", "normal", 500),
    flat: layer("vfx-flat", 900, "horizontal", "normal", 0.4),
    flatGlow: layer("vfx-flat-glow", 200, "horizontal", "add", 0.3),
    glow: layer("vfx-glow", 400, "spherical", "add", 0.2),
    face: layer("vfx-face", 200, "spherical", "normal", 0.1)
  }
  const screen = new Screen(kit.focusLines, kit.screenSlashes, kit.vignette)
  context.layers.screen.addChild(screen.root)
  const resize = () => screen.resize(context.app.screen.width, context.app.screen.height)
  resize()
  context.app.renderer.on("resize", resize)
  const cues = makeCues()
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
  const fx: Fx = {
    context,
    kit,
    f: framesOf(kit),
    cues,
    impacts: makeImpacts(cues, context.frame, screen, () => context.time.elapsed, () => reducedMotion.matches),
    arcs: new ArcPool(kit, root),
    layers,
    screen,
    frame: context.frame,
    rng: cosmeticRng(0x5a6a)
  }
  const slashes = installSlashes(fx)
  const offCombat = installCombat(fx)
  const offEnemies = installEnemyEffects(fx)
  const trails = installTrails(fx)
  const telegraphs = installTelegraphs(fx)
  const special = installSpecial(fx)
  const ambient = installAmbient(fx)
  const beam = installBeam(fx)
  const foes = installFoes(fx)
  const waves = installWaves(fx)
  const seams = installSeams(fx)
  const offBosses = installBossEffects(fx)
  const offEdges = installEdges(fx)
  const weapons = await installWeapons(fx)
  const offDoors = installDoors(fx)
  const transitions = await installTransitions(fx)
  const exits = await installExits(fx)
  const allLayers = Object.values(layers)

  const clear = () => {
    fx.cues.clear()
    weapons.clear()
    special.clear()
    trails.clear()
    foes.clear()
    waves.clear()
    seams.clear()
    telegraphs.clear()
    fx.arcs.hideAll()
    for (const each of allLayers) each.clear()
    screen.clear()
    exits.clear()
  }
  const clearAll = () => {
    clear()
    transitions.clear()
  }
  const offRun = [
    context.moments.on("runStarted", clearAll),
    context.moments.on("quit", clearAll),
    context.moments.on("roomSwapped", clear)
  ]
  const clocks = { game: 0, real: 0 }

  return {
    update: (time) => {
      const view = context.game.view()
      advanceClocks(clocks, time, view.flow !== "Paused" && view.flow !== "Title")
      slashes.update()
      trails.update(clocks)
      ambient(clocks)
      telegraphs.update(time)
      beam.update(time)
      foes.update(time.gameElapsed, time.gameDt)
      waves.update(time.gameDt)
      seams.update(time.gameElapsed)
      weapons.update(time)
      special.update(clocks.real)
      transitions.update(time)
      exits.update(time)
      fx.cues.update(clocks)
      const colors = paletteOf(view.flow === "Title" ? "courtyard" : view.zone)
      screen.setZoneColors(colors.danger, colors.ink)
      screen.setInked(isInked(context.frame.get()))
      const camera = context.view.camera.position
      for (const each of allLayers) {
        each.sortFrom(camera)
        each.update(clocks)
      }
    },
    warm: () => [{ label: "vfx", uploads: () => [...kit.all, ...weapons.kit.all].map((texture) => texture.source) }],
    dispose: () => {
      for (const off of offRun) off()
      slashes.dispose()
      offCombat()
      offEnemies()
      trails.dispose()
      telegraphs.dispose()
      special.dispose()
      beam.dispose()
      foes.dispose()
      waves.dispose()
      seams.dispose()
      offBosses()
      offEdges()
      offDoors()
      transitions.dispose()
      exits.dispose()
      clear()
      weapons.dispose()
      context.app.renderer.off("resize", resize)
      context.frame.reset()
      for (const each of allLayers) each.destroy()
      fx.arcs.destroy()
      root.destroy({ children: true })
      screen.root.destroy({ children: true })
      kit.destroy()
    }
  }
}
