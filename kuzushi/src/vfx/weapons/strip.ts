import { Container3D, FlatMaterial, Mesh3D, PlaneGeometry } from "@pixi/3d"
import type { Texture } from "pixi.js"

const quad = new PlaneGeometry({ width: 1, height: 1, flipV: true })

/** A flat strip lying over the ground from a point along a direction: the pierce's streak, the charge's aim line. */
export class GroundStrip {
  readonly node = new Container3D({ label: "band" })
  readonly material: FlatMaterial
  private readonly mesh: Mesh3D

  constructor(texture: Texture, parent: Container3D, color = 0xffffff, additive = false) {
    this.material = new FlatMaterial({ baseColor: color, baseColorTexture: texture, alphaMode: "blend", doubleSided: true })
    if (additive) this.material.state.blendMode = "add"
    this.mesh = new Mesh3D({ geometry: quad, material: this.material, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, castShadow: false, receiveShadow: false })
    this.node.addChild(this.mesh)
    this.node.visible = false
    parent.addChild(this.node)
  }

  /** From (x, y, z) along `angle` (simulation radians), `length` long and `width` across. */
  place(x: number, y: number, z: number, angle: number, length: number, width: number, alpha = 1): void {
    this.node.position.set(x, y, z)
    this.node.rotation.y = -angle
    this.mesh.position.set(length / 2, 0, 0)
    this.mesh.scale.set(Math.max(0.001, length), width, 1)
    this.material.alpha = alpha
    this.node.visible = alpha > 0
  }

  hide(): void {
    this.node.visible = false
  }

  destroy(): void {
    this.node.destroy({ children: true })
    this.material.destroy()
  }
}
