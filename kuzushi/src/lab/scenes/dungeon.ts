import { ROOM_KINDS } from "../../sim/index.ts"
import { planOf, templateName } from "../dungeons.ts"
import type { Plan } from "../dungeons.ts"
import { createLabMap } from "../map.ts"
import { roomFraming } from "../camera.ts"
import type { Scene } from "../scene.ts"
import { waveCode } from "./roster.ts"

const SEEDS = { min: 1, max: 999 } as const

const seedOption = "seed"

const deadEndsOf = (plan: Plan) => plan.exits.filter((exits, index) => index > 0 && exits.length === 1).length

/**
 * A zone's dungeon for any seed, the generator's whole plan on the lab's map (each room's kind, depth, waves and
 * template, the way from the start to the boss in the zone's accent), seeds browsed one by one or picked on a slider,
 * and the run itself in that dungeon: any room entered through a door's transition or at once, its rooms cleared
 * beforehand so none locks, or fought for real with the map's fog as the player sees it.
 */
export const dungeonScene: Scene = {
  id: "dungeon",
  title: "Dungeon",
  summary: "A zone's map for any seed; walk into any room.",
  defaults: { invulnerable: true, camera: "play" },
  usesAi: false,
  start: ({ game, zone, option }) => game.startZone(zone, 0, { seed: option(seedOption, 1).get() }),
  create: (tools) => {
    const { game } = tools
    const seed = tools.option(seedOption, 1)
    const fights = tools.option("fights", false)
    const instant = tools.option("instant", false)
    const shown = tools.option("map", true)
    const fog = tools.option("fog", false)
    const plan = planOf(tools.zone, seed.get())
    const boss = plan.path.at(-1) ?? 0
    let picked = boss
    if (!fights.get()) game.clearRooms()

    const enter = (index: number) => {
      const view = tools.context.game.view()
      if (view.transition !== null || view.map?.current === index) return
      game.enterRoom(index, { instant: instant.get() })
    }
    const map = createLabMap((index) => {
      if (index === picked) enter(index)
      picked = index
    })
    tools.layer.append(map.element)
    const reseed = (value: number) => {
      seed.set(Math.min(SEEDS.max, Math.max(SEEDS.min, Math.round(value))))
      tools.replay()
    }
    const pick = (by: number) => {
      picked = (picked + by + plan.rooms.length) % plan.rooms.length
    }

    return {
      controls: [
        { kind: "action", label: "Previous seed", run: () => reseed(seed.get() - 1) },
        { kind: "action", label: "Next seed", run: () => reseed(seed.get() + 1) },
        { kind: "action", label: "Pick previous", run: () => pick(-1) },
        { kind: "action", label: "Pick next", run: () => pick(1) },
        { kind: "action", label: "Enter picked", run: () => enter(picked) },
        { kind: "toggle", label: "At once", get: instant.get, set: instant.set },
        { kind: "toggle", label: "Rooms fight", get: fights.get, set: (on) => {
          fights.set(on)
          tools.replay()
        } },
        { kind: "toggle", label: "Map", get: shown.get, set: shown.set },
        { kind: "toggle", label: "Fog", get: fog.get, set: fog.set },
        { kind: "range", label: "Seed", min: SEEDS.min, max: SEEDS.max, step: 1, get: seed.get, set: reseed, format: (value) => `${value}` }
      ],
      update: (view) => {
        if (view.room !== null) tools.frame(roomFraming(view.room.layout))
        if (!shown.get()) {
          map.hide()
          return
        }
        map.show(plan, {
          current: view.map?.current ?? null,
          selected: picked,
          states: fog.get() ? view.map?.rooms.map((room) => room.state) : undefined
        })
      },
      readouts: (view) => {
        const room = plan.rooms[picked]
        const at = view.map === null ? null : plan.rooms[view.map.current]
        return [
          { label: "Dungeon", value: `${plan.rooms.length} rooms · ${deadEndsOf(plan)} dead ends · boss ${plan.rooms[boss]?.depth ?? 0} deep` },
          { label: "To boss", value: `${plan.path.join(" → ")} · ${Math.max(0, plan.path.length - 1)} doors` },
          { label: "Picked", value: room === undefined ? "-" : `${picked} ${ROOM_KINDS[room.kind].name} · depth ${room.depth} · ${templateName(room.template)}` },
          { label: "Waves", value: room === undefined || room.waves.length === 0 ? "none" : room.waves.map(waveCode).join(" / ") },
          { label: "Player in", value: at === null || at === undefined ? "-" : `${view.map?.current} ${ROOM_KINDS[at.kind].name} · ${view.room?.state ?? "-"}${view.transition === null ? "" : ` · ${view.transition.beat}`}`, hot: view.transition !== null }
        ]
      },
      dispose: () => {
        map.element.remove()
      }
    }
  }
}
