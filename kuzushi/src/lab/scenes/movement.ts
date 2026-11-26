import { Tuning } from "../../sim/index.ts"
import type { PlayerMoves } from "../../sim/index.ts"
import { el } from "../../ui/dom.ts"
import { toSeconds, toSteps } from "../frames.ts"
import type { Scene } from "../scene.ts"
import { INK } from "../sketch.ts"
import type { Tone } from "../timeline.ts"

const modes = [
  { value: "run", label: "Run" },
  { value: "dash", label: "Dash" },
  { value: "both", label: "Run + dash" },
  { value: "manual", label: "Manual" }
] as const

/** A ghost every 0.1 s of gameplay. */
const GHOST_STEPS = 6
const GHOSTS = 80
/** Gameplay steps the player rests at each end of the track. */
const REST_STEPS = 36

const TUNED = {
  speed: Tuning.PLAYER.speed,
  acceleration: Tuning.PLAYER.acceleration,
  deceleration: Tuning.PLAYER.deceleration,
  dashDistance: Tuning.DASH.speed * toSeconds(Tuning.DASH.time.steps),
  dashTime: toSeconds(Tuning.DASH.time.steps)
} as const satisfies PlayerMoves

const MOVE_KEYS = ["speed", "acceleration", "deceleration", "dashDistance", "dashTime"] as const satisfies ReadonlyArray<keyof PlayerMoves>

/** What the scene measured: the run's top speed and the time to reach it, the last stop's slide and the last dash. */
interface Measures {
  top: number
  toTop: number | null
  stop: number | null
  dash: number | null
  dashSteps: number | null
}

const LANES = [{ id: "move", label: "Move" }, { id: "speed", label: "Speed" }] as const

/** The tuned numbers written the way src/sim/tuning.ts writes them, ready to paste. */
const asTuning = (moves: PlayerMoves): string => [
  "// src/sim/tuning.ts",
  "PLAYER",
  `  speed: ${+moves.speed.toFixed(2)},`,
  `  acceleration: ${+moves.acceleration.toFixed(1)},`,
  `  deceleration: ${+moves.deceleration.toFixed(1)},`,
  "DASH",
  `  speed: ${+(moves.dashDistance / moves.dashTime).toFixed(2)},`,
  `  time: Clock.duration(step, ${+moves.dashTime.toFixed(3)}),`
].join("\n")

/**
 * Open floor with distance markers: the player runs between them and dashes, on a loop or under the keys, with live
 * sliders for the movement numbers (the simulation's override), readouts of what they measure to, ghosts every 0.1 s
 * to show the spacing, and a copy of the numbers in tuning.ts form. On the grid the track starts on its centre line,
 * so the markers and the grid's own numbers agree.
 */
export const movementScene: Scene = {
  id: "movement",
  title: "Movement",
  summary: "Runs and dashes between markers; tune them live.",
  defaults: { invulnerable: true, camera: "top" },
  usesAi: false,
  create: (tools) => {
    const { game, anchor, timeline } = tools
    const mode = tools.option<string>("mode", "run")
    const length = tools.floor === "grid" ? 15 : 8
    const from = { x: tools.floor === "grid" ? anchor.x : anchor.x - length / 2, z: anchor.z }
    const to = { x: from.x + length, z: anchor.z }
    const middle = from.x + length / 2
    const ghosts: Array<{ readonly x: number; readonly z: number; readonly facing: number }> = []
    const measure: Measures = { top: 0, toTop: null, stop: null, dash: null, dashSteps: null }
    const run = { phase: "rest" as "rest" | "run" | "stop" | "dash", since: 0, startStep: 0, startX: 0, releaseX: 0, dashed: false, lastStep: -1, x: from.x, z: from.z, dashing: false }
    let copied = ""

    game.teleport(from.x, from.z, 0)
    tools.frame({ x: middle, z: anchor.z, radius: length / 2 + 2.5 })
    timeline.setup("Movement · gameplay steps at 60 a second", LANES, 150)

    const labels = [0, 5, 10, 15].filter((distance) => distance <= length).map((distance) => {
      const label = el("div", "k-lab-mark", `${distance}`)
      tools.layer.append(label)
      return { distance, label }
    })

    const moves = () => tools.context.game.view().debug.moves
    const back = () => {
      game.steer(0, 0)
      game.teleport(from.x, from.z, 0)
      ghosts.length = 0
      run.lastStep = -1
      run.phase = "rest"
      run.since = tools.context.game.view().tempo.playStep
      timeline.begin(run.since)
    }

    tools.on("dashStarted", (moment) => {
      run.startX = moment.x
      run.startStep = tools.context.game.view().tempo.playStep
    })
    tools.on("dashEnded", (moment) => {
      measure.dash = Math.abs(moment.x - run.startX)
      measure.dashSteps = tools.context.game.view().tempo.playStep - run.startStep
    })

    const copy = () => {
      const text = asTuning(moves())
      console.info(text)
      void navigator.clipboard?.writeText(text).then(() => {
        copied = "Copied"
      }, () => {
        copied = "Printed to the console"
      })
    }

    const range = (label: string, key: keyof PlayerMoves, min: number, max: number, stepBy: number, format: (value: number) => string) => ({
      kind: "range" as const,
      label,
      min,
      max,
      step: stepBy,
      get: () => moves()[key],
      set: (value: number) => game.tune({ [key]: value }),
      format
    })

    return {
      controls: [
        { kind: "choice", label: "Mode", options: modes, get: mode.get, set: (value) => {
          mode.set(value)
          back()
        } },
        { kind: "action", label: "Reset numbers", run: () => game.tune(null) },
        { kind: "action", label: "Copy values", run: copy },
        range("Run speed", "speed", 2, 16, 0.1, (value) => `${value.toFixed(1)} u/s`),
        range("Acceleration", "acceleration", 5, 300, 1, (value) => `${Math.round(value)} u/s²`),
        range("Deceleration", "deceleration", 5, 300, 1, (value) => `${Math.round(value)} u/s²`),
        range("Dash distance", "dashDistance", 0.5, 10, 0.1, (value) => `${value.toFixed(1)} u`),
        range("Dash time", "dashTime", 0.05, 0.5, toSeconds(1), (value) => `${value.toFixed(2)} s · ${toSteps(value)} f`)
      ],
      update: (view) => {
        const player = view.player
        if (player === null) return
        const step = view.tempo.playStep
        if (step !== run.lastStep) {
          const dt = run.lastStep < 0 ? 0 : toSeconds(step - run.lastStep)
          const speed = dt > 0 ? Math.hypot(player.x - run.x, player.z - run.z) / dt : 0
          run.x = player.x
          run.z = player.z
          run.lastStep = step
          if (step % GHOST_STEPS === 0) {
            ghosts.push({ x: player.x, z: player.z, facing: player.facing })
            if (ghosts.length > GHOSTS) ghosts.shift()
          }
          // The step a dash ends on still carries the dash's distance, so top speed skips it too.
          if (player.state !== "Dash" && !run.dashing) measure.top = Math.max(measure.top, speed)
          run.dashing = player.state === "Dash"
          if (run.phase === "run" && measure.toTop === null && speed >= view.debug.moves.speed * 0.99) measure.toTop = toSeconds(step - run.startStep)
          if (run.phase === "stop" && speed < 0.01) {
            measure.stop = Math.abs(player.x - run.releaseX)
            run.phase = "rest"
            run.since = step
          }
          const tone: Tone | null = player.state === "Dash" ? "dash" : speed > 0.01 ? "move" : null
          timeline.sample(step, "move", tone, player.state === "Dash" ? "Dash" : "Run")
          timeline.sample(step, "speed", speed > 0.01 ? (speed >= view.debug.moves.speed * 0.99 ? "active" : "windup") : null, speed >= view.debug.moves.speed * 0.99 ? "Top" : "")
          timeline.playhead(step)
        }
        const chosen = mode.get()
        if (chosen === "manual") return
        game.aim(player.x + 10, player.z)
        const stopping = (view.debug.moves.speed ** 2) / (2 * view.debug.moves.deceleration)
        switch (run.phase) {
          case "rest":
            if (step - run.since < REST_STEPS) return
            if (Math.abs(player.x - from.x) > 0.05 || Math.abs(player.z - from.z) > 0.05) {
              back()
              return
            }
            measure.top = 0
            measure.toTop = null
            run.dashed = false
            run.startStep = step
            timeline.begin(step)
            if (chosen === "dash") {
              run.phase = "dash"
              game.press("dash")
              return
            }
            run.phase = "run"
            game.steer(1, 0)
            return
          case "run":
            if (chosen === "both" && !run.dashed && player.x >= middle - 1) {
              run.dashed = true
              game.press("dash")
            }
            if (player.x < to.x - stopping) return
            run.releaseX = player.x
            run.phase = "stop"
            game.steer(0, 0)
            return
          case "dash":
            if (player.state === "Dash" || step - run.startStep < 4) return
            run.phase = "rest"
            run.since = step
            return
          case "stop":
            return
        }
      },
      readouts: (view) => {
        const now = view.debug.moves
        const changed = MOVE_KEYS.some((key) => Math.abs(now[key] - TUNED[key]) > 1e-6)
        return [
          { label: "Top speed", value: `${measure.top.toFixed(2)} u/s of ${now.speed.toFixed(2)}` },
          { label: "To top speed", value: measure.toTop === null ? "-" : `${measure.toTop.toFixed(2)} s · ${toSteps(measure.toTop)} f` },
          { label: "Stopping", value: measure.stop === null ? "-" : `${measure.stop.toFixed(2)} u` },
          { label: "Dash", value: measure.dash === null ? "-" : `${measure.dash.toFixed(2)} u in ${measure.dashSteps ?? 0} f` },
          { label: "Dash speed", value: measure.dash === null || !measure.dashSteps ? "-" : `${(measure.dash / toSeconds(measure.dashSteps)).toFixed(2)} u/s` },
          { label: "Numbers", value: copied !== "" ? copied : changed ? "Changed from tuning.ts" : "As in tuning.ts", hot: changed }
        ]
      },
      draw: (sketch) => {
        ghosts.forEach((ghost, index) => sketch.arrow(ghost.x, ghost.z, ghost.facing, 0.55, { ...INK.paper, width: 1, alpha: 0.18 + (0.55 * index) / ghosts.length }))
        for (const { distance, label } of labels) {
          const x = from.x + distance
          sketch.path([{ x, z: anchor.z - 1.4 }, { x, z: anchor.z + 1.4 }], { ...INK.red, width: 2 })
          const screen = tools.toScreen(x, anchor.z + 1.7)
          label.hidden = screen === null
          if (screen !== null) label.style.transform = `translate(${Math.round(screen.x)}px, ${Math.round(screen.y)}px) translateX(-50%)`
        }
      },
      dispose: () => {
        game.steer(0, 0)
      }
    }
  }
}
