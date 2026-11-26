import { Sprite, Texture } from "pixi.js"

import { svgTexture } from "../../art/svg.ts"

interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const blurred = new Map<string, Promise<Texture>>()
/** The textures already drawn, so a glow asked for again shows on its first frame. */
const drawn = new Map<string, Texture>()

/**
 * `svgBody` (white shapes in the viewBox's units) blurred by `blur` (the feGaussianBlur's deviation, in those units)
 * and rasterised at `pixels`, once per `key`: a static brush's glow.
 */
const blurTexture = (svgBody: string, viewBox: Box, blur: number, pixels: { readonly width: number; readonly height: number }, key: string): Promise<Texture> => {
  const known = blurred.get(key)
  if (known !== undefined) return known
  const { x, y, width, height } = viewBox
  const loading = svgTexture(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}"><filter id="b" filterUnits="userSpaceOnUse" x="${x}" y="${y}" width="${width}" height="${height}"><feGaussianBlur stdDeviation="${blur}"/></filter><g fill="#fff" filter="url(#b)">${svgBody}</g></svg>`,
    { ...pixels, label: `glow ${key}` }
  ).then((texture) => {
    drawn.set(key, texture)
    return texture
  })
  blurred.set(key, loading)
  return loading
}

/**
 * A Sprite of the glow covering its viewBox in the same units; empty until the texture is first drawn, after which
 * every glow of that `key` has it at once. Tint it the glow's colour. `ready` hears when a glow that waited lands, for
 * an owner that caches it into a Layer.
 */
export const blurSprite = (svgBody: string, viewBox: Box, blur: number, pixels: { readonly width: number; readonly height: number }, key: string, ready?: () => void): Sprite => {
  const sprite = new Sprite(Texture.EMPTY)
  sprite.position.set(viewBox.x, viewBox.y)
  const show = (texture: Texture) => {
    sprite.texture = texture
    sprite.setSize(viewBox.width, viewBox.height)
  }
  const known = drawn.get(key)
  if (known !== undefined) {
    show(known)
    return sprite
  }
  void blurTexture(svgBody, viewBox, blur, pixels, key).then((texture) => {
    if (sprite.destroyed) return
    show(texture)
    ready?.()
  })
  return sprite
}
