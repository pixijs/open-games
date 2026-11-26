import type { WarmupStep } from "../host/types.ts"
import { enemyKinds } from "../sim/index.ts"
import type { RoomDeps } from "./rooms/index.ts"

/**
 * What loading hands the GPU for look: its textures (the Courtyard's classic floor, the concrete grain, every enemy's
 * glyph and the player's dash keys, the small sprites and each zone's orbs) and the room kit, then every Courtyard room
 * floor, drawn and uploaded before the title shows.
 */
export const makeLookWarm = ({ textures, kit, art }: RoomDeps): WarmupStep => ({
  label: "look",
  uploads: () => [
    textures.floor,
    textures.concrete,
    ...enemyKinds.map((kind) => textures[kind]),
    ...textures.playerKeys,
    textures.shadow,
    textures.glow,
    textures.orb,
    textures.streak,
    textures.fleck,
    ...Object.values(textures.zoneOrbs).flatMap(({ orb, pale }) => [orb, pale]),
    ...kit.all
  ].map((texture) => texture.source),
  poses: async function* () {
    await art.prepare("courtyard")
    yield "courtyard floors"
  }
})
