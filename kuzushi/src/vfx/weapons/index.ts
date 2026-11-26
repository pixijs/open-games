import { Container3D } from "@pixi/3d"

import type { FrameTime } from "../../host/types.ts"
import type { WeaponId } from "../../sim/index.ts"
import { ON_TWOS } from "../cues.ts"
import { drawnAt } from "../fx.ts"
import type { Fx } from "../fx.ts"
import { installBreaker } from "./breaker.ts"
import { installDarts } from "./darts.ts"
import { loadWeaponKit } from "./kit.ts"
import { installSigils } from "./sigils.ts"

/** A weapon coming into hand: a white brush ring closing on the hero and a glint at its tip. */
const equip = (fx: Fx) => {
  const player = fx.context.game.view().player
  if (player === null) return
  const { x, z } = drawnAt(fx, player.id, player)
  fx.layers.flat.spawn({ frames: fx.f.weapon.brushRing, x, y: 0.3, z, size: 3.2, sizeEnd: 1.2, rotation: fx.rng() * 6, life: 3 / ON_TWOS, alpha: 1, alphaEnd: 0.4 })
  fx.layers.glow.spawn({ frames: fx.f.glint, x: x + Math.cos(player.facing) * 0.55, y: 0.65, z: z + Math.sin(player.facing) * 0.55, size: 2, sizeEnd: 0.3, rotation: 0.78, life: 0.2, alpha: 1 })
  fx.context.rig.punch(1)
}

/**
 * Every weapon's own effects beside the blade's crescents (../slashes.ts): the breaker's cleave and slam, the darts'
 * shots, trails and charge, the sigils' rings and bursts, and a flourish as a weapon comes into hand. Effects run on
 * the game clock and on twos like the rest.
 */
export const installWeapons = async (fx: Fx) => {
  const kit = await loadWeaponKit(fx.kit.noise)
  const root = new Container3D({ label: "vfx-weapons" })
  fx.context.layers.effects.addChild(root)
  const breaker = installBreaker(fx, kit, root)
  const darts = installDarts(fx, kit, root)
  const sigils = installSigils(fx, kit, root)
  let held: WeaponId | null = null
  return {
    kit,
    update: (frame: FrameTime) => {
      const view = fx.context.game.view()
      if (view.flow === "Playing" && held !== null && view.weapon.id !== held) equip(fx)
      held = view.flow === "Playing" ? view.weapon.id : null
      darts.update(frame)
      sigils.update(frame)
    },
    clear: () => {
      held = null
      breaker.clear()
      darts.clear()
      sigils.clear()
    },
    dispose: () => {
      breaker.dispose()
      darts.dispose()
      sigils.dispose()
      root.destroy({ children: true })
      kit.destroy()
    }
  }
}
