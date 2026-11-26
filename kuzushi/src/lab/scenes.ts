import type { Scene } from "./scene.ts"
import { attacksScene } from "./scenes/attacks.ts"
import { bossesScene } from "./scenes/bosses.ts"
import { doorsScene } from "./scenes/doors.ts"
import { dungeonScene } from "./scenes/dungeon.ts"
import { galleryScene } from "./scenes/gallery.ts"
import { movementScene } from "./scenes/movement.ts"
import { roomsScene } from "./scenes/rooms.ts"
import { specialScene } from "./scenes/special.ts"
import { threatsScene } from "./scenes/threats.ts"
import { zonesScene } from "./scenes/zones.ts"

/** The lab's scenes, in list order: the fight first (the special, the weapons, the enemies, the bosses, moving), then the world (zones, rooms, dungeons, doors). */
export const SCENES: ReadonlyArray<Scene> = [
  specialScene,
  attacksScene,
  galleryScene,
  threatsScene,
  bossesScene,
  movementScene,
  zonesScene,
  roomsScene,
  dungeonScene,
  doorsScene
]
