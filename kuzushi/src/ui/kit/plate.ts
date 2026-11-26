import { BlurFilter, defaultFilterVert, Filter, GlProgram, GpuProgram, Graphics, Texture, TexturePool, UniformGroup } from "pixi.js"
import type { FilterSystem, RenderSurface } from "pixi.js"

import { PALETTE } from "../../art/palette.ts"

/** Pixi's blur passes spread about 1.29 px of a CSS blur's deviation per unit of strength. */
const SPREAD = 1.29

/**
 * The plate filled over the scene behind it blurred. Its input is the plate at `opacity` times whatever fade its
 * parents hold, so the share of the plate shown is its alpha over `opacity`: the blur fades with it, as an element's
 * opacity took its backdrop-filter with it.
 */
const fragment = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uBackdrop;
uniform float uOpacity;

void main(void) {
  vec4 front = texture(uTexture, vTextureCoord);
  float shown = min(1.0, front.a / uOpacity);
  finalColor = vec4(front.rgb + texture(uBackdrop, vTextureCoord).rgb * (shown - front.a), shown);
}
`

/** `fragment` for WebGPU, on Pixi's filter vertex stage. */
const source = /* wgsl */ `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};

struct PlateUniforms {
  uOpacity: f32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

@group(1) @binding(0) var uBackdrop: texture_2d<f32>;
@group(1) @binding(1) var<uniform> plate: PlateUniforms;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  return VSOutput(vec4(position, 0.0, 1.0), aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw));
}

@fragment
fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let front = textureSample(uTexture, uSampler, uv);
  let shown = min(1.0, front.a / plate.uOpacity);
  return vec4(front.rgb + textureSample(uBackdrop, uSampler, uv).rgb * (shown - front.a), shown);
}
`

/** Blurs what is already drawn under its target and lays the target over that. Needs the renderer's back buffer on WebGL. */
class BackdropBlur extends Filter {
  private readonly blur: BlurFilter

  constructor(opacity: number, blur: number) {
    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment, name: "backdrop-blur" }),
      gpuProgram: GpuProgram.from({ vertex: { source, entryPoint: "mainVertex" }, fragment: { source, entryPoint: "mainFragment" } }),
      resources: { uBackdrop: Texture.EMPTY.source, plate: new UniformGroup({ uOpacity: { value: opacity, type: "f32" } }) },
      blendRequired: true,
      padding: 0
    })
    this.blur = new BlurFilter({ strength: blur / SPREAD, quality: 4 })
  }

  override apply(filterManager: FilterSystem, input: Texture, output: RenderSurface, clearMode: boolean): void {
    const back = filterManager.activeBackTexture
    if (back === undefined) return
    const blurred = TexturePool.getSameSizeTexture(input)
    this.blur.apply(filterManager, back, blurred, true)
    this.resources.uBackdrop = blurred.source
    filterManager.applyFilter(this, input, output, clearMode)
    TexturePool.returnTexture(blurred)
  }

  override destroy(): void {
    this.blur.destroy()
    super.destroy()
  }
}

export interface Plate {
  readonly node: Graphics
  /** Draws it `width` by `height` from 0, 0. */
  draw(width: number, height: number): void
}

/**
 * An ink plate with a 1 px paper border inside its edge, over the scene blurred behind it. `fillAlpha` is the ink's,
 * .78 by default; `blur` is the backdrop's blur in px, as CSS `blur()` takes it.
 */
export const createPlate = (fillAlpha = 0.78, blur = 6): Plate => {
  const node = new Graphics({ label: "plate" })
  const backdrop = new BackdropBlur(fillAlpha, blur)
  node.filters = [backdrop]
  node.once("destroyed", () => backdrop.destroy())
  return {
    node,
    draw: (width, height) => {
      node.clear().rect(0, 0, width, height).fill({ color: PALETTE.ink, alpha: fillAlpha }).stroke({ width: 1, color: PALETTE.paper, alpha: 0.18, alignment: 1 })
    }
  }
}
