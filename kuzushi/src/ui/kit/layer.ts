import { Color, Container, FillGradient, Graphics } from "pixi.js"
import type { Rectangle } from "pixi.js"

/**
 * A group drawn once into a texture and composited as one: alpha and tint on `node` or any parent apply to the whole,
 * so shapes inside that overlap (a brush's bristles over its body) never double. Draw `content` at its on-screen size;
 * the cache is at the renderer's resolution. A mask on `node` renders nothing: mask a parent.
 *
 * Any brush or overlapping fill that is translucent or a gradient goes in a Layer: one path of overlapping outlines
 * fills each outline on its own in Pixi, and an AlphaFilter group doubles again once it or a parent is faded.
 */
export interface Layer {
  readonly node: Container
  readonly content: Container
  /** Re-caches after content changed, moved or was rescaled, or the resolution changed (call from layout). */
  refresh(): void
}

export const createLayer = (label: string): Layer => {
  const node = new Container({ label })
  const content = new Container()
  node.addChild(content)
  node.cacheAsTexture(true)
  return { node, content, refresh: () => node.updateCacheTexture() }
}

/**
 * A rect that erases what is under it inside a Layer by stops of [offset, alpha] along x or y (alpha 1 erases): a
 * fading mask. The stops run across `box`. Outside a Layer it punches through to the scene.
 */
export const eraseRamp = (box: Rectangle, stops: ReadonlyArray<readonly [offset: number, alpha: number]>, axis: "x" | "y"): Graphics => {
  const ramp = new FillGradient({
    start: { x: 0, y: 0 },
    end: axis === "x" ? { x: 1, y: 0 } : { x: 0, y: 1 },
    textureSpace: "local",
    colorStops: stops.map(([offset, alpha]) => ({ offset, color: new Color(0x000000).setAlpha(alpha) }))
  })
  const eraser = new Graphics().rect(box.x, box.y, box.width, box.height).fill(ramp)
  eraser.blendMode = "erase"
  eraser.once("destroyed", () => ramp.destroy())
  return eraser
}
