import { PALETTE, paletteOf } from "../art/palette.ts"
import { onSide } from "../sim/index.ts"
import type { Side } from "../sim/index.ts"
import { ON_TWOS } from "./cues.ts"
import { angleOf, spread } from "./fx.ts"
import type { Fx } from "./fx.ts"

/**
 * The doors' beats in effects (docs/DESIGN.md, Doors), over the seals look poses: as a room locks, every seal slams
 * shut with an ink starburst in its doorway, a held drawing of it for two drawings, dust and stone kicked into the
 * room, speed lines driving down and a kick of the camera; as it clears, every seal breaks with a white light out of
 * the doorway, ink splatter and paper flecks thrown into the room, and the gate's split throws a wider glare.
 */

const inward = (side: Side) => onSide(side, -1)

/** The doorway's centre on the floor's edge, from the current room's view. */
const doorAt = (fx: Fx, side: Side) => fx.context.game.view().room?.doors.find((door) => door.side === side) ?? null

const slam = (fx: Fx, side: Side) => {
  const door = doorAt(fx, side)
  if (door === null) return
  const into = inward(side)
  const accent = paletteOf(fx.context.game.view().zone).danger
  const { x, z } = door
  const angle = angleOf(into.x, into.z)
  fx.layers.face.spawn({ frames: fx.f.burst, x: x + into.x * 0.4, y: 1, z: z + into.z * 0.4, size: 4.2, sizeEnd: 4.8, rotation: fx.rng() * Math.PI * 2, color: PALETTE.ink, life: 2 / ON_TWOS, fps: 0, alpha: 1, alphaEnd: 1 })
  fx.layers.flatGlow.spawn({ frames: fx.f.shock, x: x + into.x * 0.8, y: 0.06, z: z + into.z * 0.8, size: 1.5, sizeEnd: 6, color: accent, life: 0.35, alpha: 0.9, alphaEnd: 0 })
  for (let index = 0; index < 5; index++) {
    const along = spread(fx.rng, 1.4)
    fx.layers.flat.spawn({ frames: fx.f.speedline, x: x - into.z * along, y: 2.6 + fx.rng(), z: z + into.x * along, vy: -14, size: 1.8 + fx.rng() * 1.2, sizeEnd: 0.8, rotation: Math.PI / 2, life: 0.18, hold: 0.3, alpha: 0.9, alphaEnd: 0, clock: "real" })
  }
  for (let index = 0; index < 9; index++) {
    const direction = angle + spread(fx.rng, 0.9)
    const speed = 3 + fx.rng() * 5
    fx.layers.flat.spawn({ frames: index % 3 === 0 ? fx.f.pebble : fx.f.inkDrop, x: x + into.x * 0.5 + spread(fx.rng, 0.9), y: 0.3, z: z + into.z * 0.5 + spread(fx.rng, 0.9), vx: Math.cos(direction) * speed, vy: 2.5 + fx.rng() * 2, vz: Math.sin(direction) * speed, size: 0.12 + fx.rng() * 0.14, gravity: 18, ground: true, spin: 8, life: 0.6, hold: 0.5, alphaEnd: 0, color: PALETTE.ink })
  }
  for (let index = 0; index < 4; index++) {
    const distance = 0.6 + fx.rng() * 1.8
    const direction = angle + spread(fx.rng, 0.8)
    fx.layers.floor.spawn({ frames: fx.f.splats[index % 2] ?? fx.f.inkDrop, x: x + Math.cos(direction) * distance, y: 0.026, z: z + Math.sin(direction) * distance, size: 0.5 + fx.rng() * 0.6, rotation: fx.rng() * 6, life: 6, hold: 0.7, alpha: 0.75, alphaEnd: 0, fps: 0 })
  }
}

const shatter = (fx: Fx, side: Side, gate: boolean) => {
  const door = doorAt(fx, side)
  if (door === null) return
  const into = inward(side)
  const { x, z } = door
  const angle = angleOf(into.x, into.z)
  fx.layers.glow.spawn({ frames: fx.f.halo, x, y: 1, z, size: gate ? 7 : 3.2, sizeEnd: gate ? 11 : 4.4, color: 0xffffff, alpha: 0.8, life: gate ? 0.6 : 0.3, alphaEnd: 0, clock: "real" })
  fx.layers.flatGlow.spawn({ frames: fx.f.haloRing, x: x + into.x * 0.6, y: 0.05, z: z + into.z * 0.6, size: 1.2, sizeEnd: gate ? 10 : 6, color: 0xffffff, life: 0.4, alpha: 0.8, alphaEnd: 0, clock: "real" })
  for (let index = 0; index < (gate ? 18 : 10); index++) {
    const direction = angle + spread(fx.rng, 1.1)
    const speed = 4 + fx.rng() * 7
    const ink = index % 2 === 0
    fx.layers.flat.spawn({ frames: ink ? fx.f.inkDrop : fx.f.shard, x: x + spread(fx.rng, 1.3) * -into.z, y: 0.6 + fx.rng() * 0.8, z: z + spread(fx.rng, 1.3) * into.x, vx: Math.cos(direction) * speed, vy: 1.5 + fx.rng() * 3, vz: Math.sin(direction) * speed, size: ink ? 0.16 + fx.rng() * 0.16 : 0.5 + fx.rng() * 0.4, sizeEnd: 0.1, rotation: direction, gravity: 14, ground: true, spin: 6, life: 0.7, hold: 0.4, alphaEnd: 0, color: ink ? PALETTE.ink : 0xffffff, clock: "real" })
  }
  for (let index = 0; index < 4; index++) {
    const along = spread(fx.rng, 1.2)
    fx.layers.flat.spawn({ frames: fx.f.speedline, x: x - into.z * along + into.x * 0.4, y: 0.4, z: z + into.x * along + into.z * 0.4, vx: into.x * 9, vz: into.z * 9, rotation: angle, size: 2.4 + fx.rng() * 1.4, sizeEnd: 1.2, life: 0.22, hold: 0.3, alpha: 0.9, alphaEnd: 0, clock: "real" })
  }
}

export const installDoors = (fx: Fx): (() => void) => {
  const offs = [
    fx.context.moments.on("doorsLocked", (locked) => {
      for (const side of locked.sides) slam(fx, side)
      if (locked.sides.length === 0) return
      fx.context.rig.shake(0.22, { duration: 0.28, shape: "bump" })
      fx.context.rig.punch(2.5)
      fx.impacts.pulse("ink", 0.36)
    }),
    fx.context.moments.on("doorsOpened", (opened) => {
      const gate = fx.context.game.view().room?.doors.find((door) => door.mark === "gate")?.side ?? null
      for (const side of opened.sides) shatter(fx, side, side === gate)
      if (opened.sides.length > 0) fx.context.rig.shake(0.12, { duration: 0.25 })
    })
  ]
  return () => {
    for (const off of offs) off()
  }
}
