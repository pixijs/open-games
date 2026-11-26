import { opposite, sides, SIDE_DIRS, TRANSITION, zoneOf } from "../../sim/index.ts"
import type { DoorView, GameView, Side, TransitionBeat } from "../../sim/index.ts"
import { oneOf } from "../choose.ts"
import { crossroads, templateName } from "../dungeons.ts"
import { roomFraming } from "../camera.ts"
import type { Scene } from "../scene.ts"
import { INK } from "../sketch.ts"
import type { Tone } from "../timeline.ts"
import { drawDoorway, sealsToggle } from "./roster.ts"

const LANES = [{ id: "beat", label: "Beat" }, { id: "play", label: "Gameplay" }] as const

const BEAT_TONES: Readonly<Record<TransitionBeat, Tone>> = { exit: "dash", cover: "windup", hold: "rest", card: "guard", reveal: "recover" }

/** Run-clock steps a looping walk rests between transitions. */
const REST_STEPS = 40
/** How far inside a door the player is put to walk out through it. */
const RUN_UP = 1.2

const directions = sides.map((side) => ({ value: side, label: side.slice(0, 1).toUpperCase() + side.slice(1) }))

/** Each beat's length in steps, in order, for a door or the zone change. */
const beatsOf = (kind: "door" | "zone"): string => {
  const timing = kind === "door" ? TRANSITION.door : TRANSITION.zone
  return Object.entries(timing).map(([beat, steps]) => `${beat} ${steps}`).join(" · ")
}

/**
 * The door and zone transitions: from a start room with a door on every side, the player walks out through any of
 * them (and back the way it came) as a player would, on its own or on a loop, the seals shut or broken; the zone change
 * walks into the boss room's open gate (zones 1 and 2). Every beat is traced on the run clock, and the lab's time
 * controls slow it down or step it frame by frame; stopping at each beat pauses as one begins.
 */
export const doorsScene: Scene = {
  id: "doors",
  title: "Doors and transitions",
  summary: "Walk through any door, or the gate into the next zone.",
  defaults: { invulnerable: true, camera: "play" },
  usesAi: false,
  start: ({ game, zone }) => game.startZone(zone, 0, { seed: crossroads(zone) }),
  create: (tools) => {
    const { game, timeline } = tools
    const side = tools.option<string>("side", "north")
    const loop = tools.option("loop", false)
    const stops = tools.option("stops", false)
    const zone = zoneOf(tools.zone)
    const chosen = (): Side => oneOf(sides, side.get(), "north")
    /** A zone change waits for the boss room, then walks out through its gate. */
    let toGate = false
    let restFrom: number | null = null
    let lastBeat: TransitionBeat | null = null
    let walks = 0
    let note = ""
    game.clearRooms()
    const view = () => tools.context.game.view()
    timeline.setup("Transition · run-clock steps at 60 a second", LANES, 220)
    timeline.begin(view().tempo.step)
    const doorOn = (now: GameView, target: Side | "gate"): DoorView | undefined =>
      now.room?.doors.find((door) => (target === "gate" ? door.mark === "gate" : door.side === target && door.mark !== "gate"))

    /** Puts the player just inside the door and holds the stick out through it; the transition lets go. */
    const walk = (target: Side | "gate") => {
      const now = view()
      if (now.transition !== null) return
      const door = doorOn(now, target)
      if (door === undefined) {
        note = target === "gate" ? "No gate here" : `No door ${target}`
        return
      }
      if (door.state === "locked") {
        note = "Sealed: break the seals"
        return
      }
      note = ""
      const dir = SIDE_DIRS[door.side]
      game.teleport(door.x - dir.x * RUN_UP, door.z - dir.z * RUN_UP, Math.atan2(dir.z, dir.x))
      game.steer(dir.x, dir.z)
      walks += 1
      timeline.begin(now.tempo.step)
    }
    const zoneChange = () => {
      if (zone.next === null) {
        note = "Zone 3 has no gate"
        return
      }
      toGate = true
      game.enterRoom("boss", { instant: true })
    }

    tools.on("transitionStarted", (moment) => {
      game.steer(0, 0)
      timeline.mark(view().tempo.step, "play", moment.kind === "zone" ? "Gate" : moment.side)
    })
    tools.on("roomSwapped", () => timeline.mark(view().tempo.step, "beat", "Swap", true))
    tools.on("transitionEnded", (moment) => {
      if (moment.kind === "zone") game.clearRooms()
      restFrom = view().tempo.step
    })
    tools.on("roomEntered", (moment) => {
      if (toGate && moment.kind === "boss") {
        toGate = false
        walk("gate")
      }
    })

    return {
      controls: [
        { kind: "choice", label: "Door", options: directions, get: chosen, set: side.set },
        { kind: "action", label: "Walk through", run: () => walk(chosen()) },
        { kind: "action", label: "Walk back", run: () => walk(opposite[chosen()]) },
        { kind: "toggle", label: "Loop", get: loop.get, set: loop.set },
        { kind: "action", label: zone.next === null ? "Zone change (none)" : "Zone change", run: zoneChange },
        sealsToggle(tools),
        { kind: "toggle", label: "Stop at beats", get: stops.get, set: stops.set }
      ],
      update: (now) => {
        if (now.room !== null) tools.frame(roomFraming(now.room.layout))
        const step = now.tempo.step
        const shown = now.transition
        timeline.sample(step, "beat", shown === null ? null : BEAT_TONES[shown.beat], shown?.beat)
        timeline.sample(step, "play", shown === null ? "move" : "rest", shown === null ? "Runs" : "Held")
        timeline.playhead(step)
        const beat = shown?.beat ?? null
        if (beat !== lastBeat && beat !== null && stops.get()) tools.transport.pause(true)
        lastBeat = beat
        if (!loop.get() || shown !== null || restFrom === null || step - restFrom < REST_STEPS) return
        restFrom = null
        const here = now.room?.index ?? 0
        walk(here === 0 ? chosen() : opposite[chosen()])
      },
      readouts: (now) => {
        const shown = now.transition
        const room = now.room
        return [
          { label: "Beat", value: shown === null ? note || "Waiting" : `${shown.kind} · ${shown.beat} ${Math.round(shown.progress * 100)}%`, hot: shown !== null },
          { label: "Overall", value: shown === null ? "-" : `${Math.round(shown.overall * 100)}% · ${shown.swapped ? "swapped" : "before the swap"}` },
          { label: "Way", value: shown === null ? "-" : `${shown.from} → ${shown.to} · out ${shown.side}, in ${opposite[shown.side]}` },
          { label: "Beats", value: beatsOf(shown?.kind ?? "door") },
          { label: "Room", value: room === null ? "-" : `${zoneOf(now.zone).number} · ${room.index} ${room.kind} · ${templateName(room.template)}` },
          { label: "Doors", value: room === null ? "-" : room.doors.map((door) => `${door.mark === "gate" ? "gate" : door.side.slice(0, 1).toUpperCase()} ${door.state}`).join(" · ") },
          { label: "Walks", value: `${walks}` }
        ]
      },
      draw: (sketch, now) => {
        const room = now.room
        if (room === null || now.transition !== null) return
        for (const door of room.doors) drawDoorway(sketch, room.layout, door.side, { ...(door.state === "locked" ? INK.red : INK.paper), width: 2 }, door.side === chosen() ? INK.paper : INK.faint)
      },
      dispose: () => {
        game.steer(0, 0)
      }
    }
  }
}
