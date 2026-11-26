import { Color, Graphics, Matrix, Texture } from "pixi.js"
import type { Rectangle } from "pixi.js"

export interface Scrim {
  readonly node: Graphics
  /** Covers `box` with the gradient's ellipse of radii [rx, ry] px round its centre; beyond the last stop it holds that stop. */
  fit(box: Rectangle, radii: readonly [rx: number, ry: number]): void
}

/** The gradient's texture, px square. */
const SIZE = 256

/**
 * Elliptical radial-gradient backings: stops of [offset, colour, alpha] from the centre out, the centre given as shares
 * of the box (`[0, 1]` is its bottom-left corner, the HUD's `at 0% 100%`). It draws a circle's gradient in absolute
 * units and squashes it into the ellipse, rather than trusting a gradient normalised to a shape. A screen's veil is
 * `ellipse at 50% 50%`, farthest-corner: radii (W/2)·√2 by (H/2)·√2.
 *
 * Its texture is drawn here, not by FillGradient: a radial FillGradient lays its last stop under the whole circle, so
 * a veil that darkens outward (.2 in the middle, .72 at the edge) comes out .72 or more everywhere.
 */
export const radialScrim = (stops: ReadonlyArray<readonly [offset: number, color: number, alpha: number]>, centre: readonly [cx: number, cy: number]): Scrim => {
  const node = new Graphics()
  let texture: Texture | null = null
  node.once("destroyed", () => texture?.destroy(true))
  return {
    node,
    fit: (box, [rx, ry]) => {
      const radius = Math.max(1, rx)
      const squash = Math.max(1, ry) / radius
      const x = box.x + centre[0] * box.width
      const y = box.y + centre[1] * box.height
      const left = box.x - x
      const top = (box.y - y) / squash
      const right = box.right - x
      const bottom = (box.bottom - y) / squash
      /** The texture's half-width: past the gradient's end to the box's farthest corner, so it never repeats inside the box. */
      const reach = Math.max(radius, Math.hypot(Math.max(-left, right), Math.max(-top, bottom)))
      const canvas = document.createElement("canvas")
      canvas.width = SIZE
      canvas.height = SIZE
      const context = canvas.getContext("2d")
      if (context === null) return
      const gradient = context.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, (SIZE / 2) * (radius / reach))
      for (const [offset, color, alpha] of stops) gradient.addColorStop(offset, new Color(color).setAlpha(alpha).toRgbaString())
      context.fillStyle = gradient
      context.fillRect(0, 0, SIZE, SIZE)
      const old = texture
      texture = Texture.from(canvas)
      node.position.set(x, y)
      node.scale.set(1, squash)
      const matrix = new Matrix().scale((2 * reach) / SIZE, (2 * reach) / SIZE).translate(-reach, -reach)
      node.clear().rect(left, top, right - left, bottom - top).fill({ texture, matrix, textureSpace: "global" })
      old?.destroy(true)
    }
  }
}
