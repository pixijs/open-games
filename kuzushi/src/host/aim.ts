import { Plane, Vector3 } from "@pixi/3d"
import type { View3D } from "@pixi/3d"

import type { GameView } from "../sim/index.ts"
import type { IntentApi } from "./types.ts"

/** How long after the mouse last moved or clicked it still aims; after that the player faces where it runs. */
const MOUSE_AIM_SECONDS = 2

/**
 * Turns the mouse into aim intents: while the mouse is in use, the point under it on the ground goes to the
 * simulation every frame; when it rests, aim is released to the keys.
 */
export const makeMouseAim = (canvas: HTMLCanvasElement, view: View3D, intents: IntentApi) => {
  const ground = new Plane(new Vector3(0, 1, 0), 0)
  const hit = new Vector3()
  const pointer = { x: 0, y: 0 }
  let usedAt = Number.NEGATIVE_INFINITY
  let aiming = false
  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return
    const bounds = canvas.getBoundingClientRect()
    pointer.x = event.clientX - bounds.left
    pointer.y = event.clientY - bounds.top
    usedAt = performance.now() / 1000
  }
  canvas.addEventListener("pointermove", onMove)
  canvas.addEventListener("pointerdown", onMove)
  return {
    update: (game: GameView) => {
      if (game.flow !== "Playing") return
      const active = performance.now() / 1000 - usedAt < MOUSE_AIM_SECONDS
      if (active && view.screenToWorld(pointer, ground, hit) !== null) {
        intents.send({ type: "aim", x: hit.x, z: hit.z })
        aiming = true
      } else if (aiming && !active) {
        intents.send({ type: "aimFree" })
        aiming = false
      }
    },
    dispose: () => {
      canvas.removeEventListener("pointermove", onMove)
      canvas.removeEventListener("pointerdown", onMove)
    }
  }
}
