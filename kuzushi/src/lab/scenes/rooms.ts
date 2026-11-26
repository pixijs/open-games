import { DOOR, doorLine, isTemplateId, onSide, ROOM, sides, templateOf, templatesFor } from "../../sim/index.ts"
import type { ArenaLayout, HazardView, TemplateId, TemplateRole, ZoneId } from "../../sim/index.ts"
import { roomFraming } from "../camera.ts"
import { oneOf } from "../choose.ts"
import { findRoom, templateName } from "../dungeons.ts"
import type { Option, OptionOf, Scene } from "../scene.ts"
import { INK } from "../sketch.ts"
import type { Sketch } from "../sketch.ts"
import { drawDoorway, sealed, sealsToggle } from "./roster.ts"

const ROLE_ORDER: ReadonlyArray<TemplateRole> = ["start", "shrine", "small", "medium", "large", "boss"]

/** A zone's templates, start and shrine first, the boss's last. */
const templatesOf = (zone: ZoneId): ReadonlyArray<TemplateId> => ROLE_ORDER.flatMap((role) => templatesFor(zone, role))

/** The room's options, the same in `start` (which picks the seed) and in the scene. */
const choicesOf = (zone: ZoneId, option: OptionOf) => {
  const list = templatesOf(zone)
  const stored = option<string>(`template.${zone}`, list[0] ?? "courtyard.forecourt")
  const template: TemplateId = oneOf(list, stored.get(), list[0] ?? "courtyard.forecourt")
  return {
    list,
    stored,
    template,
    mirrorX: option("mirrorX", false),
    mirrorZ: option("mirrorZ", false),
    fight: option("fight", false)
  }
}

const degrees = (radians: number) => `${Math.round((((radians * 180) / Math.PI) % 360 + 360) % 360)}°`

const phaseOf = (hazard: HazardView): string => {
  switch (hazard.kind) {
    case "none": return "None in this room"
    case "beam": return !hazard.on && hazard.phase === "rest" ? "Off" : `${hazard.phase} · ${hazard.timeLeft.toFixed(1)} s left`
    case "slabs": {
      const cracking = hazard.slabs.filter((slab) => slab.state === "cracking").length
      return cracking > 0 ? `Cracking · ${Math.round(hazard.crack * 100)}%` : hazard.on ? "Standing" : "Off"
    }
  }
}

/** The beam's hit strip and its telegraph line, and the outline of each slab still standing or cracking. */
const drawHazard = (sketch: Sketch, hazard: HazardView) => {
  if (hazard.kind === "beam") {
    const strip = (angle: number, reach: number, halfWidth: number) => {
      const dirX = Math.cos(angle)
      const dirZ = Math.sin(angle)
      const at = (along: number, across: number) => ({ x: hazard.x + dirX * along - dirZ * across, z: hazard.z + dirZ * along + dirX * across })
      return [at(hazard.from, -halfWidth), at(reach, -halfWidth), at(reach, halfWidth), at(hazard.from, halfWidth)]
    }
    if (hazard.phase === "sweep") sketch.path(strip(hazard.angle, hazard.reach, hazard.halfWidth), { ...INK.red, width: 2, fill: 0.2 }, true)
    if (hazard.telegraph !== null) sketch.path(strip(hazard.telegraph.angle, hazard.telegraph.reach, 0.04), INK.redFaint, true)
    sketch.circle(hazard.x, hazard.z, hazard.from, INK.grey)
    return
  }
  if (hazard.kind !== "slabs") return
  for (const slab of hazard.slabs) {
    if (slab.state === "fallen") continue
    const corners = [
      { x: slab.x - slab.halfWidth, z: slab.z - slab.halfDepth },
      { x: slab.x + slab.halfWidth, z: slab.z - slab.halfDepth },
      { x: slab.x + slab.halfWidth, z: slab.z + slab.halfDepth },
      { x: slab.x - slab.halfWidth, z: slab.z + slab.halfDepth }
    ]
    sketch.path(corners, slab.state === "cracking" ? { ...INK.red, width: 2, fill: 0.12 } : INK.grey, true)
  }
}

/** Each doorway's lane (3 wide, 4 deep: no prop stands in it), where a player arrives, and the line past which a walk out starts the transition. */
const drawDoors = (sketch: Sketch, layout: ArenaLayout) => {
  for (const side of sides) {
    const line = doorLine(layout, side)
    const half = DOOR.width / 2
    const lane = [onSide(side, line, -half), onSide(side, line - DOOR.lane, -half), onSide(side, line - DOOR.lane, half), onSide(side, line, half)]
    sketch.path(lane, { ...INK.faint, fill: 0.05 }, true)
    drawDoorway(sketch, layout, side, { ...INK.paper, width: 1 }, INK.faint)
  }
}

/**
 * Any room template of the zone, as the generator places it (a seed is found that builds it mirrored as asked, in the
 * room with the most doors), empty or with its own waves: its doorways with their lanes, arrival points and exit lines,
 * its spawn points, altars and spring marked on the floor, its seals shut or broken, and its hazard (which runs only
 * while the seals are shut) on its clock or called now.
 */
export const roomsScene: Scene = {
  id: "rooms",
  title: "Rooms and hazards",
  summary: "Every room template, its doors, spawn points and hazard.",
  defaults: { invulnerable: true, camera: "top" },
  usesAi: false,
  start: ({ game, zone, option }) => {
    const chosen = choicesOf(zone, option)
    const placed = findRoom(chosen.template, chosen.mirrorX.get(), chosen.mirrorZ.get())
    game.startZone(zone, chosen.fight.get() ? placed?.index ?? 0 : 0, { seed: placed?.seed ?? 1 })
  },
  create: (tools) => {
    const { game } = tools
    const chosen = choicesOf(tools.zone, tools.option)
    const placed = findRoom(chosen.template, chosen.mirrorX.get(), chosen.mirrorZ.get())
    const target = placed?.index ?? 0
    const plan = templateOf(chosen.template)
    const marks = tools.option("marks", true)
    if (!chosen.fight.get()) {
      game.clearRooms()
      if (target !== 0) game.enterRoom(target, { instant: true })
    }
    let sweeps = 0
    tools.on("beamStarted", () => {
      sweeps += 1
    })
    const view = () => tools.context.game.view()
    const hazardOn = () => {
      const hazard = view().hazard
      return hazard.kind !== "none" && hazard.on
    }
    const restart = (setting: Option<boolean>) => (on: boolean) => {
      setting.set(on)
      tools.replay()
    }

    return {
      controls: [
        { kind: "choice", label: "Room", options: chosen.list.map((each) => ({ value: each, label: `${templateName(each)} · ${templateOf(each).role}` })), get: () => chosen.template, set: (value) => {
          if (!isTemplateId(value)) return
          chosen.stored.set(value)
          tools.replay()
        } },
        { kind: "toggle", label: "Mirror X", get: chosen.mirrorX.get, set: restart(chosen.mirrorX) },
        { kind: "toggle", label: "Mirror Z", get: chosen.mirrorZ.get, set: restart(chosen.mirrorZ) },
        { kind: "toggle", label: "Its waves", get: chosen.fight.get, set: restart(chosen.fight) },
        sealsToggle(tools),
        ...(plan.hazard.kind === "beam" ? [{ kind: "action" as const, label: "Sweep the beam", run: game.sweep }] : []),
        ...(plan.hazard.kind === "collapse" ? [{ kind: "action" as const, label: "Crack the next slabs", run: game.collapse }] : []),
        ...(plan.hazard.kind === "none" ? [] : [{ kind: "toggle" as const, label: "Hazard on", get: hazardOn, set: game.hazard }]),
        { kind: "toggle", label: "Marks", get: marks.get, set: marks.set }
      ],
      update: (now) => {
        if (now.room !== null && now.room.index === target) tools.frame(roomFraming(now.room.layout))
      },
      readouts: (now) => {
        const room = now.room
        const hazard = now.hazard
        const layout = room?.layout
        return [
          { label: "Room", value: `${chosen.template} · ${plan.role}` },
          { label: "Floor", value: layout === undefined ? "-" : `${layout.halfWidth * 2} × ${layout.halfDepth * 2} · ${plan.floor.kind}${room?.mirror.x === true ? " · mirrored x" : ""}${room?.mirror.z === true ? " · mirrored z" : ""}` },
          { label: "Props", value: `${plan.blocks.length} blocks · ${plan.pillars.length} pillars · ${plan.spawnPoints.length} spawn points` },
          { label: "Doors", value: room === null ? "-" : room.doors.map((door) => `${door.side[0]?.toUpperCase()} ${door.state}`).join(" · ") || "none", hot: sealed(view()) },
          { label: "Seed", value: placed === null ? "not found" : `${placed.seed} · room ${placed.index} · ${room?.state ?? "-"}` },
          { label: "Hazard", value: phaseOf(hazard), hot: (hazard.kind === "beam" && hazard.phase === "sweep") || (hazard.kind === "slabs" && hazard.crack > 0) },
          ...(hazard.kind === "beam" ? [{ label: "Beam", value: `${degrees(hazard.angle)} · reach ${hazard.reach.toFixed(1)} u · ${sweeps === 1 ? "1 sweep" : `${sweeps} sweeps`}` }] : []),
          ...(hazard.kind === "slabs" ? [{
            label: "Slabs",
            value: (["standing", "cracking", "fallen"] as const).map((state) => `${hazard.slabs.filter((slab) => slab.state === state).length} ${state}`).join(" · ")
          }] : [])
        ]
      },
      draw: (sketch, now) => {
        drawHazard(sketch, now.hazard)
        const room = now.room
        if (!marks.get() || room === null) return
        drawDoors(sketch, room.layout)
        for (const point of room.layout.spawnPoints) {
          sketch.path([{ x: point.x - 0.3, z: point.z }, { x: point.x + 0.3, z: point.z }], INK.red)
          sketch.path([{ x: point.x, z: point.z - 0.3 }, { x: point.x, z: point.z + 0.3 }], INK.red)
        }
        for (const altar of room.altars) sketch.circle(altar.x, altar.z, ROOM.altarReach, altar.near ? INK.paper : INK.faint)
        if (room.spring !== null) sketch.circle(room.spring.x, room.spring.z, room.spring.radius, room.spring.spent ? INK.faint : INK.paper)
      }
    }
  }
}
