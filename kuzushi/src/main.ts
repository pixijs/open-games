import { Container3D, View3D } from "@pixi/3d"
import { Application, Container } from "pixi.js"

import { PALETTE } from "./art/palette.ts"
import { makeTitleCues } from "./art/title-cues.ts"
import { installAudio } from "./audio/index.ts"
import { CameraRig, installCamera } from "./camera/index.ts"
import { watchCompiles } from "./gpu/compiles.ts"
import { installDebugApi } from "./host/debug.ts"
import { makeHost } from "./host/host.ts"
import { attachLoader } from "./host/loading.ts"
import { installLab } from "./lab/index.ts"
import { installLook } from "./look/index.ts"
import { installTitle } from "./title/index.ts"
import { installUi } from "./ui/index.ts"
import { installVfx } from "./vfx/index.ts"

/** The most canvas pixels drawn per CSS pixel: the UI's text and lines stay sharp on a DPR 2 screen, and denser screens cost no more. */
const RESOLUTION_CAP = 2
const density = () => Math.min(window.devicePixelRatio || 1, RESOLUTION_CAP)

const params = new URLSearchParams(location.search)
/** WebGPU where the browser has it, else WebGL; `?renderer=webgl` forces WebGL. */
const preference = params.get("renderer") === "webgl" ? "webgl" : "webgpu"
/** A compile after loading is a hitch in play: `?compiles` warns of each one, `?compiles=strict` makes each an error so a step list fails on it. */
const lateCompiles = params.get("compiles") === "strict" ? "error" : params.has("compiles") ? "warn" : undefined

/** The loader's bar: its first half is the boot (the renderer, then each install, a step each), its second the warm-up. */
const BOOT_SHARE = 0.5

const loader = attachLoader()
try {
  const app = new Application()
  const resolution = density()
  // The UI's plates blur what is drawn under them, which WebGL can read back only from a back buffer.
  await app.init({ preference, resizeTo: window, background: PALETTE.ink, resolution, autoDensity: true, antialias: resolution === 1, useBackBuffer: true })
  // Before anything draws, so loading can prove it compiled everything play draws.
  const watch = watchCompiles(app.renderer)
  // @pixi/3d's createDefaultGraph3D multisamples the view's own scene targets when this is set; the canvas context stays without MSAA above DPR 1.
  app.renderer.view.antialias = true
  const stage = document.getElementById("stage")
  const overlay = document.getElementById("overlay")
  if (stage === null || overlay === null) throw new Error("index.html needs #stage and #overlay")
  stage.appendChild(app.canvas)

  const view = new View3D({ autoResize: true, shadowQuality: "ultra", background: PALETTE.ink, resolution: 1 })
  app.stage.addChild(view)
  /** Follows the window to a screen of another density: the canvas and the UI's text re-rasterise there. */
  const followDensity = () => matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", () => {
    app.renderer.resize(app.screen.width, app.screen.height, density())
    followDensity()
  }, { once: true })
  followDensity()
  const layers = {
    world: new Container3D({ label: "world" }),
    actors: new Container3D({ label: "actors" }),
    effects: new Container3D({ label: "effects" }),
    screen: new Container({ label: "screen" }),
    ui: new Container({ label: "ui" })
  }
  view.root.addChild(layers.world, layers.actors, layers.effects)
  app.stage.addChild(layers.screen, layers.ui)

  const rig = new CameraRig(view)
  const titleCues = makeTitleCues()
  const host = makeHost({ app, view, layers, overlay, rig })

  // Audio decodes its files while the installs before it warm up on the GPU, so its own warm step rarely waits.
  const installs = [installLook, installVfx, installCamera, installUi(titleCues), installTitle(titleCues), installAudio, installLab(installDebugApi(host))]
  const bootSteps = installs.length + 1
  loader.progress(BOOT_SHARE / bootSteps)
  for (const [index, install] of installs.entries()) {
    await host.install(install)
    loader.progress((BOOT_SHARE * (index + 2)) / bootSteps)
  }
  host.start()
  await host.load({ watch, lateCompiles, onProgress: (done) => loader.progress(BOOT_SHARE + (1 - BOOT_SHARE) * done) })
  performance.mark("kuzushi:loaded")
  await loader.finish()
} catch (error) {
  loader.fail(error)
  throw error
}
