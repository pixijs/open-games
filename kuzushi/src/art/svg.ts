import { Texture } from "pixi.js"

export interface SvgTextureOptions {
  /** Pixel width of the texture. */
  readonly width: number
  /** Pixel height; the SVG's own aspect ratio from its viewBox when left out. */
  readonly height?: number
  /** Repeat the texture past its edges, for tiling surfaces. */
  readonly repeat?: boolean
  /** Builds mipmaps, for textures drawn much smaller than their size. */
  readonly mipmaps?: boolean
  /** A label for debugging. */
  readonly label?: string
}

const aspectOf = (svg: string): number => {
  const match = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(svg)
  const width = Number(match?.[1])
  const height = Number(match?.[2])
  return width > 0 && height > 0 ? height / width : 1
}

/**
 * Rasterises an SVG string into a pixi Texture at a chosen pixel size, with the browser's full SVG support
 * (filters such as feTurbulence and feDisplacementMap, gradients, masks, text). The SVG needs an `xmlns` and a
 * `viewBox`; it is drawn to fill `width` by `height`. Await it once at startup and reuse the texture.
 *
 * @example
 * ```ts
 * const crescent = await svgTexture(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">...</svg>`, { width: 512 })
 * const material = new FlatMaterial({ baseColorTexture: crescent, alphaMode: "blend" })
 * ```
 */
export const svgTexture = async (svg: string, options: SvgTextureOptions): Promise<Texture> => {
  const width = Math.max(1, Math.round(options.width))
  const height = Math.max(1, Math.round(options.height ?? options.width * aspectOf(svg)))
  const image = new Image(width, height)
  image.decoding = "async"
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await image.decode()
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d")
  if (context === null) throw new Error("svgTexture: no 2D canvas context")
  context.drawImage(image, 0, 0, width, height)
  const texture = Texture.from(canvas)
  texture.label = options.label ?? "svg"
  const source = texture.source
  source.scaleMode = "linear"
  if (options.repeat === true) source.addressMode = "repeat"
  if (options.mipmaps === true) {
    source.autoGenerateMipmaps = true
    source.updateMipmaps()
  }
  return texture
}

export type SvgEntry = readonly [svg: string, options: SvgTextureOptions]

/** Rasterises several SVGs at once; resolves when all are ready, keyed like `entries`. */
export const svgTextures = async <Names extends string>(entries: Readonly<Record<Names, SvgEntry>>): Promise<Readonly<Record<Names, Texture>>> => {
  const pairs = await Promise.all(Object.entries<SvgEntry>(entries).map(async ([name, [svg, options]]) => [name, await svgTexture(svg, options)] as const))
  return Object.fromEntries(pairs) as Record<Names, Texture>
}
