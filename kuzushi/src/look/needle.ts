import { Container3D, Mesh3D } from "@pixi/3d"

import { XRAY_BAND } from "../art/depth.ts"
import { paletteOfKind } from "../art/palette.ts"
import type { ActorVisual } from "../host/types.ts"
import { groundQuad, useKit } from "./actors.ts"
import { actorMaterial, setActorFx } from "./shaders/actor.ts"
import { spriteMaterial } from "./shaders/sprite.ts"
import { onTwos } from "./twos.ts"

/** How a needle Sunder fires is drawn: a lancer's needle, longer, flat out at its height, with a violet streak behind. */
const NEEDLE = { scale: 1.5, height: 0.55 } as const

export const needleVisual = (): ActorVisual => {
  const parts = useKit()
  const look = parts.looks.lancer
  const accent = paletteOfKind("sunder").danger
  const material = actorMaterial(look, [XRAY_BAND])
  const streakMaterial = spriteMaterial(parts.textures.streak, accent, 2.4, "add")
  const poolMaterial = spriteMaterial(parts.textures.glow, accent, 0.8, "add")
  const node = new Container3D({ label: "needle" })
  const turn = new Container3D({ position: { x: 0, y: NEEDLE.height, z: 0 } })
  const body = new Container3D({ scale: { x: NEEDLE.scale, y: 1, z: NEEDLE.scale * 0.8 } })
  body.addChild(
    new Mesh3D({ geometry: parts.rims.lancer, material: parts.ink, castShadow: false, receiveShadow: false }),
    new Mesh3D({ geometry: parts.bodies.lancer, material, castShadow: true, receiveShadow: false })
  )
  const streak = new Mesh3D({ geometry: parts.quad, material: streakMaterial, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, position: { x: -1.5, y: 0.02, z: 0 }, scale: { x: 2.8, y: 0.3, z: 1 }, castShadow: false, receiveShadow: false })
  turn.addChild(streak, body)
  node.addChild(groundQuad(parts.shadow, 0.7, 0.012), groundQuad(poolMaterial, 1.6, 0.018), turn)
  return {
    node,
    place: (x, z) => node.position.set(x, 0, z),
    update: (actor, frame) => {
      if (actor.role !== "orb") return
      turn.rotation.y = -Math.atan2(actor.orb.dirZ, actor.orb.dirX)
      const flicker = onTwos(frame)
      setActorFx(material, look, { glow: look.glow * (flicker ? 1.6 : 1.25), flash: flicker ? 0.25 : 0 })
      streak.scale.set(flicker ? 2.8 : 3.2, 0.3, 1)
    },
    destroy: () => {
      node.destroy({ children: true })
      material.destroy()
      streakMaterial.destroy()
      poolMaterial.destroy()
    }
  }
}
