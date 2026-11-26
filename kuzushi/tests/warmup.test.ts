import { TextureSource, Ticker, UPDATE_PRIORITY } from "pixi.js"
import { describe, expect, it } from "vitest"

import { NO_COMPILES } from "../src/gpu/compiles.ts"
import type { CompileWatch } from "../src/gpu/compiles.ts"
import { afterRender, warmUp } from "../src/gpu/warmup.ts"
import type { WarmupOptions, WarmupProgress, WarmupStep } from "../src/gpu/warmup.ts"

const MIB = 2 ** 20

/**
 * An app whose frames compile what the current pose queued: `compile(2, 1)` makes the next frame compile two programs
 * and the one after it one. `onFrame` runs after each frame is counted.
 */
const fakeApp = () => {
  const app = { total: 0, contextChanges: 0, frames: 0, queued: new Array<number>(), log: new Array<string>(), onFrame: (_frame: number) => {} }
  const watch: CompileWatch = {
    get counts() {
      return { ...NO_COMPILES, pipeline: app.total }
    },
    get total() {
      return app.total
    },
    get contextChanges() {
      return app.contextChanges
    },
    on: () => () => {},
    stop: () => {}
  }
  const options: WarmupOptions = {
    renderer: { texture: { initSource: (source) => app.log.push(`upload ${source.label}`) } },
    watch,
    nextFrame: async () => {
      app.frames += 1
      app.total += app.queued.shift() ?? 0
      app.log.push("frame")
      app.onFrame(app.frames)
    }
  }
  const compile = (...perFrame: Array<number>) => {
    app.queued = perFrame
  }
  return { app, options, compile }
}

const texture = (label: string, side: number, autoGenerateMipmaps = false) => new TextureSource({ label, width: side, height: side, autoGenerateMipmaps })

describe("warmUp", () => {
  it("ends a pose on the first frame that compiles nothing", async () => {
    const { app, options, compile } = fakeApp()
    const step: WarmupStep = {
      label: "look",
      *poses() {
        compile(2, 1)
        yield "actors"
        yield
      }
    }
    const report = await warmUp([step], options)
    expect(app.frames).toBe(4)
    expect(report.frames).toBe(4)
    expect(report.compiles.pipeline).toBe(3)
    expect(report.unsettled).toEqual([])
    expect(report.steps).toEqual([expect.objectContaining({ label: "look", poses: 2, frames: 4, compiles: 3 })])
  })

  it("waits for settleFrames quiet frames in a row", async () => {
    const { options, compile } = fakeApp()
    const step: WarmupStep = {
      label: "look",
      *poses() {
        compile(1, 0, 1)
        yield
      }
    }
    expect((await warmUp([step], { ...options, settleFrames: 2 })).frames).toBe(5)
  })

  it("lists a pose still compiling after maxFramesPerPose as unsettled, and moves on", async () => {
    const { app, options, compile } = fakeApp()
    const labels: Array<string> = []
    const step: WarmupStep = {
      label: "ui",
      *poses() {
        compile(...Array.from({ length: 50 }, () => 1))
        yield "screens"
        compile()
        yield "title"
      }
    }
    const report = await warmUp([step], { ...options, maxFramesPerPose: 5, onProgress: (progress) => labels.push(progress.label) })
    expect(report.unsettled).toEqual(["ui/screens"])
    expect(app.frames).toBe(6)
    expect(labels).toContain("ui/title")
  })

  it("closes the poses with return() when a frame fails", async () => {
    const { app, options, compile } = fakeApp()
    const undone: Array<string> = []
    const step: WarmupStep = {
      label: "vfx",
      *poses() {
        try {
          compile(1, 1)
          yield "effects"
        } finally {
          undone.push("effects")
        }
      }
    }
    app.onFrame = (frame) => {
      if (frame === 2) throw new Error("device lost")
    }
    await expect(warmUp([step], options)).rejects.toThrow("device lost")
    expect(undone).toEqual(["effects"])
  })

  it("calls return() only on an iterator it leaves open", async () => {
    const closed: Array<string> = []
    const iterator = (name: string, poses: number, failAt = Infinity): Iterator<string, void, undefined> => {
      let made = 0
      return {
        next: () => {
          if (made === failAt) throw new Error(`${name} failed`)
          made += 1
          return made > poses ? { done: true, value: undefined } : { done: false, value: `${made}` }
        },
        return: () => {
          closed.push(name)
          return { done: true, value: undefined }
        }
      }
    }
    const { app, options } = fakeApp()
    await warmUp([{ label: "a", poses: () => iterator("finished", 2) }], options)
    await expect(warmUp([{ label: "b", poses: () => iterator("threw", 2, 1) }], options)).rejects.toThrow("threw failed")
    app.onFrame = () => {
      throw new Error("frame failed")
    }
    await expect(warmUp([{ label: "c", poses: () => iterator("interrupted", 2) }], options)).rejects.toThrow("frame failed")
    expect(closed).toEqual(["interrupted"])
  })

  it("uploads within the byte budget, then waits a frame, and uploads a shared source once", async () => {
    const { app, options } = fakeApp()
    const shared = texture("c", 1024)
    const steps: Array<WarmupStep> = [
      { label: "look", uploads: () => [texture("a", 1024), texture("b", 1024), shared] },
      { label: "vfx", uploads: () => [shared, texture("d", 1024)] }
    ]
    const report = await warmUp(steps, { ...options, uploadBytesPerFrame: 8 * MIB })
    expect(app.log).toEqual(["upload a", "upload b", "frame", "upload c", "upload d"])
    expect(report.bytes).toBe(16 * MIB)
    expect(report.steps.map((step) => step.bytes)).toEqual([12 * MIB, 4 * MIB])
  })

  it("counts a third more for a mipmapped texture", async () => {
    const { options } = fakeApp()
    const report = await warmUp([{ label: "art", uploads: () => [texture("mips", 1024, true)] }], options)
    expect(report.bytes).toBeCloseTo((4 * MIB * 4) / 3)
  })

  it("starts over from the first step when the context changes, closing the open pose", async () => {
    const { app, options, compile } = fakeApp()
    const entered: Array<string> = []
    const undone: Array<string> = []
    const poses = (label: string) => function* () {
      entered.push(label)
      try {
        compile(1)
        yield
      } finally {
        undone.push(label)
      }
    }
    app.onFrame = (frame) => {
      if (frame === 3) app.contextChanges += 1
    }
    const report = await warmUp([{ label: "a", poses: poses("a") }, { label: "b", poses: poses("b") }], { ...options, onRestart: () => entered.push("restart") })
    expect(entered).toEqual(["a", "b", "restart", "a", "b"])
    expect(undone).toEqual(["a", "b", "a", "b"])
    expect(report.restarts).toBe(1)
    expect(report.steps.map((step) => step.label)).toEqual(["a", "b"])
    expect(report.frames).toBe(7)
  })

  it("stops starting over after three restarts", async () => {
    const { app, options } = fakeApp()
    app.onFrame = () => {
      app.contextChanges += 1
    }
    const step: WarmupStep = {
      label: "a",
      *poses() {
        yield
      }
    }
    const report = await warmUp([step], options)
    expect(report.restarts).toBe(3)
    expect(report.frames).toBe(4)
  })

  it("reports progress that never decreases, creeps within a step and ends at 1", async () => {
    const { app, options, compile } = fakeApp()
    const progress: Array<WarmupProgress> = []
    const step = (label: string): WarmupStep => ({
      label,
      uploads: () => [texture(label, 2048)],
      *poses() {
        compile(1, 1, 1)
        yield
        yield
      }
    })
    app.onFrame = (frame) => {
      if (frame === 9) app.contextChanges += 1
    }
    const report = await warmUp([step("a"), step("b"), step("c")], { ...options, uploadBytesPerFrame: 4 * MIB, onProgress: (each) => progress.push(each) })
    const done = progress.map((each) => each.done)
    expect(report.restarts).toBe(1)
    expect(done.every((value, i) => i === 0 || value >= (done[i - 1] ?? 0))).toBe(true)
    expect(done.at(-1)).toBe(1)
    expect(done.some((value) => value > 0 && value < 1 / 3)).toBe(true)
  })
})

describe("afterRender", () => {
  it("resolves after the ticker's render", async () => {
    const ticker = new Ticker()
    const order: Array<string> = []
    ticker.add(() => order.push("render"), undefined, UPDATE_PRIORITY.LOW)
    const frame = afterRender(ticker)().then(() => order.push("resolved"))
    ticker.add(() => order.push("update"), undefined, UPDATE_PRIORITY.NORMAL)
    ticker.update(16)
    await frame
    expect(order).toEqual(["update", "render", "resolved"])
    ticker.destroy()
  })
})
