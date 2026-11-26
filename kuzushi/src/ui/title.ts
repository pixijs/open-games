import { gsap } from "gsap"
import { Container, Graphics, Rectangle, SmoothGraphics } from "pixi.js"

import { PALETTE } from "../art/palette.ts"
import type { TitleCues } from "../art/title-cues.ts"
import type { Zone } from "../sim/index.ts"
import { accentOf } from "./accent.ts"
import { brushStroke } from "./brush.ts"
import { createCorners } from "./kit/corners.ts"
import type { Drain } from "./kit/drain.ts"
import { inkContext } from "./kit/ink.ts"
import { hint } from "./kit/keycap.ts"
import { createMenu } from "./kit/menu.ts"
import { createSheet } from "./kit/sheet.ts"
import type { SheetEntry } from "./kit/sheet.ts"
import { blockPointer, createSink } from "./kit/sink.ts"
import { face, release, resize, textIn } from "./kit/type.ts"
import { drawn, ON_ONES, ON_TWOS } from "./motion.ts"
import { createControls } from "./panels/controls.ts"
import { createExtras } from "./panels/extras.ts"
import { createSettings } from "./panels/settings.ts"
import { createZones } from "./panels/zones.ts"
import { piece } from "./screen.ts"
import type { StageScreen } from "./screen.ts"
import { titleLayout } from "./title-layout.ts"
import type { TitleLayout } from "./title-layout.ts"
import { createWordmark, LETTER_ASPECT } from "./wordmark.ts"

export interface TitleOptions {
  /** Where the title's keyboard sink lives: the DOM overlay's root. */
  readonly overlay: HTMLElement
  /** The scene's grade, shared with pause and results: an open panel drains the scene behind it to grey. */
  readonly drain: Drain
  /** A zone card was chosen: the title stops taking input and the run should start there. */
  readonly launch: (zone: Zone) => void
  /** The screen-wide slash that cuts from the title into play. */
  readonly cut: () => gsap.core.Timeline
  readonly cues: TitleCues
}

/** How much ink an open panel lays over the drained scene behind the column. */
const DIM = 0.55
const MENU_LABELS = ["Start", "Controls", "Settings", "Extras"] as const

/** Puts a body back where its slot holds it, whole. */
const settle = (body: Container) => {
  body.position.set(0, 0)
  body.scale.set(1)
  body.angle = 0
  body.alpha = 1
  body.visible = true
}

/**
 * The title, drawn in Pixi straight over the title scene: the brush wordmark struck through in red, 崩し, the main
 * menu (START, CONTROLS, SETTINGS, EXTRAS) set large down the middle of the left half, and the keys along the foot.
 * Each item opens its panel on a sheet over the right half (the whole screen when narrow) and drains and dims the
 * scene; Esc or the sheet's back action closes it. START's sheet lists the
 * zones; choosing one launches the run, and leaving cleaves the title along a screen-wide slash. Keys reach it through
 * a hidden modal sink, so none reaches the game; a press anywhere on it never reaches the game either.
 */
export const createTitle = (options: TitleOptions): StageScreen & { readonly ready: Promise<void> } => {
  const accent = accentOf("courtyard")
  const node = new Container({ label: "title" })
  node.visible = false

  /** Ink over the whole scene, drawn in as an open panel drains it. */
  const dim = new Graphics()
  dim.alpha = 0
  node.addChild(dim)

  const ticks = createCorners({ arm: 18, weight: 1, color: PALETTE.paper, alpha: 0.55 })
  node.addChild(ticks.node)

  const wordmark = createWordmark()
  node.addChild(wordmark.node)

  const kicker = piece(node, "title-kicker")
  const kickerStyle = face({ family: "jp", size: 24 })
  const kanji = textIn("崩し", kickerStyle, PALETTE.paper)
  const kickerRule = new Graphics()
  const kickerMask = new Graphics()
  kicker.body.addChild(kanji, kickerRule)

  const menuPiece = piece(node, "title-menu")
  const footer = piece(node, "title-footer")
  const hints = [hint(["W", "S"], "Select"), hint(["Enter"], "Confirm")]
  const backHint = hint(["Esc"], "Back")
  const footRule = new Graphics().rect(0, 0, 1, 1).fill({ color: PALETTE.paper, alpha: 0.18 })
  footer.body.addChild(...hints, backHint, footRule)

  /** What a narrow screen's full sheet covers: it fades away under it. */
  const column = () => [wordmark.node, kicker.slot, menuPiece.slot, footer.slot]

  const sheetPiece = piece(node, "title-sheet")
  const tether = piece(node, "title-tether")
  const line = new SmoothGraphics(inkContext(brushStroke([[0, 0], [33, 0.4], [66, -0.3], [100, 0]], { width: 4, start: 0.2, attack: 0.3, dry: 0, seed: 31 }).shapes))
  line.tint = accent.accent
  const notch = new SmoothGraphics().poly([0, -4.5, 4.5, 0, 0, 4.5, -4.5, 0]).fill(0xffffff)
  notch.tint = accent.accent
  tether.body.addChild(line, notch)

  let layout: TitleLayout | null = null
  let leaving = false
  let intro: gsap.core.Timeline | null = null
  let leave: gsap.core.Timeline | null = null
  /** The panel open or opening; the sheet's own entry lags it while the sheet starts its slide. */
  let panel: SheetEntry | null = null
  let panelMotion: gsap.core.Timeline | null = null
  let dimming: gsap.core.Tween | null = null
  /** The tether's full length over its 100-unit drawing. */
  let reach = 1
  /** Where the foot's rule starts with the Esc hint hidden and shown. */
  let ruleFrom = { rest: 0, panel: 0 }

  let screen = { width: 0, height: 0 }
  const width = () => screen.width
  const narrow = () => layout?.narrow === true

  /** Drains the scene behind toward grey and dims it, `value` 0 to 1. */
  const drainTo = (value: number, duration: number, ease: string) => {
    options.drain.to({ desaturate: 0.85 * value, crush: 0.45 * value }, duration, ease)
    dimming?.kill()
    dimming = gsap.to(dim, { alpha: value, duration, ease })
  }
  const undrain = () => {
    options.drain.set({ desaturate: 0, crush: 0 })
    dimming?.kill()
    dim.alpha = 0
  }

  /** Where the foot's rule starts and how long it runs, with the Esc hint shown or not. */
  const ruleTo = (open: boolean) => {
    const x = open ? ruleFrom.panel : ruleFrom.rest
    const end = layout === null ? 0 : layout.footer.ruleTo - layout.footer.x
    return { x, scaleX: Math.max(0, end - x) }
  }

  const back = () => {
    if (panel === null || leaving) return
    panel = null
    panelMotion?.kill()
    sheet.hide()
    drainTo(0, 0.3, "power2.inOut")
    options.cues.send({ type: "panel", open: false })
    const rule = ruleTo(false)
    panelMotion = gsap.timeline()
      .to(line.scale, { x: 0, duration: 0.1, ease: drawn(0.1, "power2.in", ON_ONES) }, 0)
      .set(notch, { visible: false }, 0)
      .set(tether.body, { visible: false }, 0.1)
      .to(backHint, { alpha: 0, duration: 0.15 }, 0)
      .to(footRule, { x: rule.x, duration: 0.2, ease: "power2.out" }, 0)
      .to(footRule.scale, { x: rule.scaleX, duration: 0.2, ease: "power2.out" }, 0)
      .add(() => menu.rest(false), 0.1)
      .to(column(), { alpha: 1, duration: 0.2 }, 0.1)
  }

  const sheet = createSheet(back)
  sheetPiece.body.addChild(sheet.node)

  const show = (entry: SheetEntry) => {
    if (panel !== null || leaving) return
    panel = entry
    menu.rest(true)
    sink.announce(entry.title)
    options.cues.send({ type: "panel", open: true })
    drainTo(1, 0.35, "power2.out")
    placeTether()
    const rule = ruleTo(true)
    panelMotion?.kill()
    panelMotion = gsap.timeline()
      .add(() => void sheet.show(entry), 0.04)
      .to(backHint, { alpha: 1, duration: 0.2 }, 0.3)
      .to(footRule, { x: rule.x, duration: 0.2, ease: "power2.out" }, 0.3)
      .to(footRule.scale, { x: rule.scaleX, duration: 0.2, ease: "power2.out" }, 0.3)
    if (narrow()) {
      panelMotion.to(column(), { alpha: 0, duration: 0.2 }, 0)
      return
    }
    panelMotion
      .set(tether.body, { visible: true }, 0.26)
      .fromTo(line.scale, { x: 0 }, { x: reach, duration: 0.12, ease: drawn(0.12, "power2.out", ON_ONES) }, 0.26)
      .set(notch, { visible: true }, 0.36)
      .fromTo(notch.scale, { x: 1.8, y: 1.8 }, { x: 1, y: 1, duration: 0.18, ease: drawn(0.18, "back.out(3)", ON_ONES) }, 0.36)
  }

  const launch = (zone: Zone) => {
    leaving = true
    panelMotion?.progress(1)
    options.cues.send({ type: "launch" })
    options.launch(zone)
    drainTo(0, 0.15, "power2.out")
    gsap.to(sheetPiece.body, { x: `+=${Math.round(0.06 * width())}`, alpha: 0, duration: 0.3, delay: 0.06, ease: "expo.out" })
    tether.body.visible = false
  }

  const entries = {
    zones: { number: "01", title: "Start zone", kanji: "出陣", body: createZones({ launch, onMove: (index) => options.cues.send({ type: "select", index: 10 + index }) }) },
    controls: { number: "02", title: "Controls", kanji: "操作", body: createControls() },
    settings: { number: "03", title: "Settings", kanji: "設定", body: createSettings() },
    extras: { number: "04", title: "Extras", kanji: "特典", body: createExtras() }
  } as const satisfies Record<string, SheetEntry>

  const menu = createMenu([
    { label: MENU_LABELS[0], action: () => show(entries.zones) },
    { label: MENU_LABELS[1], action: () => show(entries.controls) },
    { label: MENU_LABELS[2], action: () => show(entries.settings) },
    { label: MENU_LABELS[3], action: () => show(entries.extras) }
  ], {
    numbered: true,
    outline: true,
    onMove: (index) => {
      options.cues.send({ type: "select", index })
      sink.announce(MENU_LABELS[index] ?? "")
    }
  })
  menuPiece.body.addChild(menu.node)

  const sink = createSink(options.overlay, "Kuzushi", (event) => {
    if (leaving) return true
    if (intro?.isActive() === true) intro.progress(1)
    if (event.code === "Escape") {
      if (panel === null) return false
      back()
      return true
    }
    return panel === null ? menu.key(event) : sheet.key(event)
  })

  blockPointer(node)
  node.on("pointerdown", () => {
    if (intro?.isActive() === true) intro.progress(1)
  })

  /** The tether runs from the highlighted row's bar to the sheet's edge, where the notch sits. */
  const placeTether = () => {
    if (layout === null) return
    const row = menu.rect(menu.active)
    const start = layout.column.right - 0.1 * (layout.column.right - layout.column.left)
    tether.slot.position.set(Math.round(start), Math.round(layout.menu.y + row.y + row.height / 2))
    notch.x = Math.round(layout.sheet.x - start)
    reach = (layout.sheet.x - start) / 100
    if (panel !== null && panelMotion?.isActive() !== true) line.scale.x = reach
  }

  /** The keys' hints left to right along the foot, and its rule from the last one shown to the column's edge. */
  const arrangeFooter = () => {
    let x = 0
    const ends: Array<number> = []
    for (const each of [...hints, backHint]) {
      each.position.set(x, -Math.round(each.height / 2))
      x += Math.round(each.width)
      ends.push(x)
      x += 24
    }
    ruleFrom = { rest: (ends[1] ?? 0) + 24, panel: (ends[2] ?? 0) + 24 }
    const rule = ruleTo(panel !== null)
    footRule.visible = !narrow()
    footRule.position.set(rule.x, 0)
    footRule.scale.x = rule.scaleX
  }

  const enter = () => {
    leaving = false
    leave?.kill()
    intro?.kill()
    panelMotion?.kill()
    panel = null
    sheet.hide().progress(1)
    const bodies = [kicker.body, menuPiece.body, footer.body, sheetPiece.body, tether.body]
    gsap.killTweensOf([node, ...bodies, backHint, footRule, footRule.scale, line.scale, notch, notch.scale, ...column(), kickerMask.scale, kickerRule.scale, ...ticks.bodies, ...ticks.bodies.map((body) => body.scale)])
    for (const body of bodies) settle(body)
    tether.body.visible = false
    notch.visible = false
    for (const each of column()) each.alpha = 1
    backHint.alpha = 0
    arrangeFooter()
    wordmark.reset()
    menu.reset()
    kanji.mask = kickerMask
    kicker.body.addChild(kickerMask)
    node.visible = true
    node.alpha = 1
    node.eventMode = "static"
    sink.focus()
    undrain()

    // The menu is up within 0.6 s while the wordmark is still writing; any key or click finishes the intro at once and
    // still does what it does on the menu.
    const write = wordmark.write()
    const strike = 0.1 + write.duration() + 0.06
    intro = gsap.timeline()
      .add(ticks.pop(1.6, 0.5, drawn(0.5, "expo.out"), 0.06), 0.05)
      .add(write, 0.1)
      .add(menu.intro(), 0.25)
      .fromTo(kickerRule.scale, { x: 0 }, { x: 1, duration: 0.4, ease: "power3.out" }, 0.3)
      .fromTo(footer.body, { alpha: 0 }, { alpha: 1, duration: 0.4 }, 0.5)
      .add(wordmark.strike(), strike)
      .fromTo(kickerMask.scale, { x: 0 }, { x: 1, duration: 0.42, ease: drawn(0.42, "power2.out", ON_TWOS) }, strike + 0.1)
      .add(() => {
        kanji.mask = null
        kicker.body.removeChild(kickerMask)
      }, strike + 0.52)
  }

  const exit = () => {
    leaving = true
    sink.release()
    intro?.kill()
    panelMotion?.kill()
    node.eventMode = "none"
    undrain()
    tether.body.visible = false
    // The slash runs on its own, so a quick return to the title (quitting a run just started) can't strand it mid-cut.
    options.cut()
    leave?.kill()
    leave = gsap.timeline()
      .add(wordmark.cleave(), 0.15)
      .to([menuPiece.body, kicker.body], { x: -70, y: -30, alpha: 0, duration: 0.45, ease: "expo.out" }, 0.17)
      .to(sheetPiece.body, { x: "+=70", y: 30, alpha: 0, duration: 0.45, ease: "expo.out" }, 0.17)
      .to([footer.body, ...ticks.bodies], { alpha: 0, duration: 0.25 }, 0.17)
      .add(() => {
        node.visible = false
      }, 0.8)
  }

  return {
    node,
    ready: wordmark.ready,
    enter,
    exit,
    dispose: () => {
      for (const motion of [intro, leave, panelMotion, dimming]) motion?.kill()
      sink.dispose()
      node.destroy({ children: true, context: true })
      for (const entry of Object.values(entries)) entry.body.node.destroy({ children: true, context: true })
      release(kickerStyle)
    },
    layout: (viewport) => {
      const next = titleLayout(viewport, (letters) => letters / LETTER_ASPECT)
      layout = next
      const { width: W, height: H } = viewport
      screen = { width: W, height: H }
      node.hitArea = new Rectangle(0, 0, W, H)

      dim.clear().rect(0, 0, W, H).fill({ color: PALETTE.ink, alpha: DIM })
      const open = panel !== null
      const settled = panelMotion?.isActive() !== true

      ticks.place(next.frame.x, next.frame.y, next.frame.width, next.frame.height)
      wordmark.layout(next.wordmark.x, next.wordmark.y, next.wordmark.letterWidth, viewport.resolution)

      resize(kickerStyle, next.kicker.size, 0)
      kicker.slot.position.set(Math.round(next.kicker.x), Math.round(next.kicker.y))
      const ruleX = Math.round(kanji.width + 16)
      kickerRule.clear().rect(0, 0, Math.max(0, next.kicker.ruleTo - next.kicker.x - ruleX), 1).fill({ color: PALETTE.paper, alpha: 0.18 })
      kickerRule.position.set(ruleX, Math.round(kanji.height / 2))
      kickerMask.clear().rect(0, -4, kanji.width + 8, kanji.height + 8).fill(0xffffff)

      menu.layout(next.menu.look)
      menuPiece.slot.position.set(Math.round(next.menu.x), Math.round(next.menu.y))

      footer.slot.position.set(Math.round(next.footer.x), Math.round(next.footer.y))
      arrangeFooter()

      sheet.layout(next.sheet, next.content, viewport)
      placeTether()
      // Crossing the narrow width with a panel open: the column hides under a full-screen sheet and the tether shows
      // only beside a half-screen one.
      if (open && settled && !leaving) {
        for (const each of column()) each.alpha = next.narrow ? 0 : 1
        tether.body.visible = !next.narrow
        notch.visible = !next.narrow
      }
      if (next.narrow) tether.body.visible = false
    }
  }
}
