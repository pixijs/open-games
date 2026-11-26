import { Container3D, FlatMaterial, Geometry3D, Mesh3D } from "@pixi/3d"
import type { Texture } from "pixi.js"

import { arcBit } from "./shaders.ts"

/**
 * Slash crescents: a drawn stroke bent along a flat strip that tapers to a point at both ends, revealed and
 * eroded by `arcBit`. Built pointing +x (the facing) with u running from the right side (+z) round to the left.
 */

export interface ArcShape {
  /** Radians the strip covers. */
  readonly span: number
  /** Thickness at its fullest, as a share of the radius. */
  readonly thickness: number
  /** Where along the strip it is fullest, 0 to 1. */
  readonly peak: number
  /** How much nearer the centre the tail starts than the head ends, as a share of the radius: a spiral. */
  readonly spiral: number
}

export const ARC_SHAPES = {
  wide: { span: (175 * Math.PI) / 180, thickness: 0.55, peak: 0.6, spiral: 0.12 },
  spin: { span: Math.PI * 2 + 0.9, thickness: 0.36, peak: 0.72, spiral: 0.22 },
  cut: { span: (120 * Math.PI) / 180, thickness: 0.2, peak: 0.6, spiral: 0.04 },
  /** An enemy arm's smear: a sweeper's 200°, the Orrery's hands' 180°. */
  sweep: { span: (200 * Math.PI) / 180, thickness: 0.26, peak: 0.8, spiral: 0.03 },
  hand: { span: Math.PI, thickness: 0.16, peak: 0.85, spiral: 0.02 }
} as const satisfies Record<string, ArcShape>

export type ArcShapeName = keyof typeof ARC_SHAPES

/** What an arc mesh draws with: its stroke drawings, the light under them, and the erosion noise. */
export interface StrokeKit {
  readonly strokes: ReadonlyArray<Texture>
  readonly strokeGlow: Texture
  readonly noise: Texture
}

const SEGMENTS = 64

/** The strip an arc shape bends its stroke along, u from the right side round to the left. */
export const buildStrip = (shape: ArcShape): Geometry3D => {
  const count = (SEGMENTS + 1) * 2
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const uvs = new Float32Array(count * 2)
  const indices = new Uint16Array(SEGMENTS * 6)
  for (let step = 0; step <= SEGMENTS; step++) {
    const u = step / SEGMENTS
    const angle = shape.span / 2 - shape.span * u
    const outer = 1 - shape.spiral * (1 - u)
    const shaped = u < shape.peak ? u / shape.peak : (1 - u) / (1 - shape.peak)
    const thick = shape.thickness * Math.sin((Math.max(0, shaped) * Math.PI) / 2) ** 0.85
    const inner = outer - thick
    for (let side = 0; side < 2; side++) {
      const vertex = step * 2 + side
      const radius = side === 0 ? outer : inner
      positions.set([Math.cos(angle) * radius, 0, Math.sin(angle) * radius], vertex * 3)
      normals.set([0, 1, 0], vertex * 3)
      uvs.set([u, side], vertex * 2)
    }
    if (step < SEGMENTS) {
      const a = step * 2
      indices.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], step * 6)
    }
  }
  return new Geometry3D({ positions, normals, uvs, indices })
}

const RED_EDGE = [1, 0.18, 0.247] as const

/** One crescent on screen: a glow strip added under a drawn strip, both revealed by the same sweep. */
export class Arc {
  /** Placed at the arc's centre, turned to its facing. */
  readonly node = new Container3D({ label: "arc" })
  /** Banks the arc about its facing, so it reads as a swing through space. */
  readonly tilt = new Container3D()
  private readonly flip = new Container3D()
  private readonly body: Mesh3D
  private readonly glow: Mesh3D
  private readonly bodyMaterial: FlatMaterial
  private readonly glowMaterial: FlatMaterial
  private readonly noiseOffset: number

  constructor(private readonly kit: StrokeKit, geometry: Geometry3D, seed: number) {
    this.noiseOffset = seed * 0.37
    this.bodyMaterial = new FlatMaterial({ baseColorTexture: kit.strokes[0], textures: { noise: kit.noise }, extraBits: [arcBit], alphaMode: "blend", doubleSided: true })
    this.glowMaterial = new FlatMaterial({ baseColorTexture: kit.strokeGlow, textures: { noise: kit.noise }, extraBits: [arcBit], alphaMode: "blend", doubleSided: true })
    this.glowMaterial.state.blendMode = "add"
    this.glow = new Mesh3D({ geometry, material: this.glowMaterial, castShadow: false, receiveShadow: false, scale: { x: 1.14, y: 1, z: 1.14 } })
    this.body = new Mesh3D({ geometry, material: this.bodyMaterial, castShadow: false, receiveShadow: false })
    this.flip.addChild(this.glow, this.body)
    this.tilt.addChild(this.flip)
    this.node.addChild(this.tilt)
    this.node.visible = false
  }

  /**
   * Places the arc: centre, facing (sim radians), outer radius, which way it sweeps, its bank, and `flatten`, how
   * much shallower than round it is along the facing (0 round), so it reads as a diagonal swipe once turned.
   */
  place(x: number, y: number, z: number, facing: number, radius: number, mirror: boolean, bank: number, flatten = 0): void {
    this.node.position.set(x, y, z)
    this.node.rotation.y = -facing
    this.node.scale.set(radius * (1 - flatten), 1, radius * (1 + flatten * 0.5))
    this.flip.scale.z = mirror ? -1 : 1
    this.tilt.rotation.x = bank
    this.node.visible = true
  }

  /**
   * One drawing: the visible window along the swing, how eroded it is, its brightness, which stroke drawing, and the
   * colour its eroded border burns (display-space sRGB channels 0 to 1, as `rgbOf` gives; the red rim by default).
   */
  pose(tail: number, head: number, erode: number, glow: number, variant: number, alpha = 1, edge: readonly [number, number, number] = RED_EDGE): void {
    const stroke = this.kit.strokes[variant % this.kit.strokes.length]
    if (stroke !== undefined) this.bodyMaterial.textures.baseColor = stroke
    this.bodyMaterial.data.sweep = [tail, head, erode, glow]
    this.bodyMaterial.data.edge = [...edge, this.noiseOffset + variant * 0.31]
    this.bodyMaterial.alpha = alpha
    this.glowMaterial.data.sweep = [tail, head, erode * 0.8, 1]
    this.glowMaterial.data.edge = [...edge, this.noiseOffset]
    this.glowMaterial.alpha = Math.min(1, alpha * 0.75 * glow)
  }

  hide(): void {
    this.node.visible = false
  }

  destroy(): void {
    this.node.destroy({ children: true })
    this.bodyMaterial.destroy()
    this.glowMaterial.destroy()
  }
}

/** Arcs by shape, reused: taking one shows it under `parent`, giving it back hides it. */
export class ArcPool {
  private readonly geometries: Record<ArcShapeName, Geometry3D>
  private readonly free: Record<ArcShapeName, Array<Arc>> = { wide: [], spin: [], cut: [], sweep: [], hand: [] }
  private readonly all: Array<Arc> = []
  private made = 0

  constructor(private readonly kit: StrokeKit, private readonly parent: Container3D) {
    this.geometries = {
      wide: buildStrip(ARC_SHAPES.wide),
      spin: buildStrip(ARC_SHAPES.spin),
      cut: buildStrip(ARC_SHAPES.cut),
      sweep: buildStrip(ARC_SHAPES.sweep),
      hand: buildStrip(ARC_SHAPES.hand)
    }
  }

  take(shape: ArcShapeName): Arc {
    const arc = this.free[shape].pop() ?? this.make(shape)
    this.parent.addChild(arc.node)
    return arc
  }

  give(shape: ArcShapeName, arc: Arc): void {
    arc.hide()
    this.free[shape].push(arc)
  }

  hideAll(): void {
    for (const arc of this.all) arc.hide()
  }

  destroy(): void {
    for (const arc of this.all) arc.destroy()
    for (const geometry of Object.values(this.geometries)) geometry.destroy()
  }

  private make(shape: ArcShapeName): Arc {
    const arc = new Arc(this.kit, this.geometries[shape], this.made++)
    this.all.push(arc)
    return arc
  }
}
