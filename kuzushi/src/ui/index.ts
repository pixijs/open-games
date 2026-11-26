import { gsap } from "gsap"
import { mulberry32 } from "math/random"
import { Container } from "pixi.js"

import { LAUNCH_SECONDS } from "../art/title-cues.ts"
import type { TitleCues } from "../art/title-cues.ts"
import type { Install } from "../host/types.ts"
import { bossOf, WEAPON_LIST, ZONE_LIST } from "../sim/index.ts"
import type { DropKind, GameView, ZoneId } from "../sim/index.ts"
import { accentOf, greyOf } from "./accent.ts"
import { createAltarPrompt } from "./altar.ts"
import { createBanner } from "./banner.ts"
import { createBossBar } from "./boss-bar.ts"
import { createBossCard } from "./boss-card.ts"
import { el } from "./dom.ts"
import { playUiHidden } from "./extras.ts"
import { createFps } from "./fps.ts"
import { createHud } from "./hud.ts"
import { refreshDigits } from "./kit/digits.ts"
import { createDrain } from "./kit/drain.ts"
import { refreshFonts, scaleType } from "./kit/type.ts"
import { viewportOf } from "./kit/viewport.ts"
import { createMapOverlay } from "./map-overlay.ts"
import { createPause } from "./pause.ts"
import { markReached, recordZone } from "./records.ts"
import { createResults } from "./results.ts"
import type { Staged, StageScreen, Tinted } from "./screen.ts"
import { COVER_LIFT_SECONDS, createLaunchCover } from "./launch.ts"
import { createSweep } from "./sweep.ts"
import { createTitle } from "./title.ts"
import { createZoneCard } from "./zone-card.ts"
import "./ui.css"

type Flow = GameView["flow"]

declare global {
  interface Window {
    /** The HUD's and the boss bar's parts on screen, [left, right, top, bottom] in CSS px, by label (and the window as `w`), for layout checks. */
    __ui?: { rects(): Record<string, ReadonlyArray<number>> }
  }
}

const FONTS = ['300 16px "Barlow Condensed"', '400 16px "Barlow Condensed"', '500 16px "Barlow Condensed"', '600 16px "Barlow Condensed"', 'italic 700 16px "Barlow Condensed"', '400 16px "Barlow"', '16px "Yuji Boku"']

/**
 * Every kanji the UI draws, so Yuji Boku's subsets for them load before the first text: canvas text drawn before its
 * glyphs arrive keeps the fallback face until `refreshFonts`. New kanji come from data here or join the literal.
 */
const KANJI = "崩し出陣操作設定特典一時停止完敗" + ZONE_LIST.map((zone) => zone.kanji + bossOf(zone.boss).kanji).join("") + WEAPON_LIST.map((weapon) => weapon.kanji).join("")

/** True once the special has played out: time runs again, the player is free and its slow motion is over. */
const specialDone = (view: GameView) => !view.tempo.frozen && view.player?.state !== "Special" && view.tempo.slowScale === 1

/** The zone change's ink sheet covers the screen for its card: the HUD and the boss's bar step back until it lifts. */
const zoneCard = (view: GameView) => view.transition?.kind === "zone" && (view.transition.beat === "cover" || view.transition.beat === "card")

/** A boss's name card or its defeat under cinema bars has the screen: the HUD steps back, the boss's bar plays on. */
const bossBeat = (view: GameView) => view.boss?.state === "intro" || view.boss?.state === "defeated"

/**
 * Loads the UI's web fonts. `ready` waits for them, but never longer than `ms`: a slow network shows the fallbacks
 * instead. `late` resolves only if they arrive after that, so what was drawn in the fallbacks can be redrawn.
 */
const loadFonts = (ms: number) => {
  const loads = Promise.all(FONTS.map((font) => document.fonts.load(font, font.includes("Yuji") ? KANJI : "A"))).catch(() => [])
  const ready = Promise.race([loads.then(() => true), new Promise<boolean>((resolve) => setTimeout(resolve, ms, false))])
  const late = ready.then((inTime) => (inTime ? new Promise<void>(() => {}) : loads.then(() => {})))
  return { ready, late }
}

/**
 * The game's UI, drawn in Pixi on `layers.ui` and animated with GSAP: the title and its menus, pause, the HUD with its
 * minimap and the weapon in hand, the map over play, banners, a boss's name card and bar, the zone change's card, the
 * altar's prompt, the results screens and the FPS readout. It reads the game's view each frame, reacts to moments, and
 * sends intents; it tells the title scene what the menu does through `cues`. In play it takes the zone's accent. Menu
 * screens are modal while up: each holds the keyboard in a hidden sink under the overlay's `.k-ui` root, so the keys
 * they use never reach the game, and only then does `layers.ui` take the pointer.
 */
export const installUi = (cues: TitleCues): Install => async (context) => {
  const fonts = loadFonts(1500)
  await fonts.ready
  const { intents } = context
  const read = context.game.view
  const random = mulberry32.create(0x6b75)
  /** The DOM's only part in the UI: the parent of the modal screens' keyboard sinks. */
  const root = el("div", "k-ui")
  const drain = createDrain(context.frame)
  const sweep = createSweep()
  /** The cut between screens, in the zone's accent (the Courtyard's red from the title). */
  const cut = () => {
    const view = read()
    return sweep.cut(mulberry32.next(random) % 997, accentOf(view.flow === "Title" ? "courtyard" : view.zone))
  }

  const hud = createHud(read().maxLives)
  const banner = createBanner()
  const bossBar = createBossBar()
  window.__ui = { rects: () => ({ ...hud.rects(), ...bossBar.rects(), w: [window.innerWidth, window.innerHeight] }) }
  const bossCard = createBossCard()
  const card = createZoneCard()
  const mapOverlay = createMapOverlay(read, () => {
    const player = read().player
    const at = player === null ? null : context.view.worldToScreen({ x: player.x, y: 0, z: player.z })
    return at === null ? null : at.x / Math.max(1, context.app.screen.width)
  })
  const altar = createAltarPrompt((x, y, z) => context.view.worldToScreen({ x, y, z }))
  /** Where the room's boss stands on screen, its body's middle; null with none. */
  const bossOnScreen = (view: GameView) => {
    const boss = view.boss === null ? undefined : view.enemies.find((enemy) => enemy.id === view.boss?.id)
    return boss === undefined ? null : context.view.worldToScreen({ x: boss.x, y: 1, z: boss.z })
  }
  const fps = createFps()
  const cover = createLaunchCover()
  const title = createTitle({
    overlay: root,
    drain,
    launch: (zone) => {
      cover.close(zone.id)
      gsap.delayedCall(LAUNCH_SECONDS, () => intents.startZone(zone.id))
    },
    cut,
    cues
  })
  /**
   * What is drawn in Pixi on `layers.ui`, bottom to top: `play` holds what sits over play (the HUD, the altar's card,
   * the boss's bar, banners, the map over play), `cards` a boss's name card and the zone card, `screens` pause and the
   * results, then the launch's ink cover, the title, the cut between screens, and `readout` the FPS readout.
   */
  const play = new Container({ label: "ui-play" })
  const cards = new Container({ label: "ui-cards" })
  const screenSlot = new Container({ label: "ui-screens" })
  const readout = new Container({ label: "ui-readout" })
  // What sits over play never takes the pointer: presses reach the game (left attacks, right parries).
  for (const slot of [play, cards, readout]) slot.eventMode = "none"
  const pause = createPause({ intents, read, overlay: root, drain })
  const results = createResults({ intents, overlay: root, drain })
  const screens: Partial<Record<Flow, StageScreen>> = { Title: title, Paused: pause, RunClear: results, GameOver: results }

  context.overlay.append(root)
  context.layers.ui.addChild(play, cards, screenSlot, cover.node, title.node, sweep.node, readout)
  play.addChild(hud.node, altar.node, bossBar.node, banner.node, mapOverlay.node)
  screenSlot.addChild(pause.node, results.node)
  cards.addChild(bossCard.node, card.node)
  readout.addChild(fps.node)
  /** Laid out at install and on every resize. */
  const stage: ReadonlyArray<Staged> = [hud, altar, bossBar, banner, mapOverlay, bossCard, card, pause, results, fps, cover, title, sweep]
  /**
   * Recoloured as the accent changes; the zone card colours itself from the zones it plays between. What sits over play
   * goes grey under pause, as the scene drains behind it.
   */
  const overPlay: ReadonlyArray<Tinted> = [hud, altar, bossBar, banner, mapOverlay]
  const tinted: ReadonlyArray<Tinted> = [sweep, bossCard, pause, results]
  let disposed = false
  const relayout = () => {
    const viewport = viewportOf(context.app.screen.width, context.app.screen.height, context.app.renderer.resolution)
    scaleType(viewport.scale)
    refreshDigits(viewport.resolution)
    for (const screen of stage) screen.layout(viewport)
  }
  relayout()
  await title.ready
  context.app.renderer.on("resize", relayout)
  void fonts.late.then(() => {
    if (disposed) return
    refreshFonts()
    relayout()
  })

  /** The screens wait for loading to end, so the title's menu plays its intro as the loader lifts. */
  let entered = false
  void context.loaded.then(() => {
    entered = true
  })
  // The results' seals in every zone's accent, rasterised during the boot, go to the GPU while loading.
  const seals = await results.seals
  let flow: Flow | null = null
  let accent: ZoneId | null = null
  let greyed = false
  let bannered = 0
  /** Seconds the first banner of a run waits for the cut into it: the cover's lift from the title, a restart's slash, or none. */
  let cutting = 0
  /** The run's start has yet to show its first zone's banner (it waits for the start room). */
  let opening = false
  let zonesCleared = 0
  /** What the room's clear left on the floor, shown on its CLEAR banner as the seals break. */
  let dropped: ReadonlyArray<DropKind> = []
  /** From the special's start until it has played out: the HUD and banners wait, so the finisher has the frame. */
  let special: { pending: (() => void) | null } | null = null
  const later = (show: () => void) => {
    if (special === null) show()
    else special.pending = show
  }

  const go = (view: GameView) => {
    if (view.flow === flow) return
    const from = flow
    flow = view.flow
    context.layers.ui.interactiveChildren = flow === "Title" || flow === "Paused" || flow === "RunClear" || flow === "GameOver"
    if (from === "Title" && view.flow === "Playing") cover.lift()
    const leaving = from === null ? undefined : screens[from]
    const arriving = screens[view.flow]
    if (leaving !== arriving) {
      leaving?.exit()
      arriving?.enter(view)
    }
    if (view.flow !== "Playing" && view.flow !== "Paused") banner.hide()
    hud.show(view.flow === "Playing" || view.flow === "Paused", from === "Title" ? COVER_LIFT_SECONDS : 0.1)
  }

  const unsubscribe = [
    context.moments.on("runStarted", (moment) => {
      hud.reset()
      bannered = 0
      special = null
      zonesCleared = 0
      dropped = []
      opening = !moment.sandbox
      // The run's moments arrive before the flow changes: from the title, its cover parts over the start room.
      if (flow === "Title") {
        cutting = COVER_LIFT_SECONDS
        return
      }
      cut()
      cutting = 0.45
    }),
    context.moments.on("zoneStarted", (moment) => markReached(moment.zone)),
    context.moments.on("roomEntered", (moment) => {
      bannered = 0
      dropped = []
      if (!opening) return
      opening = false
      if (moment.kind === "start") banner.intro(moment.zone, cutting || 0.1)
    }),
    context.moments.on("transitionStarted", (moment) => {
      if (moment.kind === "zone") banner.hide()
    }),
    context.moments.on("specialStarted", () => {
      special = { pending: null }
      banner.hide()
    }),
    context.moments.on("waveCleared", (moment) => later(() => banner.cleared(moment, context.game.arena))),
    context.moments.on("roomCleared", (moment) => {
      dropped = moment.drops
    }),
    context.moments.on("doorsOpened", () => {
      const room = read().room
      if (room === null || room.kind === "boss" || room.state !== "cleared") return
      const reward = { drops: dropped }
      dropped = []
      later(() => banner.clear(reward))
    }),
    context.moments.on("zoneCleared", (moment) => {
      zonesCleared += 1
      const best = recordZone(moment.zone, moment.time)
      later(() => banner.zone({ zone: moment.zone, time: moment.time, best, gate: moment.next !== null }))
    }),
    context.moments.on("hit", () => hud.hit()),
    context.moments.on("playerHurt", () => hud.hurt()),
    context.moments.on("runCleared", (moment) => results.record(moment, zonesCleared)),
    context.moments.on("gameOver", (moment) => results.record(moment, zonesCleared))
  ]

  return {
    update: (frame) => {
      const view = read()
      if (entered) go(view)
      const tone = view.flow === "Title" ? "courtyard" : view.zone
      const paused = view.flow === "Paused"
      if (tone !== accent || paused !== greyed) {
        const colour = accentOf(tone)
        if (tone !== accent) for (const piece of tinted) piece.tint(colour)
        for (const piece of overPlay) piece.tint(paused ? greyOf(colour) : colour)
        accent = tone
        greyed = paused
      }
      play.visible = !playUiHidden()
      readout.visible = !playUiHidden()
      if (view.flow === "Playing" && view.wave.phase === "intro" && view.wave.index !== bannered) {
        bannered = view.wave.index
        banner.wave(view.wave.index, view.wave.total, view.wave.mix, view.zone, cutting)
        cutting = 0
      }
      if (special !== null && specialDone(view)) {
        const pending = special.pending
        special = null
        if (pending !== null && view.flow === "Playing") pending()
      }
      const inPlay = view.flow === "Playing" || view.flow === "Paused"
      const held = special !== null || zoneCard(view)
      if (inPlay) hud.update(view, frame, held || bossBeat(view))
      bossBar.update(inPlay ? view.boss : null, held || view.flow !== "Playing", bossOnScreen(view))
      bossCard.update(inPlay ? view.boss : null)
      card.update(inPlay ? view.transition : null, view.zone)
      mapOverlay.update(view)
      altar.update(view.room?.altars ?? [], view.weapon.id, view.flow === "Playing" && view.transition === null && special === null && !mapOverlay.open && !banner.showing())
      fps.update(view.flow === "Title")
    },
    warm: () => [{ label: "ui", uploads: () => seals.map((seal) => seal.source) }],
    dispose: () => {
      disposed = true
      context.app.renderer.off("resize", relayout)
      for (const screen of stage) screen.dispose()
      for (const slot of [play, cards, screenSlot, readout]) slot.destroy({ children: true })
      for (const off of unsubscribe) off()
      delete window.__ui
      root.remove()
    }
  }
}
