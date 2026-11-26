import { sound } from "@pixi/sound"

import { loadSounds, musicAlias, play } from "../art/sounds.ts"
import type { Sfx, Track } from "../art/sounds.ts"
import type { Install } from "../host/types.ts"
import type { GameView, MomentOf, MomentType } from "../sim/index.ts"

/** The track for what is on screen: the title's on the title, the boss's from its name card until it falls, else the zone's. */
const trackOf = (view: GameView): Track => {
  if (view.flow === "Title") return "title"
  if (view.boss !== null && view.boss.state !== "defeated") return "boss"
  return view.zone
}

/**
 * The game's sound effects and music through @pixi/sound (docs/DESIGN.md, Audio): a sound on each of a few moments,
 * and one looping track for what is on screen. Loading loads every file; nothing plays while it runs.
 */
export const installAudio: Install = (context) => {
  const loaded = loadSounds()
  const hear = <T extends MomentType>(type: T, name: Sfx, when: (moment: MomentOf<T>) => boolean = () => true) =>
    context.moments.on(type, (moment) => {
      if (!context.loading && when(moment)) play(name)
    })
  const offs = [
    hear("attack", "attack"),
    hear("hit", "hit", (hit) => !hit.killed),
    hear("enemyKilled", "kill"),
    hear("playerHurt", "hurt"),
    hear("dashStarted", "dash"),
    hear("parry", "parry"),
    hear("specialStarted", "special"),
    hear("doorsLocked", "door"),
    hear("doorsOpened", "door"),
    hear("roomCleared", "clear"),
    hear("bossIntro", "boss"),
    hear("bossFelled", "boss")
  ]

  // @pixi/sound starts audio on the first click or tap; this game is played with keys, so the first key starts it too.
  const unlock = () => {
    const audio = sound.context.audioContext
    if (audio.state === "running") window.removeEventListener("keydown", unlock, true)
    else void audio.resume()
  }
  window.addEventListener("keydown", unlock, true)

  let track: Track | null = null
  return {
    update: () => {
      if (context.loading) return
      const next = trackOf(context.game.view())
      if (next === track) return
      if (track !== null) sound.stop(musicAlias(track))
      track = next
      const music = sound.exists(musicAlias(next)) ? sound.find(musicAlias(next)) : null
      // The file holds the loop and then its first second again: looping inside it keeps the encoder's delay off the seam.
      if (music?.isPlayable === true) void music.play({ loop: true, start: 0.5, end: music.duration - 0.5 })
    },
    warm: () => [{
      label: "audio",
      async *poses() {
        await loaded
        yield "loaded"
      }
    }],
    dispose: () => {
      for (const off of offs) off()
      window.removeEventListener("keydown", unlock, true)
      if (track !== null) sound.stop(musicAlias(track))
    }
  }
}
