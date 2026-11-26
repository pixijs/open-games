import { GraphicsContext } from "pixi.js"

import { hex, PALETTE } from "../../art/palette.ts"

const contexts = new Map<string, GraphicsContext>()

/**
 * An icon's 24-unit SVG markup (from icons.ts) as a shared context, built once per arguments: "outline" strokes white
 * (2 units, or `strokeWidth`) with no fill, "solid" fills white with a 1.4 ink edge, so a tint colours the fill and the
 * edge stays near black. Draw it with a SmoothGraphics scaled size / 24, and never destroy it with its Graphics: a
 * destroyed one is built again on its next use.
 *
 * The fill and the edge parse separately. Pixi cuts an even-odd path's inner rings out of the last thing drawn, which
 * after a fill and a stroke is only the stroke, so a ring filled and stroked at once came out solid; and it strokes
 * only a path's outer ring. So the fill keeps the holes, and the edges stroke each ring as a path of its own.
 */
export const iconContext = (markup: string, variant: "outline" | "solid", strokeWidth?: number): GraphicsContext => {
  const key = `${variant} ${strokeWidth ?? ""} ${markup}`
  const known = contexts.get(key)
  if (known !== undefined && !known.destroyed) return known
  const svg = (paint: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g ${paint}>${body}</g></svg>`
  const rings = markup.replace(/<path fill-rule="evenodd" d="([^"]*)"\/>/g, (_, d: string) => d.split(/(?=M)/).map((ring) => `<path d="${ring}"/>`).join(""))
  const context = new GraphicsContext()
  if (variant === "solid") context.svg(svg(`fill="#fff"`, markup))
  context.svg(variant === "outline"
    ? svg(`fill="none" stroke="#fff" stroke-width="${strokeWidth ?? 2}"`, rings)
    : svg(`fill="none" stroke="${hex(PALETTE.ink)}" stroke-width="${strokeWidth ?? 1.4}"`, rings))
  contexts.set(key, context)
  return context
}
