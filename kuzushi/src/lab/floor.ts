import { Container3D, Mesh3D, PlaneGeometry } from "@pixi/3d"
import { Texture } from "pixi.js"

import { css } from "../art/palette.ts"
import { inkMaterial } from "../look/shaders/ink.ts"
import type { SceneLayers } from "../host/types.ts"
import { OPEN_FLOOR } from "../sim/index.ts"

const WIDTH = OPEN_FLOOR.halfWidth * 2
const DEPTH = OPEN_FLOOR.halfDepth * 2
/** Texels per world unit. */
const PIXELS = 64
const FONT = '"Barlow Condensed", "Arial Narrow", sans-serif'
/** The ground past the grid's edge: units a tile of its fainter grid spans, and how far round the grid it reaches. */
const OUTSIDE = { tile: 5, size: 260 } as const

/**
 * The open floor drawn as a measuring grid in world units: hairlines every unit, firmer lines every five with their
 * distance from the centre written beside them, the two axes through the centre, and the wall line round the edge.
 */
const drawGrid = (): HTMLCanvasElement => {
  const canvas = document.createElement("canvas")
  canvas.width = WIDTH * PIXELS
  canvas.height = DEPTH * PIXELS
  const context = canvas.getContext("2d")
  if (context === null) throw new Error("lab floor: no 2D canvas context")
  const toX = (x: number) => (x + OPEN_FLOOR.halfWidth) * PIXELS
  const toY = (z: number) => (z + OPEN_FLOOR.halfDepth) * PIXELS
  context.fillStyle = css("concrete500")
  context.fillRect(0, 0, canvas.width, canvas.height)

  const line = (x0: number, y0: number, x1: number, y1: number, width: number, color: string) => {
    context.strokeStyle = color
    context.lineWidth = width
    context.beginPath()
    context.moveTo(x0, y0)
    context.lineTo(x1, y1)
    context.stroke()
  }
  for (let x = -OPEN_FLOOR.halfWidth; x <= OPEN_FLOOR.halfWidth; x++) {
    const major = x % 5 === 0
    line(toX(x), 0, toX(x), canvas.height, x === 0 ? 4 : major ? 2.5 : 1.25, x === 0 ? "rgba(242, 239, 232, 0.55)" : major ? css("concrete300") : css("concrete400"))
  }
  for (let z = -OPEN_FLOOR.halfDepth; z <= OPEN_FLOOR.halfDepth; z++) {
    const major = z % 5 === 0
    line(0, toY(z), canvas.width, toY(z), z === 0 ? 4 : major ? 2.5 : 1.25, z === 0 ? "rgba(242, 239, 232, 0.55)" : major ? css("concrete300") : css("concrete400"))
  }

  context.font = `600 ${PIXELS * 0.42}px ${FONT}`
  context.fillStyle = css("paper")
  context.globalAlpha = 0.7
  context.textBaseline = "top"
  for (let x = -15; x <= 15; x += 5) context.fillText(`${Math.abs(x)}`, toX(x) + PIXELS * 0.1, toY(0) + PIXELS * 0.1)
  for (let z = -10; z <= 10; z += 5) {
    if (z !== 0) context.fillText(`${Math.abs(z)}`, toX(0) + PIXELS * 0.1, toY(z) + PIXELS * 0.1)
  }
  context.globalAlpha = 1
  context.lineWidth = 6
  context.strokeStyle = css("paper")
  context.strokeRect(3, 3, canvas.width - 6, canvas.height - 6)
  return canvas
}

/** One tile of the ground past the grid: darker, with faint 1-unit lines, so the grid never ends in a hard black edge. */
const drawOutside = (): HTMLCanvasElement => {
  const canvas = document.createElement("canvas")
  canvas.width = OUTSIDE.tile * PIXELS
  canvas.height = OUTSIDE.tile * PIXELS
  const context = canvas.getContext("2d")
  if (context === null) throw new Error("lab floor: no 2D canvas context")
  context.fillStyle = css("concrete600")
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = css("concrete500")
  for (let line = 0; line < OUTSIDE.tile; line++) {
    const width = line === 0 ? 2.5 : 1.25
    context.fillRect(line * PIXELS, 0, width, canvas.height)
    context.fillRect(0, line * PIXELS, canvas.width, width)
  }
  return canvas
}

/**
 * The lab's own floor in the world layer: the measuring grid over the open floor's area, and past its edge fainter
 * ground that fades into the dark, lit by the game's sun in its ink material. While it shows, everything else in the
 * world layer (the stage the run is on) is hidden.
 */
export const createGridFloor = (layers: SceneLayers) => {
  const texture = Texture.from(drawGrid())
  texture.source.autoGenerateMipmaps = true
  texture.source.updateMipmaps()
  const geometry = new PlaneGeometry({ width: WIDTH, height: DEPTH })
  const material = inkMaterial({
    color: 0xffffff,
    grain: texture,
    grainAmount: 0,
    mottling: 0.08,
    brush: 0.25,
    shade: 0.05,
    surface: { texture, x: -OPEN_FLOOR.halfWidth, z: -OPEN_FLOOR.halfDepth, width: WIDTH, depth: DEPTH }
  })
  const tile = Texture.from(drawOutside())
  tile.source.addressMode = "repeat"
  tile.source.autoGenerateMipmaps = true
  tile.source.updateMipmaps()
  const outside = new PlaneGeometry({ width: OUTSIDE.size, height: OUTSIDE.size })
  const outsideMaterial = inkMaterial({
    color: 0xffffff,
    grain: tile,
    grainAmount: 0,
    mottling: 0.1,
    brush: 0.25,
    shade: 0.05,
    surface: { texture: tile, x: 0, z: 0, width: OUTSIDE.tile, depth: OUTSIDE.tile },
    fade: { halfWidth: OPEN_FLOOR.halfWidth, halfDepth: OPEN_FLOOR.halfDepth, corner: 0, start: 3, end: 30, depth: 0, high: 1, strength: 0.94 }
  })
  const node = new Container3D({ label: "lab floor" })
  node.addChild(
    new Mesh3D({ label: "lab outside", geometry: outside, material: outsideMaterial, position: { x: 0, y: -0.02, z: 0 }, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, castShadow: false, receiveShadow: true }),
    new Mesh3D({ label: "lab grid", geometry, material, rotation: { x: -Math.PI / 2, y: 0, z: 0 }, castShadow: false, receiveShadow: true })
  )
  layers.world.addChild(node)
  node.visible = false
  let showing = false
  /** What the grid hid, to show again after; nothing else's visibility is touched. */
  const hidden = new Set<Container3D>()

  /** Keeps the grid alone in the world layer: the stage's world (rebuilt by look whenever the stage changes) stays hidden under it. */
  const apply = () => {
    node.visible = showing
    if (showing) {
      for (const child of layers.world.children) {
        if (child === node || !child.visible) continue
        child.visible = false
        hidden.add(child)
      }
      return
    }
    for (const child of hidden) {
      if (!child.destroyed) child.visible = true
    }
    hidden.clear()
  }

  return {
    show: (on: boolean) => {
      showing = on
      apply()
    },
    update: apply,
    dispose: () => {
      showing = false
      apply()
      node.destroy({ children: true, geometry: true, material: true })
      texture.destroy(true)
      tile.destroy(true)
    }
  }
}
