import { SystemRunner } from "pixi.js"
import type { Renderer } from "pixi.js"
import { describe, expect, it } from "vitest"

import { diffCounts, NO_COMPILES, watchCompiles } from "../src/gpu/compiles.ts"
import type { CompileEvent } from "../src/gpu/compiles.ts"

class FakeDevice {
  createRenderPipeline(descriptor: { label?: string }) {
    return { pipeline: descriptor.label }
  }
  createRenderPipelineAsync(descriptor: { label?: string }) {
    return Promise.resolve({ pipeline: descriptor.label })
  }
  createComputePipeline(descriptor: { label?: string }) {
    return { compute: descriptor.label }
  }
  createComputePipelineAsync(descriptor: { label?: string }) {
    return Promise.resolve({ compute: descriptor.label })
  }
  createShaderModule(descriptor: { code: string; label?: string }) {
    return { module: descriptor.code.length }
  }
}

class FakeGl {
  readonly sources = new Map<object, string>()
  readonly attached = new Map<object, Array<object>>()
  compileShader(_shader: object) {}
  linkProgram(_program: object) {}
  getShaderSource(shader: object) {
    return this.sources.get(shader) ?? null
  }
  getAttachedShaders(program: object) {
    return this.attached.get(program) ?? null
  }
}

/** A renderer with only what the watch reads: its device or context, and the runner pixi announces a new one on. */
const fakeRenderer = <B extends { gpu: { device: FakeDevice } } | { gl: FakeGl }>(backend: B) => {
  const renderer = { ...backend, runners: { contextChange: new SystemRunner("contextChange") } }
  return { renderer, watch: watchCompiles(renderer as unknown as Renderer) }
}

describe("watchCompiles on WebGPU", () => {
  it("counts each kind, async with sync, and passes the device's results through", async () => {
    const device = new FakeDevice()
    const { watch } = fakeRenderer({ gpu: { device } })
    expect(device.createRenderPipeline({ label: "PIXI Pipeline (ink)" })).toEqual({ pipeline: "PIXI Pipeline (ink)" })
    await device.createRenderPipelineAsync({ label: "PIXI Pipeline (sprite)" })
    device.createComputePipeline({ label: "cull" })
    await device.createComputePipelineAsync({})
    device.createShaderModule({ code: "@vertex fn main() {}" })
    expect(watch.counts).toEqual({ ...NO_COMPILES, pipeline: 2, computePipeline: 2, shaderModule: 1 })
    expect(watch.total).toBe(5)
  })

  it("labels a pipeline by its descriptor and an unlabelled module by its code", () => {
    const device = new FakeDevice()
    const { watch } = fakeRenderer({ gpu: { device } })
    const events: Array<CompileEvent> = []
    const off = watch.on((event) => events.push(event))
    device.createRenderPipeline({ label: "PIXI Pipeline (ink)" })
    device.createShaderModule({ code: "@fragment fn main() {}" })
    device.createShaderModule({ code: "@fragment fn main() {}" })
    off()
    device.createShaderModule({ code: "unheard" })
    expect(events.map((event) => event.kind)).toEqual(["pipeline", "shaderModule", "shaderModule"])
    expect(events[0]?.label).toBe("PIXI Pipeline (ink)")
    expect(events[1]?.label).toMatch(/^wgsl#[0-9a-f]{8}$/)
    expect(events[2]?.label).toBe(events[1]?.label)
    expect(watch.total).toBe(4)
  })

  it("wraps the next device after a device change, and counts the change", () => {
    const { renderer, watch } = fakeRenderer({ gpu: { device: new FakeDevice() } })
    const next = new FakeDevice()
    renderer.gpu = { device: next }
    renderer.runners.contextChange.emit(renderer.gpu)
    next.createRenderPipeline({})
    expect(watch.contextChanges).toBe(1)
    expect(watch.counts.pipeline).toBe(1)
  })

  it("puts the device's methods back on stop and counts nothing after", () => {
    const device = new FakeDevice()
    const { renderer, watch } = fakeRenderer({ gpu: { device } })
    watch.stop()
    device.createRenderPipeline({})
    renderer.runners.contextChange.emit(renderer.gpu)
    expect(Object.hasOwn(device, "createRenderPipeline")).toBe(false)
    expect(watch.total).toBe(0)
    expect(watch.contextChanges).toBe(0)
  })

  it("leaves a wrapper something added after it, which then counts nothing", () => {
    const device = new FakeDevice()
    const { watch } = fakeRenderer({ gpu: { device } })
    const inner = device.createRenderPipeline
    const outer = (descriptor: { label?: string }) => inner.call(device, descriptor)
    device.createRenderPipeline = outer
    watch.stop()
    device.createRenderPipeline({})
    expect(device.createRenderPipeline).toBe(outer)
    expect(watch.total).toBe(0)
  })
})

describe("watchCompiles on WebGL", () => {
  it("labels shaders by pixi's SHADER_NAME and programs by their shaders", () => {
    const gl = new FakeGl()
    const { watch } = fakeRenderer({ gl })
    const vertex = {}
    const fragment = {}
    const program = {}
    gl.sources.set(vertex, "#version 300 es\n#define SHADER_NAME ink-vertex\nvoid main() {}")
    gl.sources.set(fragment, "void main() {}")
    gl.attached.set(program, [vertex, fragment])
    const events: Array<CompileEvent> = []
    watch.on((event) => events.push(event))
    gl.compileShader(vertex)
    gl.compileShader(fragment)
    gl.linkProgram(program)
    expect(events.map((event) => `${event.kind} ${event.label}`)).toEqual([
      "glShader ink-vertex",
      expect.stringMatching(/^glShader glsl#[0-9a-f]{8}$/),
      expect.stringMatching(/^glProgram ink-vertex \+ glsl#[0-9a-f]{8}$/)
    ])
    expect(watch.counts).toEqual({ ...NO_COMPILES, glShader: 2, glProgram: 1 })
  })

  it("wraps a restored context once", () => {
    const gl = new FakeGl()
    const { renderer, watch } = fakeRenderer({ gl })
    renderer.runners.contextChange.emit(gl)
    gl.compileShader({})
    expect(watch.contextChanges).toBe(1)
    expect(watch.total).toBe(1)
  })
})

describe("diffCounts", () => {
  it("subtracts kind by kind", () => {
    const before = { ...NO_COMPILES, pipeline: 2, glShader: 1 }
    const after = { ...NO_COMPILES, pipeline: 5, shaderModule: 3, glShader: 1 }
    expect(diffCounts(after, before)).toEqual({ ...NO_COMPILES, pipeline: 3, shaderModule: 3 })
  })
})
