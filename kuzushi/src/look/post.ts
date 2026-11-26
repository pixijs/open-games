import { PostEffect } from "@pixi/3d"
import type { PostEffectOptions } from "@pixi/3d"
import { BloomEffect } from "@pixi/3d/extras"
import { UniformGroup } from "pixi.js"

import type { FrameFx } from "../art/frame.ts"
import { PALETTE, paletteOf, rgbOf } from "../art/palette.ts"
import { settings } from "../art/settings.ts"
import type { FrameTime, HostContext } from "../host/types.ts"
import { ZONES } from "../sim/index.ts"
import type { ZoneId } from "../sim/index.ts"
import { GRADE } from "./grade.ts"
import { hueOf, RED_HUE, repaintOf, tonesOf } from "./tones.ts"
import { DRAWINGS } from "./twos.ts"

/**
 * The finishing pass, on the picture as it shows: the zone's grade (./grade.ts: the Courtyard's red repainted as the
 * zone's accent, every other colour locked to the zone's tone ramp, a fringe toward the edges, the vignette, paper
 * fibre and film grain that changes on twos) and the whole-frame looks that vfx drives through `HostContext.frame`
 * (src/art/frame.ts). The title and the Courtyard keep the plain ink-to-paper ramp and red. Through a boss room's open
 * gate the next zone's accent shows in its glare.
 */

/** The resting grade: how stark, how grainy, how dark the corners, how wide the fringe, how strong the paper. */
const GRADE_SETTINGS = { contrast: 0.55, grain: 0.07, vignette: 0.6, fringe: 0.45, paper: 0.07 } as const

const lanes4 = () => ({ value: new Float32Array(4), type: "vec4<f32>" as const })

const TONES = ["uTone0", "uTone1", "uTone2", "uTone3", "uTone4", "uTone5"] as const
type LaneName = "uGrade" | "uFx1" | "uFx2" | "uFx3" | "uFx4" | "uCenter" | "uAccent" | "uRepaint0" | "uRepaint1" | "uRepaint2" | (typeof TONES)[number]

class InkGradeEffect extends PostEffect {
  protected override readonly uniforms = new UniformGroup({
    uGrade: { value: new Float32Array([GRADE_SETTINGS.contrast, GRADE_SETTINGS.grain, GRADE_SETTINGS.vignette, GRADE_SETTINGS.fringe]), type: "vec4<f32>" },
    uFx1: lanes4(),
    uFx2: lanes4(),
    uFx3: lanes4(),
    uFx4: lanes4(),
    uCenter: { value: new Float32Array([0.5, 0.5, 0, GRADE_SETTINGS.paper]), type: "vec4<f32>" },
    uAccent: lanes4(),
    uRepaint0: lanes4(),
    uRepaint1: lanes4(),
    uRepaint2: lanes4(),
    uTone0: lanes4(),
    uTone1: lanes4(),
    uTone2: lanes4(),
    uTone3: lanes4(),
    uTone4: lanes4(),
    uTone5: lanes4()
  })

  protected readonly fragment = GRADE

  private zone: ZoneId | null = null

  constructor(options: PostEffectOptions = {}) {
    super({ stage: "afterToneMapping", ...options })
    this.setZone("courtyard")
  }

  private lanes(name: LaneName): Float32Array {
    const value = this.uniforms.uniforms[name]
    if (!(value instanceof Float32Array)) throw new Error(`InkGradeEffect: ${name} is not a Float32Array`)
    return value
  }

  /** Grades the picture as `zone`: its tone ramp, its accent kept in colour and the Courtyard's red repainted as it. */
  setZone(zone: ZoneId): void {
    if (zone === this.zone) return
    this.zone = zone
    tonesOf(zone).forEach((tone, index) => {
      const name = TONES[index]
      if (name !== undefined) this.lanes(name).set([...tone, 1])
    })
    const accent = paletteOf(zone).danger
    const own = zone !== "courtyard"
    this.lanes("uAccent").set([...rgbOf(accent), hueOf(accent)])
    const repaint = repaintOf(own ? accent : PALETTE.red)
    this.lanes("uRepaint0").set([...repaint.u, own ? 1 : 0])
    this.lanes("uRepaint1").set([...repaint.v, repaint.stretch])
    this.lanes("uRepaint2").set([repaint.cos, repaint.sin, repaint.lift, repaint.reach])
    this.lanes("uFx3")[2] = own ? 1 : 0
    this.lanes("uFx4")[3] = RED_HUE
    this.uniforms.update()
  }

  /** Also keeps `color`'s hue in colour, for the next zone's light through an open gate; null keeps none. */
  setBeyond(color: number | null): void {
    const lanes = this.lanes("uFx4")
    const hue = color === null ? 0 : hueOf(color)
    const on = color === null ? 0 : 1
    if (lanes[1] === hue && lanes[2] === on) return
    lanes[1] = hue
    lanes[2] = on
    this.uniforms.update()
  }

  apply(values: Readonly<FrameFx>): void {
    this.lanes("uFx1").set([values.invert, values.posterize, values.impact, values.redFlash])
    this.lanes("uFx2").set([values.whiteFlash, values.desaturate, values.radialBlur, values.vignette])
    const fx3 = this.lanes("uFx3")
    fx3[0] = values.redImpact
    fx3[1] = values.crush
    this.lanes("uFx4")[0] = values.lines
    const center = this.lanes("uCenter")
    center[0] = values.centerX
    center[1] = values.centerY
    this.uniforms.update()
  }

  /** Turns the moving film grain on or off (the player's setting); the paper fibre stays. */
  setGrain(on: boolean): void {
    this.lanes("uGrade")[1] = on ? GRADE_SETTINGS.grain : 0
    this.uniforms.update()
  }

  /** Grain is redrawn about twelve times a second, on twos like the effects. */
  setGrainFrame(frame: number): void {
    this.lanes("uCenter")[2] = frame % 61
    this.uniforms.update()
  }
}

/** Bloom on what is brighter than white (accent and white emissive glows only), then the grade. */
export const installPost = (context: HostContext) => {
  const bloom = new BloomEffect({ threshold: 1, intensity: 1.15, radius: 0.75 })
  const grade = new InkGradeEffect()
  context.post.set("look", [bloom, grade])
  const unbind = context.frame.bind((values) => grade.apply(values))
  const offSettings = settings.subscribe((values) => grade.setGrain(values.grain))
  let grainFrame = -1
  return {
    update: (frame: FrameTime) => {
      const view = context.game.view()
      grade.setZone(view.flow === "Title" ? "courtyard" : view.zone)
      const beyond = ZONES[view.zone].next
      const gateOpen = view.flow !== "Title" && view.room?.doors.some((door) => door.mark === "gate") === true
      grade.setBeyond(gateOpen && beyond !== null ? paletteOf(beyond).danger : null)
      const next = Math.floor(frame.elapsed * DRAWINGS)
      if (next !== grainFrame) {
        grainFrame = next
        grade.setGrainFrame(next)
      }
    },
    dispose: () => {
      unbind()
      offSettings()
      context.post.set("look", [])
      bloom.destroy()
      grade.destroy()
    }
  }
}
