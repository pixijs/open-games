import { clamp } from "math"
import { Bounds, Graphics, GraphicsContext, GraphicsPath, SmoothGraphics, Sprite, Texture } from "pixi.js"
import type { FillInput } from "pixi.js"

import { svgTexture } from "../../art/svg.ts"
import { svgPaths } from "../brush.ts"
import type { Point } from "../brush.ts"
import { createLayer } from "./layer.ts"
import type { Layer } from "./layer.ts"

/**
 * brushStroke outlines filled in white, for SmoothGraphics (shareable between SmoothGraphics only). For opaque fills
 * only: each outline fills on its own, so a translucent or gradient fill doubles where bristles overlap the body and
 * restarts at every bristle. Those go through `inkLayer`, or a Layer of their own.
 */
export const inkContext = (shapes: ReadonlyArray<string>, fill: FillInput = 0xffffff, context = new GraphicsContext()): GraphicsContext => {
  for (const d of shapes) context.path(new GraphicsPath(d)).fill(fill)
  return context
}

export interface InkLayer extends Layer {
  /** Draws the brush's `units` box (e.g. 300x40) at width x height px and re-caches. */
  fit(width: number, height: number): void
}

/** A brush filled once: its outlines opaque white in a Layer, coloured with node.tint, made translucent with node.alpha. */
export const inkLayer = (shapes: ReadonlyArray<string>, units: { readonly width: number; readonly height: number }): InkLayer => {
  const layer = createLayer("ink")
  const brush = new SmoothGraphics(inkContext(shapes))
  layer.content.addChild(brush)
  return {
    ...layer,
    fit: (width, height) => {
      brush.scale.set(width / units.width, height / units.height)
      layer.refresh()
    }
  }
}

export interface SpineReveal {
  readonly mask: Graphics
  /** 0 to 1: drawn on from the start. */
  head: number
  /** 0 to 1: wiped off from the start. */
  tail: number
}

/**
 * A thick polyline along a brush's evenly spaced `points` between tail and head (ends interpolated between samples),
 * with butt ends, or round for the screen cut's. `head` and `tail` are accessors that redraw, so GSAP tweens them
 * directly. Lives in the brush's units, beside it under one scaled parent; put it on a wrapper as `mask`, never on a
 * cached node.
 */
export const spineReveal = (points: ReadonlyArray<Point>, width: number, cap: "butt" | "round" = "butt"): SpineReveal => {
  const mask = new Graphics()
  let head = 0
  let tail = 0
  const at = (t: number): Point => {
    const along = clamp(t, 0, 1) * (points.length - 1)
    const index = Math.min(points.length - 2, Math.floor(along))
    const [ax, ay] = points[index] as Point
    const [bx, by] = points[index + 1] as Point
    const k = along - index
    return [ax + (bx - ax) * k, ay + (by - ay) * k]
  }
  const draw = () => {
    mask.clear()
    if (head <= tail || points.length < 2) return
    const steps = points.length - 1
    const line = [at(tail)]
    for (let index = Math.floor(tail * steps) + 1; index < head * steps; index++) line.push(points[index] as Point)
    line.push(at(head))
    mask.poly(line.flat(), false).stroke({ width, cap, join: "round", color: 0xffffff })
  }
  return {
    mask,
    get head() {
      return head
    },
    set head(value) {
      head = value
      draw()
    },
    get tail() {
      return tail
    },
    set tail(value) {
      tail = value
      draw()
    }
  }
}

interface Size {
  readonly width: number
  readonly height: number
}

export interface BrushRaster {
  /** Placed in px from the brush's box's top-left; empty until the first draw is ready. */
  readonly sprite: Sprite
  /** Draws the brush's units box stretched to `size` px at `resolution`; a size and resolution already drawn do nothing. */
  fit(size: Size, resolution: number): void
}

/**
 * A brush drawn by the browser into a texture of its own at its size on screen, for exact coverage of bristles
 * thinner than a pixel, which SmoothGraphics widens to a pixel each (a thin brush's dry end drew as a solid wedge).
 * With `blur` (px), its drop-shadow glow instead, which needs no more than resolution 1. White: tint it. Each fit
 * remakes the texture and destroys the last, so nothing piles up as the window resizes; put it under a parent at a
 * whole-pixel position.
 */
export const brushRaster = (shapes: ReadonlyArray<string>, units: Size, blur = 0): BrushRaster => {
  const sprite = new Sprite(Texture.EMPTY)
  const bounds = new Bounds()
  for (const d of shapes) bounds.addBounds(new GraphicsPath(d).bounds)
  let current: Texture | null = null
  let wanted = ""
  sprite.once("destroyed", () => {
    current?.destroy(true)
    current = null
  })
  return {
    sprite,
    fit: (size, resolution) => {
      const key = `${size.width}x${size.height}@${resolution}`
      if (key === wanted) return
      wanted = key
      const sx = size.width / units.width
      const sy = size.height / units.height
      const reach = Math.ceil(3 * blur) + 1
      const x = Math.floor(bounds.minX * sx) - reach
      const y = Math.floor(bounds.minY * sy) - reach
      const width = Math.ceil(bounds.maxX * sx) + reach - x
      const height = Math.ceil(bounds.maxY * sy) + reach - y
      const filter = blur > 0 ? `<filter id="b" filterUnits="userSpaceOnUse" x="${x}" y="${y}" width="${width}" height="${height}"><feGaussianBlur stdDeviation="${blur}"/></filter>` : ""
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}">${filter}<g fill="#fff"${blur > 0 ? ` filter="url(#b)"` : ""}><g transform="scale(${sx} ${sy})">${svgPaths(shapes)}</g></g></svg>`
      void svgTexture(svg, { width: width * resolution, height: height * resolution, label: "brush" }).then((texture) => {
        if (key !== wanted || sprite.destroyed) {
          texture.destroy(true)
          return
        }
        const old = current
        current = texture
        sprite.texture = texture
        sprite.position.set(x, y)
        sprite.setSize(width, height)
        old?.destroy(true)
      })
    }
  }
}
