import type { Pass3D, View3D } from "@pixi/3d"

import type { PostStack } from "./types.ts"

export const makePostStack = (view: View3D): PostStack => {
  const layers: Record<"look" | "vfx", ReadonlyArray<Pass3D>> = { look: [], vfx: [] }
  return {
    set: (layer, passes) => {
      layers[layer] = passes
      view.passes = [...layers.look, ...layers.vfx]
    }
  }
}
