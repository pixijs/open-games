import { FlatMaterial, Geometry3D } from "@pixi/3d"

import { OVERLAY_BAND } from "../art/depth.ts"

/** A flat colour for an effect laid over the ground (telegraph arcs, ring waves, seams), its light added when `add`. */
export const overlayMaterial = (color: number, alpha: number, add = false): FlatMaterial => {
  const material = new FlatMaterial({ baseColor: color, extraBits: [OVERLAY_BAND], alphaMode: "blend", doubleSided: true })
  material.alpha = alpha
  if (add) material.state.blendMode = "add"
  return material
}

/**
 * A flat band on the ground that can be reshaped every drawing: part of an annulus from `inner` to `outer` between two
 * angles (the simulation's: 0 along +x, π/2 along +z), its vertices rewritten in place. Arc telegraphs, ring waves and
 * the sweeps' smears draw with it. u runs along the band from `from` to `to`, v from the inner edge to the outer.
 */
export class Band {
  readonly geometry: Geometry3D
  private readonly positions: Float32Array

  constructor(private readonly segments = 64) {
    const count = (segments + 1) * 2
    const positions = new Float32Array(count * 3)
    const normals = new Float32Array(count * 3)
    const uvs = new Float32Array(count * 2)
    const indices = new Uint16Array(segments * 6)
    for (let step = 0; step <= segments; step++) {
      for (let side = 0; side < 2; side++) {
        const vertex = step * 2 + side
        normals.set([0, 1, 0], vertex * 3)
        uvs.set([step / segments, side], vertex * 2)
      }
      if (step < segments) {
        const a = step * 2
        indices.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], step * 6)
      }
    }
    this.geometry = new Geometry3D({ positions, normals, uvs, indices, dynamic: true })
    this.positions = this.geometry.positions instanceof Float32Array ? this.geometry.positions : positions
  }

  /** Reshapes the band to the annulus from `inner` to `outer` between angles `from` and `to`. */
  set(from: number, to: number, inner: number, outer: number): void {
    const positions = this.positions
    for (let step = 0; step <= this.segments; step++) {
      const angle = from + ((to - from) * step) / this.segments
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const at = step * 6
      positions[at] = cos * inner
      positions[at + 1] = 0
      positions[at + 2] = sin * inner
      positions[at + 3] = cos * outer
      positions[at + 4] = 0
      positions[at + 5] = sin * outer
    }
    this.geometry.attributes.aPosition?.buffer.update()
  }

  destroy(): void {
    this.geometry.destroy()
  }
}
