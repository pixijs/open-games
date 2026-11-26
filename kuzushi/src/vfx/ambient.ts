import { PALETTE } from "../art/palette.ts"
import type { Clocks } from "./cues.ts"
import { spread } from "./fx.ts"
import type { Fx } from "./fx.ts"

/** The wind: one slow drift direction for the shard lines, up the screen and to the right. */
const WIND = -0.62
const REACH = 11

/**
 * The air of a fight, as on the concept boards: white shard lines sliding across the floor on the wind and red
 * embers rising, thicker the more enemies are up, around wherever the player is.
 */
export const installAmbient = (fx: Fx) => {
  let shardDebt = 0
  let emberDebt = 0
  return (clocks: Clocks) => {
    if (clocks.game === 0) return
    const view = fx.context.game.view()
    const player = view.player
    if (player === null) return
    const heat = Math.min(1, view.enemies.length / 6)
    shardDebt += clocks.game * (2 + heat * 7)
    emberDebt += clocks.game * (1.5 + heat * 4)
    for (; shardDebt >= 1; shardDebt -= 1) {
      const angle = WIND + spread(fx.rng, 0.12)
      const speed = 6 + fx.rng() * 5
      fx.layers.flat.spawn({
        frames: fx.f.speedline,
        x: player.x + spread(fx.rng, REACH * 1.4),
        y: 0.9 + fx.rng() * 0.6,
        z: player.z + spread(fx.rng, REACH * 0.8),
        vx: Math.cos(angle) * speed,
        vz: Math.sin(angle) * speed,
        rotation: angle,
        size: 1.2 + fx.rng() * 1.8,
        alpha: 0.55,
        alphaEnd: 0,
        hold: 0.5,
        life: 0.45
      })
    }
    for (; emberDebt >= 1; emberDebt -= 1) {
      fx.layers.glow.spawn({
        frames: fx.f.ember,
        x: player.x + spread(fx.rng, REACH * 1.2),
        y: 0.1,
        z: player.z + spread(fx.rng, REACH * 0.7),
        vx: Math.cos(WIND) * 0.6,
        vy: 0.7 + fx.rng() * 0.8,
        vz: Math.sin(WIND) * 0.6,
        size: 0.09 + fx.rng() * 0.07,
        color: PALETTE.red,
        alpha: 0.9,
        alphaEnd: 0,
        hold: 0.4,
        life: 1.6 + fx.rng()
      })
    }
  }
}
