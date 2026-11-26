import type { Renderer, Texture } from "pixi.js"

import { svgTexture } from "../../art/svg.ts"
import { templateIds, templateOf } from "../../sim/index.ts"
import type { TemplateId, ZoneId } from "../../sim/index.ts"
import { crackGlowSvg, CRACK_PIXELS } from "../void-floor.ts"
import { DIAL_PIXELS, dialFloorSvg } from "./dial-floor.ts"
import { ISLAND_PIXELS, islandArea, islandCracks, islandFloorSvg } from "./islands-floor.ts"
import { YARD_PIXELS, yardFloorSvg } from "./yard-floor.ts"

/**
 * The rooms' drawn textures: each template's floor and, in The Void, the glowing cracks of every slab that will fall.
 * Drawing one takes a few frames' worth of work, so a zone's set is drawn in idle time and handed to the GPU one
 * texture a frame when the zone starts (`prepare`), well before any door leads to its rooms; the other zones' are
 * released. The Courtyard's are prepared while loading, which waits for them.
 */
export interface RoomArt {
  /** The template's floor, or null while it is still being drawn. */
  floor(id: TemplateId): Texture | null
  /** Each slab's crack glow by its index in the template, null on a slab that never falls or while drawing. */
  cracks(id: TemplateId): ReadonlyArray<Texture | null>
  /** Resolves once the template's drawings are on the GPU. */
  ready(id: TemplateId): Promise<void>
  /**
   * Draws every template of `zone`, `first` (the room on screen) before the rest, and releases every other zone's.
   * Resolves once the zone's drawings are on the GPU.
   */
  prepare(zone: ZoneId, first?: string): Promise<void>
  destroy(): void
}

interface Entry {
  floor: Texture | null
  cracks: Array<Texture | null>
  readonly done: Promise<void>
}

const floorOf = async (id: TemplateId): Promise<Texture> => {
  const template = templateOf(id)
  switch (template.floor.kind) {
    case "rect": return svgTexture(yardFloorSvg(id, template), { width: template.halfWidth * 2 * YARD_PIXELS, mipmaps: true, label: `floor-${id}` })
    case "round": return svgTexture(dialFloorSvg(id, template), { width: template.halfWidth * 2 * DIAL_PIXELS, mipmaps: true, label: `floor-${id}` })
    case "slabs": return svgTexture(islandFloorSvg(id, template), { width: islandArea(template).width * ISLAND_PIXELS, mipmaps: true, label: `floor-${id}` })
  }
}

/** Waits for the next drawn frame, so uploads spread one a frame. */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/** Waits for the page to be idle (or half a second at most), so drawing a floor never lands in a busy frame. */
const idle = () => new Promise<void>((resolve) => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 500 })
  else setTimeout(resolve, 30)
})

/** `loading`: while true nothing else needs the frames, so drawing doesn't wait for idle time. */
export const makeRoomArt = (renderer: Renderer, loading: () => boolean): RoomArt => {
  const entries = new Map<TemplateId, Entry>()
  let queue: Promise<void> = Promise.resolve()
  let alive = true

  const upload = async (texture: Texture) => {
    await nextFrame()
    if (alive) renderer.texture.initSource(texture.source)
  }

  const start = (id: TemplateId): Entry => {
    const known = entries.get(id)
    if (known !== undefined) return known
    const template = templateOf(id)
    const slabs = template.floor.kind === "slabs" ? template.floor.slabs : []
    const entry: Entry = {
      floor: null,
      cracks: slabs.map(() => null),
      done: (queue = queue.then(async () => {
        if (!alive || entries.get(id) !== entry) return
        if (!loading()) await idle()
        const floor = await floorOf(id)
        await upload(floor)
        entry.floor = floor
        const lines = islandCracks(id, template)
        for (const [index, slab] of slabs.entries()) {
          const cracks = lines[index] ?? []
          if (cracks.length === 0) continue
          const glow = await svgTexture(crackGlowSvg(slab, cracks), { width: Math.round(slab.halfWidth * 2 * CRACK_PIXELS), label: `cracks-${id}-${index}` })
          entry.cracks[index] = glow
        }
      }).catch(() => undefined))
    }
    entries.set(id, entry)
    return entry
  }

  const release = (id: TemplateId) => {
    const entry = entries.get(id)
    if (entry === undefined) return
    entries.delete(id)
    void entry.done.then(() => {
      entry.floor?.destroy(true)
      for (const glow of entry.cracks) glow?.destroy(true)
    })
  }

  return {
    floor: (id) => start(id).floor,
    cracks: (id) => start(id).cracks,
    ready: (id) => start(id).done,
    prepare: async (zone, first) => {
      for (const id of templateIds) if (templateOf(id).zone !== zone) release(id)
      const ordered = [...templateIds.filter((id) => id === first), ...templateIds.filter((id) => id !== first)]
      await Promise.all(ordered.filter((id) => templateOf(id).zone === zone).map((id) => start(id).done))
    },
    destroy: () => {
      alive = false
      for (const id of entries.keys()) release(id)
    }
  }
}
