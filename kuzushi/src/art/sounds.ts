import { sound } from "@pixi/sound"

import { settings } from "./settings.ts"

/** The sound effects, each `src/audio/sfx/<name>.wav`. */
export const SFX = ["ui-move", "ui-select", "ui-back", "attack", "hit", "kill", "hurt", "dash", "parry", "special", "door", "clear", "boss"] as const
/** The music, each a loop in `src/audio/music/<track>.mp3`. */
export const TRACKS = ["title", "courtyard", "spiral", "void", "boss"] as const

export type Sfx = (typeof SFX)[number]
export type Track = (typeof TRACKS)[number]

const sfxFiles = import.meta.glob<string>("../audio/sfx/*.wav", { eager: true, query: "?url", import: "default" })
const musicFiles = import.meta.glob<string>("../audio/music/*.mp3", { eager: true, query: "?url", import: "default" })

/** A track's alias in @pixi/sound, apart from the sound effects' (the boss has both). */
export const musicAlias = (track: Track) => `music/${track}`

/** A volume setting, heard as its square: 80% is about -4 dB, 50% -12 dB. */
const level = (setting: number) => setting ** 2

const add = (alias: string, url: string | undefined) => new Promise<void>((resolve) => {
  if (url === undefined) {
    console.error(`sounds: no file for ${alias}`)
    resolve()
    return
  }
  sound.add(alias, {
    url,
    preload: true,
    loaded: (error) => {
      if (error) console.error(error)
      resolve()
    }
  })
})

let loading: Promise<void> | null = null

/** Registers every sound and track with @pixi/sound and loads them, once; resolves when each has loaded or failed. */
export const loadSounds = (): Promise<void> => {
  loading ??= Promise.all([
    ...SFX.map((name) => add(name, sfxFiles[`../audio/sfx/${name}.wav`])),
    ...TRACKS.map((track) => add(musicAlias(track), musicFiles[`../audio/music/${track}.mp3`]))
  ]).then(() => {
    settings.subscribe((values) => {
      for (const name of SFX) if (sound.exists(name)) sound.find(name).volume = level(values.sfx)
      for (const track of TRACKS) if (sound.exists(musicAlias(track))) sound.find(musicAlias(track)).volume = level(values.music)
    })
  })
  return loading
}

/** Plays a sound effect at the settings' volume; nothing while it hasn't loaded. */
export const play = (name: Sfx): void => {
  if (sound.exists(name) && sound.find(name).isPlayable) void sound.play(name)
}
