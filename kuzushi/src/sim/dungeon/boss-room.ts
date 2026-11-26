import { startingHazard } from "../hazards.ts"
import { CurrentStage, Game, Hazard, Moments } from "../schema.ts"
import { PlayTime } from "../time.ts"
import type { RoomGround } from "./schema.ts"
import { Dungeon, updateRoom } from "./schema.ts"
import { templateOf } from "./templates.ts"

/** The template index of the `standing`th pillar still up: a stun names pillars as the layout lists them, the broken ones gone. */
const templatePillar = (ground: RoomGround, standing: number): number | undefined =>
  templateOf(ground.template).pillars.flatMap((_, index) => (ground.broken.includes(index) ? [] : [index]))[standing]

/**
 * What a boss changes in its room, told by its moments (docs/DESIGN.md, Bosses): a Gatekeeper charge that breaks a
 * pillar takes it out of the layout and terrain for good, and the first shift lights the room's boss hazard (the
 * Orrery becomes the beam's spire). The room's record keeps both, as it keeps fallen slabs. Sunder's slabs fall by its
 * phase in RunHazards.
 */
export const BossRoom = Game.System("Game/BossRoom", {
  resources: {
    play: Game.System.readResource(PlayTime),
    stage: Game.System.writeResource(CurrentStage),
    hazard: Game.System.writeResource(Hazard),
    dungeon: Game.System.writeResource(Dungeon)
  },
  events: { heard: Game.System.readEvent(Moments) }
}, ({ resources, events }) => {
  const current = resources.stage.get()
  const ground = current.room
  if (ground === null) return
  const template = templateOf(ground.template)
  let changed = ground
  for (const moment of events.heard.all()) {
    if (moment.type === "bossStunned" && moment.breaks && moment.pillar !== null) {
      const pillar = templatePillar(changed, moment.pillar)
      if (pillar !== undefined) changed = { ...changed, broken: [...changed.broken, pillar] }
    }
    if (moment.type === "bossPhase" && !changed.lit && template.bossHazard !== undefined) {
      changed = { ...changed, lit: true }
      resources.hazard.set(startingHazard(template.bossHazard, resources.play.get(), 0))
    }
  }
  if (changed === ground) return
  resources.stage.set({ ...current, room: changed })
  const dungeon = resources.dungeon.get()
  if (dungeon._tag !== "Zone") return
  resources.dungeon.set(updateRoom(dungeon, ground.index, (record) => ({ ...record, broken: changed.broken, lit: changed.lit })))
})
