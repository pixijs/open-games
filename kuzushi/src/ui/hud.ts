import { gsap } from "gsap"
import { clamp } from "math"
import { spring } from "math/time"
import { Color, Container, FillGradient, Graphics, GraphicsContext, Rectangle, SmoothGraphics, Sprite, Texture } from "pixi.js"
import type { Text, TextDropShadow, TextStyle } from "pixi.js"

import { hex, PALETTE } from "../art/palette.ts"
import { svgTexture } from "../art/svg.ts"
import type { FrameTime } from "../host/types.ts"
import { ROOM_KINDS, zoneOf } from "../sim/index.ts"
import type { GameView } from "../sim/index.ts"
import { accentOf } from "./accent.ts"
import type { Accent } from "./accent.ts"
import { brushStroke, svgPaths } from "./brush.ts"
import { formatTime } from "./format.ts"
import { digits, placeDigits } from "./kit/digits.ts"
import { blurSprite } from "./kit/glow.ts"
import { fixedKeyBaseline, keycap } from "./kit/keycap.ts"
import { radialScrim } from "./kit/scrim.ts"
import { baselineOf, INK_SHADOW, lineBaseline, lineHeightOf, ownedFaces, paddingOf, placeInLine, resize, shadowOf, textIn } from "./kit/type.ts"
import type { Viewport } from "./kit/viewport.ts"
import { createWipe } from "./kit/wipe.ts"
import { createMinimap, MINIMAP_SIZE } from "./minimap.ts"
import { drawn, ON_ONES, rattle, shown } from "./motion.ts"
import type { Staged, Tinted } from "./screen.ts"
import { createWeaponHud } from "./weapon-hud.ts"

/** Seconds of game time a combo waits for its next hit. */
const COMBO_WINDOW = 2.4

/** The FOCUS bar's brush, in its 320x28 units, drawn at the bar's width in px. */
const BAR = { width: 320, height: 28 } as const
const bar = brushStroke([[1, 15], [110, 13], [220, 14.5], [316, 12.5]], { width: 15, seed: 81, start: 0.95, attack: 0.02, release: 0.1, dry: 0.34, bristles: 10, rough: 0.06, wobble: 0.1 })
/**
 * The bar rasterised by the browser at its size on screen: its shape in white (the track, the fill and the sheen's
 * mask) and its rim, an ink stroke kept outside the shape. Pixi's anti-aliasing would give each sub-pixel bristle of
 * the dry end a whole pixel, drawing the tail as a solid fan.
 */
const BAR_BOX = { x: -4, y: -4, width: BAR.width + 8, height: BAR.height + 8 } as const
const barSvg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BAR_BOX.x} ${BAR_BOX.y} ${BAR_BOX.width} ${BAR_BOX.height}">${body}</svg>`
const BAR_SHAPE = barSvg(`<path d="${bar.ink}" fill="#fff"/>`)
const BAR_RIM = barSvg(
  `<mask id="o" maskUnits="userSpaceOnUse" x="${BAR_BOX.x}" y="${BAR_BOX.y}" width="${BAR_BOX.width}" height="${BAR_BOX.height}">` +
  `<rect x="${BAR_BOX.x}" y="${BAR_BOX.y}" width="${BAR_BOX.width}" height="${BAR_BOX.height}" fill="#fff"/><path d="${bar.ink}"/></mask>` +
  `<path d="${bar.ink}" mask="url(#o)" fill="none" stroke="${hex(PALETTE.ink)}" stroke-opacity="0.7" stroke-width="3"/>`
)

/** A life's diamond and the shards it breaks into from the crack, in its 24-unit box drawn 22 px. */
const DIAMOND = [12, 1.5, 22.5, 12, 12, 22.5, 1.5, 12]
const CRACK = [12.8, 11.2] as const
const SHARDS = [
  [[12, 1.5], [22.5, 12], CRACK],
  [[22.5, 12], [17.25, 17.25], CRACK],
  [[17.25, 17.25], [12, 22.5], [1.5, 12], CRACK],
  [[1.5, 12], [6.75, 6.75], CRACK],
  [[6.75, 6.75], [12, 1.5], CRACK]
] as const

/** The corners' backings: ink at the corner, gone by the ellipse's edge. */
const SCRIM = [[0, PALETTE.ink, 0.84], [0.45, PALETTE.ink, 0.62], [0.78, PALETTE.ink, 0.2], [1, PALETTE.ink, 0]] as const

/** The HUD's grid, px: a life, the gaps between lives and between the vitals' rows, the FOCUS label's row, the room's line. */
const LIFE = 22
const LIFE_GAP = 10
const ROW_GAP = 10
const LABEL_ROW = 19
const WEAPON_GAP = 28
const ROOM_ROW = 19

const centroid = (points: ReadonlyArray<readonly [number, number]>): readonly [number, number] => {
  const sum = points.reduce(([sx, sy], [x, y]) => [sx + x, sy + y], [0, 0])
  return [sum[0] / points.length, sum[1] / points.length]
}

/** How far a text's shadow pushes its measured box past its last glyph. */
const shadowReach = (style: TextStyle) => {
  const shadow: TextDropShadow | null = style.dropShadow
  return shadow === null ? 0 : shadow.distance
}

/** Where a text's last glyph's advance ends, from its left: its width without its shadow. */
const advance = (text: Text) => text.width - shadowReach(text.style)

/** The trailing letter spacing kept inside a word's box. */
const trail = (text: Text) => text.style.letterSpacing

/** What the room line says of the room the hero is in: its kind (a cache by name), and whether its doors are sealed or its fight won. */
const roomStatus = (view: GameView): { readonly name: string; readonly status: "sealed" | "clear" | null } => {
  const room = view.room
  if (room === null) return { name: view.run.sandbox ? "Sandbox" : "", status: null }
  const kind = ROOM_KINDS[room.kind]
  const sealed = room.doors.some((door) => door.state === "locked")
  return { name: room.cache ? "Cache" : kind.name, status: sealed ? "sealed" : kind.fight && room.state === "cleared" ? "clear" : null }
}

export interface Hud extends Staged, Tinted {
  /** `held` hides the HUD for the special, the zone card and a boss's card, until they have played out. */
  update(view: GameView, frame: FrameTime, held: boolean): void
  show(on: boolean, delay?: number): void
  hit(): void
  hurt(): void
  reset(): void
  /** Screen boxes of its parts, [left, right, top, bottom], for layout checks. */
  rects(): Record<string, readonly [number, number, number, number]>
}

/**
 * The in-game HUD on an even grid: diamond lives and the brush FOCUS bar bottom-left with the weapon in hand beside
 * them; top right the minimap, the zone, the run timer and the room (its kind, sealed or clear, and its wave while
 * it has more than one); and a combo counter under them that pops on every hit. Ink scrims back both corners.
 */
export const createHud = (maxLives: number): Hud => {
  const node = new Container({ label: "hud" })
  node.visible = false
  node.alpha = 0
  let accent = accentOf("courtyard")

  const scrimLow = radialScrim(SCRIM, [0, 1])
  const scrimHigh = radialScrim(SCRIM, [1, 0])

  const minimap = createMinimap()
  const weapon = createWeaponHud(INK_SHADOW)
  const faces = ownedFaces()
  /** Paper words at .66: their colour fades, their shadow keeps its ink. */
  const dim = { color: PALETTE.paper, alpha: 0.66 }

  // Vitals, bottom-left: lives, the FOCUS bar and its label, then the weapon.
  const vitalsSlot = new Container({ label: "vitals" })
  const vitals = new Container()
  vitalsSlot.addChild(vitals)

  const livesNode = new Container({ label: "lives" })
  /** Shared by every life: its empty outline, its fill, and each shard's fill and accent edge. */
  const lifeContexts = {
    empty: new GraphicsContext().poly(DIAMOND).stroke({ width: 1.5, color: PALETTE.paper, alpha: 0.4 }),
    fill: new GraphicsContext().poly(DIAMOND).fill(PALETTE.paper).stroke({ width: 1.2, color: PALETTE.ink }),
    shards: SHARDS.map((points) => ({
      centre: centroid(points),
      fill: new GraphicsContext().poly(points.flat()).fill(PALETTE.paper),
      line: new GraphicsContext().poly(points.flat()).stroke({ width: 0.8, color: 0xffffff })
    }))
  }
  const lives = Array.from({ length: maxLives }, (_, index) => {
    const life = new Container({ label: `life ${index}` })
    life.pivot.set(LIFE / 2, LIFE / 2)
    life.position.set(index * (LIFE + LIFE_GAP) + LIFE / 2, LIFE / 2)
    const units = new Container()
    units.scale.set(LIFE / 24)
    const fill = new Container()
    fill.pivot.set(12, 12)
    fill.position.set(12, 12)
    /** The fill's soft paper glow: the diamond blurred. */
    const halo = blurSprite(`<path d="M${DIAMOND.join(" ")}Z"/>`, { x: -12, y: -12, width: 48, height: 48 }, 4, { width: 96, height: 96 }, "hud-life")
    halo.tint = PALETTE.paper
    halo.alpha = 0.5
    fill.addChild(halo, new SmoothGraphics(lifeContexts.fill))
    const shards = lifeContexts.shards.map(({ centre, fill: shape, line: edgeShape }) => {
      const shard = new Container()
      shard.pivot.set(...centre)
      shard.position.set(...centre)
      shard.alpha = 0
      const line = new SmoothGraphics(edgeShape)
      line.tint = accent.accent
      shard.addChild(new SmoothGraphics(shape), line)
      return { shard, line, centre }
    })
    units.addChild(new SmoothGraphics(lifeContexts.empty), fill, ...shards.map((each) => each.shard))
    life.addChild(units)
    livesNode.addChild(life)
    return { life, fill, shards }
  })
  livesNode.boundsArea = new Rectangle(0, 0, maxLives * (LIFE + LIFE_GAP) - LIFE_GAP, LIFE)

  const focusSlot = new Container({ label: "focus" })
  const focusBody = new Container()
  const focusClip = new Container()
  const focusWipe = createWipe("left")
  const glowUnits = new Container()
  const glowBox = { x: -24, y: -24, width: BAR.width + 48, height: BAR.height + 48 }
  const glow = blurSprite(svgPaths(bar.shapes), glowBox, 8, glowBox, "focus-bar")
  glow.alpha = 0.75
  glowUnits.addChild(glow)
  glowUnits.visible = false
  /** The bar's rasters, in its units: empty until they are drawn for the bar's size. */
  const barSprite = () => {
    const sprite = new Sprite(Texture.EMPTY)
    sprite.position.set(BAR_BOX.x, BAR_BOX.y)
    return sprite
  }
  const rim = barSprite()
  const track = barSprite()
  track.tint = PALETTE.paper
  track.alpha = 0.2
  const units = new Container()
  const fillClip = new Container()
  const fillMask = new Graphics().rect(0, -4, 1, 36).fill(0xffffff)
  fillMask.scale.x = 0
  const fillBar = barSprite()
  fillBar.tint = PALETTE.paper
  const sheenWrap = new Container()
  const sheenMask = barSprite()
  const sheenFill = new FillGradient({
    end: { x: 1, y: 0 },
    colorStops: [
      { offset: 0, color: new Color(0xffffff).setAlpha(0) },
      { offset: 0.5, color: new Color(0xffffff).setAlpha(0.95) },
      { offset: 1, color: new Color(0xffffff).setAlpha(0) }
    ]
  })
  const sheen = new Graphics().rect(0, -6, 70, 40).fill(sheenFill)
  sheen.skew.x = -0.419
  sheen.x = -90
  sheenWrap.addChild(sheen, sheenMask)
  sheenWrap.mask = sheenMask
  fillClip.addChild(fillBar, sheenWrap, fillMask)
  fillClip.mask = fillMask
  const edge = new Graphics().rect(-1, -12, 2, 24).fill(PALETTE.paper)
  edge.position.set(1, 14)
  edge.alpha = 0
  units.addChild(rim, track, fillClip, edge)
  focusClip.addChild(glowUnits, units, focusWipe.mask)
  focusClip.mask = focusWipe.mask
  focusBody.addChild(focusClip)
  focusSlot.addChild(focusBody)

  const labelRow = new Container({ label: "focus-label" })
  const focusWord = textIn("FOCUS", faces.style({ family: "condensed", weight: "500", size: 11, tracking: 0.46, shadow: INK_SHADOW }, dim), PALETTE.paper)
  const ready = new Container()
  ready.alpha = 0
  const readyText = textIn("KUZUSHI READY ", faces.style({ family: "condensed", weight: "500", size: 11, tracking: 0.3, shadow: INK_SHADOW }))
  const keys = [keycap("Q", { paint: "tinted", fixed: true }), keycap("L", { paint: "tinted", fixed: true })]
  const readyWipe = createWipe("left")
  ready.addChild(readyText, ...keys, readyWipe.mask)
  ready.mask = readyWipe.mask
  labelRow.addChild(focusWord, ready)
  vitals.addChild(livesNode, focusSlot, labelRow, weapon.node)

  // The run column, top right: minimap, zone, timer, rule and the room.
  const runSlot = new Container({ label: "run" })
  const run = new Container()
  runSlot.addChild(run)
  const zoneRow = new Container({ label: "run-zone" })
  const zoneWordStyle = faces.style({ family: "condensed", weight: "400", size: 20, tracking: 0.32, shadow: INK_SHADOW })
  const zoneWord = textIn("", zoneWordStyle, PALETTE.paper)
  const zoneKanjiStyle = faces.style({ family: "jp", size: 17, shadow: { color: accent.accent, alpha: 0.45, blur: 10 } }, accent.accent)
  const zoneKanji = textIn("", zoneKanjiStyle)
  const zoneWordBody = new Container()
  const zoneKanjiBody = new Container()
  zoneWordBody.addChild(zoneWord)
  zoneKanjiBody.addChild(zoneKanji)
  zoneRow.addChild(zoneWordBody, zoneKanjiBody)
  const nameBody = new Container({ label: "run-name" })
  const zoneName = textIn("", faces.style({ family: "text", weight: "400", size: 12.5, tracking: 0.02, shadow: INK_SHADOW }, dim), PALETTE.paper)
  nameBody.addChild(zoneName)
  const timeFace = { family: "condensed", weight: "300", size: 30, tracking: 0.06, shadow: INK_SHADOW } as const
  const time = digits(timeFace, PALETTE.paper)
  time.label = "run-time"
  time.text = formatTime(0)
  const rule = new Graphics({ label: "run-rule" }).rect(-56, 0, 56, 1).fill({ color: PALETTE.paper, alpha: 0.7 })

  const band = new Graphics()
  const bandFill = new FillGradient({
    end: { x: 1, y: 0 },
    colorStops: [
      { offset: 0, color: new Color(PALETTE.ink).setAlpha(0) },
      { offset: 0.34, color: new Color(PALETTE.ink).setAlpha(0.6) },
      { offset: 1, color: new Color(PALETTE.ink).setAlpha(0.6) }
    ]
  })
  band.rect(0, 0, 1, 1).fill(bandFill)
  const roomRow = new Container({ label: "run-room" })
  const roomStyle = faces.style({ family: "condensed", weight: "500", size: 12, tracking: 0.4, shadow: INK_SHADOW }, dim)
  const kindBody = new Container()
  const kind = textIn("", roomStyle, PALETTE.paper)
  kindBody.addChild(kind)
  const statusSlot = new Container()
  const statusBody = new Container()
  /** The tag's glow: its box blurred, kept outside the box. */
  const statusGlow = new Container()
  const statusHole = new Graphics()
  statusGlow.setMask({ mask: statusHole, inverse: true })
  const statusFill = new Graphics()
  const statusBorder = new Graphics()
  const status = textIn("", faces.style({ family: "condensed", weight: "600", size: 11, tracking: 0.34, shadow: INK_SHADOW }))
  statusBody.addChild(statusGlow, statusHole, statusFill, statusBorder, status)
  statusSlot.addChild(statusBody)
  statusSlot.visible = false
  const wave = new Container()
  wave.visible = false
  const waveWord = textIn("WAVE", roomStyle, PALETTE.paper)
  const waveNumStyle = faces.style({ family: "condensed", weight: "600", size: 16, shadow: INK_SHADOW })
  const waveNum = textIn("0", waveNumStyle, PALETTE.paper)
  const waveNumBody = new Container()
  waveNumBody.addChild(waveNum)
  const waveClip = new Container()
  const waveMask = new Graphics().rect(0, 0, 1, 1).fill(0xffffff)
  waveClip.addChild(waveNumBody, waveMask)
  waveClip.mask = waveMask
  const waveSlash = textIn("/", roomStyle, PALETTE.paper)
  const waveTotal = textIn("", roomStyle, PALETTE.paper)
  wave.addChild(waveWord, waveClip, waveSlash, waveTotal)
  roomRow.addChild(kindBody, statusSlot, wave)
  run.addChild(minimap.node, zoneRow, nameBody, time, rule, band, roomRow)

  // The combo, under the run column.
  const comboSlot = new Container({ label: "combo" })
  const combo = new Container()
  combo.alpha = 0
  comboSlot.addChild(combo)
  const countWrap = new Container()
  const countFace = { family: "condensed", weight: "700", italic: true, size: 64, tracking: 0.02 } as const
  const hardStyle = faces.style(countFace, PALETTE.ink)
  const countStyle = faces.style({ ...countFace, shadow: { color: PALETTE.ink, alpha: 0.6, blur: 18 } }, PALETTE.paper)
  const hard = textIn("0", hardStyle)
  const count = textIn("0", countStyle)
  countWrap.addChild(hard, count)
  const comboLabel = new Container()
  const dash = new Graphics().rect(0, -1, 18, 2).fill(0xffffff)
  const hits = textIn("HITS", faces.style({ family: "condensed", weight: "500", size: 12, tracking: 0.46, shadow: INK_SHADOW }), PALETTE.paper)
  comboLabel.addChild(dash, hits)
  const comboTimer = new Graphics().rect(-72, 0, 72, 2).fill({ color: PALETTE.paper, alpha: 0.7 })
  combo.addChild(countWrap, comboLabel, comboTimer)

  node.addChild(scrimLow.node, scrimHigh.node, vitalsSlot, runSlot, comboSlot)

  const focus = spring.create(0)
  /** What the room line's tag says. */
  let tag: "sealed" | "clear" | null = null
  /** The width the tag's glow was blurred for. */
  let tagWidth = 0
  const state = {
    visible: false,
    retreated: false,
    lives: -1,
    full: false,
    flash: false,
    focusTarget: 0,
    zone: "",
    room: "",
    wave: -1,
    waveOn: false,
    hasMap: false,
    timeLength: 0,
    combo: 0,
    comboLeft: 0,
    hot: false,
    broken: false
  }
  let viewport: Viewport | null = null
  let bodyWidth = 320

  let strobe: gsap.core.Timeline | null = null
  const sheenLoop = gsap.timeline({ repeat: -1, repeatDelay: 1.6, paused: true })
    .fromTo(sheen, { x: -90 }, { x: BAR.width + 60, duration: 0.9, ease: "power2.inOut" })

  const narrow = () => viewport?.narrow === true

  let rastered = ""
  /** Draws the bar's rasters at `scale` px a unit, once per size and resolution; the last asked for wins. */
  const rasterise = (scale: number, resolution: number) => {
    const key = `${scale}:${resolution}`
    if (key === rastered) return
    rastered = key
    const pixels = { width: BAR_BOX.width * scale * resolution, height: BAR_BOX.height * scale * resolution }
    void Promise.all([svgTexture(BAR_SHAPE, { ...pixels, label: "focus-bar" }), svgTexture(BAR_RIM, { ...pixels, label: "focus-rim" })]).then(([shape, edge]) => {
      if (key !== rastered || node.destroyed) {
        shape.destroy(true)
        edge.destroy(true)
        return
      }
      const old = new Set([track.texture, rim.texture])
      for (const sprite of [track, fillBar, sheenMask]) sprite.texture = shape
      rim.texture = edge
      for (const sprite of [rim, track, fillBar, sheenMask]) sprite.setSize(BAR_BOX.width, BAR_BOX.height)
      for (const texture of old) if (texture !== Texture.EMPTY) texture.destroy(true)
    })
  }

  /** The vitals from their bottom-left: the body's rows stacked up from the foot, the weapon beside them. */
  const arrangeVitals = () => {
    if (viewport === null) return
    const { width: W, height: H, margin: m } = viewport
    bodyWidth = narrow() ? Math.min(0.52 * W, 220) : clamp(0.19 * W, 200, 320)
    const barHeight = (bodyWidth * BAR.height) / BAR.width
    const bodyHeight = LIFE + ROW_GAP + barHeight + ROW_GAP + LABEL_ROW
    vitalsSlot.position.set(Math.round(m), Math.round(H - m))
    livesNode.y = Math.round(-bodyHeight)
    focusSlot.y = Math.round(-bodyHeight + LIFE + ROW_GAP)
    const scale = bodyWidth / BAR.width
    for (const each of [glowUnits, units]) each.scale.set(scale)
    rasterise(scale, viewport.resolution)
    focusBody.pivot.set(0, barHeight / 2)
    focusBody.position.set(0, barHeight / 2)
    focusWipe.fit(new Rectangle(0, 0, bodyWidth, barHeight))

    labelRow.y = -LABEL_ROW
    placeInLine(focusWord, 0, 0, LABEL_ROW)
    let x = bodyWidth
    for (const key of keys.toReversed()) {
      x -= key.width
      key.position.set(Math.round(x), 0)
      x -= 6
    }
    // The keys set the line, so the words sit on their letters' baseline.
    readyText.position.set(Math.round(x - trail(readyText) - advance(readyText)), Math.round(fixedKeyBaseline() - baselineOf(readyText.style)))
    readyWipe.fit(new Rectangle(readyText.x, 0, bodyWidth - readyText.x, LABEL_ROW))
    labelRow.boundsArea = new Rectangle(0, 0, bodyWidth, LABEL_ROW)

    const size = weapon.layout(narrow())
    weapon.node.position.set(Math.round(bodyWidth + WEAPON_GAP), -size.height)
    weapon.node.boundsArea = new Rectangle(0, 0, size.width, size.height - 3)
  }

  /** The room line from its right edge: kind, the status tag, the wave, each 10 apart; the last one's tracking hangs off the edge. */
  const arrangeRoom = () => {
    let right = 0
    if (state.waveOn) {
      waveTotal.x = Math.round(-advance(waveTotal))
      const slashBox = advance(waveSlash) + trail(waveSlash) + (8 - trail(waveSlash))
      waveSlash.x = Math.round(waveTotal.x - slashBox)
      const numWidth = advance(waveNum)
      const numBox = { x: waveSlash.x - 8 - numWidth, height: 1.1 * Number(waveNumStyle.fontSize) }
      waveWord.x = Math.round(numBox.x - 8 - trail(waveWord) - advance(waveWord))
      const smallAbove = lineBaseline(roomStyle)
      const numAbove = lineBaseline(waveNumStyle, numBox.height)
      const above = Math.max(smallAbove, numAbove)
      const below = Math.max(lineHeightOf(roomStyle) - smallAbove, numBox.height - numAbove)
      const top = (ROOM_ROW - above - below) / 2
      for (const each of [waveWord, waveSlash, waveTotal]) placeInLine(each, each.x, top + above - smallAbove)
      const boxTop = top + above - numAbove
      waveClip.position.set(Math.round(numBox.x), Math.round(boxTop))
      placeInLine(waveNum, 0, 0, numBox.height)
      waveMask.scale.set(Math.ceil(numWidth + 1), Math.ceil(numBox.height))
      right = waveWord.x - 10
    }
    if (tag !== null) {
      const width = 1 + 8 + advance(status) + trail(status) + 5 + 1
      const height = 18
      const left = Math.round(right - width)
      statusSlot.position.set(left, 0.5)
      statusBody.pivot.set(width / 2, height / 2)
      statusBody.position.set(width / 2, height / 2)
      placeInLine(status, 9, 4, 11)
      statusFill.clear().rect(0, 0, width, height).fill({ color: 0xffffff, alpha: 0.12 })
      statusHole.clear().rect(0, 0, width, height).fill(0xffffff)
      statusBorder.clear().rect(0, 0, width, height).stroke({ width: 1, color: 0xffffff, alignment: 1 })
      if (Math.round(width) !== tagWidth) {
        tagWidth = Math.round(width)
        for (const old of statusGlow.removeChildren()) old.destroy()
        const box = { x: -12, y: -12, width: tagWidth + 24, height: height + 24 }
        const halo = blurSprite(`<rect width="${tagWidth}" height="${height}"/>`, box, 5, { width: 2 * box.width, height: 2 * box.height }, `hud-tag ${tagWidth}`)
        halo.alpha = 0.3
        statusGlow.addChild(halo)
      }
      right = left - 10
    }
    kind.x = Math.round(right - trail(kind) - advance(kind))
    placeInLine(kind, kind.x, 0, ROOM_ROW)
    const left = Math.min(kind.x, statusSlot.visible ? statusSlot.x : 0, state.waveOn ? waveWord.x : 0)
    roomRow.boundsArea = new Rectangle(left, 0, -left, ROOM_ROW)
    band.position.set(roomRow.x + left - 28, roomRow.y - 7)
    band.scale.set(18 - (left - 28), ROOM_ROW + 14)
    paintStatus()
  }

  const paintStatus = () => {
    const sealed = tag === "sealed"
    const colour = sealed ? accent.accent : PALETTE.paper
    status.tint = colour
    statusFill.visible = sealed
    statusFill.tint = accent.accent
    statusGlow.visible = sealed
    statusGlow.tint = accent.accent
    statusBorder.tint = colour
    statusBorder.alpha = sealed ? 0.8 : 0.5
  }

  /** The run column from its top-right: each row's right edge on the margin, the last glyph's tracking hanging past it. */
  const arrangeRun = () => {
    if (viewport === null) return
    const { width: W, margin: m } = viewport
    runSlot.position.set(Math.round(W - m), Math.round(m))
    let y = 0
    if (state.hasMap) {
      minimap.node.position.set(-MINIMAP_SIZE.width, 0)
      y += MINIMAP_SIZE.height + 16
    }
    resize(zoneWordStyle, narrow() ? 15 : 20, 0.32)
    const wordLine = Number(zoneWordStyle.fontSize)
    const wordAbove = lineBaseline(zoneWordStyle, wordLine)
    const kanjiAbove = lineBaseline(zoneKanjiStyle, 17)
    const above = Math.max(wordAbove, kanjiAbove)
    const rowHeight = above + Math.max(wordLine - wordAbove, 17 - kanjiAbove)
    placeInLine(zoneKanji, -advance(zoneKanji), y + above - kanjiAbove, 17)
    placeInLine(zoneWord, zoneKanji.x - 12 - advance(zoneWord), y + above - wordAbove, wordLine)
    y += rowHeight
    nameBody.visible = !narrow()
    if (!narrow()) {
      y += 6
      placeInLine(zoneName, -advance(zoneName), y)
      y += lineHeightOf(zoneName.style)
    }
    y += 12
    const timeSize = narrow() ? 22 : 30
    time.style.fontSize = timeSize
    time.style.letterSpacing = timeSize * timeFace.tracking
    placeDigits(time, time.style.letterSpacing - time.width, y, timeSize)
    state.timeLength = time.text.length
    y += timeSize + 10
    rule.y = Math.round(y)
    y += 1 + 10
    roomRow.position.set(0, Math.round(y))
    arrangeRoom()
  }

  const arrangeCombo = () => {
    if (viewport === null) return
    const { width: W, margin: m } = viewport
    comboSlot.position.set(Math.round(W - m), Math.round(m + (narrow() ? 210 : 262)))
    const size = narrow() ? 44 : 64
    resize(countStyle, size, 0.02)
    resize(hardStyle, size, 0.02)
    const box = 0.9 * size
    countWrap.position.set(0, box)
    placeCount()
    const labelTop = box + 10
    const labelHeight = lineHeightOf(hits.style)
    placeInLine(hits, -advance(hits), labelTop)
    dash.position.set(Math.round(hits.x - 8 - 18), Math.round(labelTop + labelHeight / 2))
    comboTimer.y = Math.round(labelTop + labelHeight + 8)
  }

  /** The count's last glyph sits inside its box's right edge by its tracking; the box's bottom-right is the pivot. */
  const placeCount = () => {
    const box = 0.9 * Number(countStyle.fontSize)
    placeInLine(count, -trail(count) - advance(count), -box, box)
    hard.position.set(count.x, count.y + 3)
  }

  /** The count's colours: paper with an ink glow; hot, an accent edge and glow over accent-deep; broken, the accent. */
  const paintCount = () => {
    countStyle.fill = state.broken ? accent.accent : PALETTE.paper
    countStyle.stroke = state.hot ? { color: accent.accent, width: 1 } : { color: 0xffffff, width: 0 }
    countStyle.dropShadow = shadowOf(state.hot ? { color: accent.accent, alpha: 0.7, blur: 22 } : { color: PALETTE.ink, alpha: 0.6, blur: 18 })
    countStyle.padding = paddingOf(countStyle)
    hardStyle.fill = state.hot ? accent.deep : PALETTE.ink
    hits.tint = state.hot ? accent.accent : PALETTE.paper
  }

  const shatter = (index: number) => {
    const life = lives[index]
    if (life === undefined) return
    life.fill.visible = false
    gsap.killTweensOf(life.shards.flatMap(({ shard }) => [shard, shard.scale]))
    for (const { shard, centre: [cx, cy] } of life.shards) {
      const angle = Math.atan2(cy - CRACK[1], cx - CRACK[0]) + gsap.utils.random(-0.4, 0.4)
      const reach = gsap.utils.random(18, 34)
      gsap.timeline()
        .set(shard, { alpha: 1, x: cx, y: cy, angle: 0 })
        .set(shard.scale, { x: 1, y: 1 })
        .to(shard, { x: cx + Math.cos(angle) * reach, duration: 0.55, ease: drawn(0.55, "power2.out") }, 0)
        .to(shard, { y: cy + Math.sin(angle) * reach - 10, duration: 0.25, ease: drawn(0.25, "power2.out") }, 0)
        .to(shard, { y: cy + Math.sin(angle) * reach + 26, duration: 0.3, ease: drawn(0.3, "power2.in") }, 0.25)
        .to(shard, { angle: gsap.utils.random(-260, 260), duration: 0.55, ease: drawn(0.55, "none") }, 0)
        .to(shard.scale, { x: 0.4, y: 0.4, duration: 0.55, ease: drawn(0.55, "none") }, 0)
        .to(shard, { alpha: 0, duration: 0.2, ease: drawn(0.2, "none") }, 0.38)
    }
    gsap.fromTo(life.life.scale, { x: 1.6, y: 1.6 }, { x: 1, y: 1, duration: 0.35, ease: drawn(0.35, "back.out(3)") })
    rattle(vitals, 6, 0.35)
  }

  const refill = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const life = lives[i]
      if (life === undefined) continue
      life.fill.visible = true
      gsap.fromTo(life.fill.scale, { x: 0, y: 0 }, { x: 1, y: 1, duration: 0.3, ease: drawn(0.3, "back.out(3)"), delay: (i - from) * 0.07 })
    }
  }

  const flash = (on: boolean) => {
    state.flash = on
    fillBar.tint = on ? accent.accent : PALETTE.paper
  }

  const setFull = (full: boolean) => {
    if (full === state.full) return
    state.full = full
    glowUnits.visible = full
    strobe?.kill()
    strobe = null
    gsap.killTweensOf([ready, readyWipe])
    if (full) {
      strobe = gsap.timeline({ repeat: -1 })
        .call(flash, [true], 0)
        .call(flash, [false], 0.25)
        .call(flash, [true], 0.5)
        .call(flash, [false], 0.58)
        .set({}, {}, 0.9)
      gsap.fromTo(ready, { alpha: 0, x: -14 }, { alpha: 1, x: 0, duration: 0.3, ease: drawn(0.3, "power3.out") })
      gsap.fromTo(readyWipe, { amount: 0 }, { amount: 1, duration: 0.3, ease: drawn(0.3, "power3.out") })
      gsap.fromTo(focusBody.scale, { y: 2.2 }, { y: 1, duration: 0.4, ease: drawn(0.4, "elastic.out(1, 0.5)") })
    } else {
      flash(false)
      gsap.to(ready, { alpha: 0, duration: 0.2 })
    }
  }

  const gain = () => {
    gsap.fromTo(edge, { alpha: 1 }, { alpha: 0, duration: 0.35, ease: drawn(0.35, "power2.out") })
    gsap.fromTo(edge.scale, { y: 1.6 }, { y: 1, duration: 0.35, ease: drawn(0.35, "power2.out") })
    sheenLoop.restart()
  }

  const dropCombo = (broken: boolean) => {
    if (state.combo === 0) return
    state.combo = 0
    gsap.killTweensOf([combo, countWrap, countWrap.scale])
    state.broken = broken
    paintCount()
    gsap.timeline()
      .add(broken ? rattle(combo, 8, 0.3) : gsap.timeline())
      .to(combo, { alpha: 0, x: 30, duration: 0.3, ease: "power2.in" })
  }

  const update = (view: GameView, frame: FrameTime, held: boolean) => {
    if (view.lives !== state.lives) {
      if (state.lives >= 0 && view.lives < state.lives) for (let i = view.lives; i < state.lives; i++) shatter(i)
      else refill(Math.max(0, state.lives), view.lives)
      lives.forEach((life, i) => {
        life.fill.visible = i < view.lives
      })
      state.lives = view.lives
    }

    if (view.focus > state.focusTarget + 0.001) gain()
    state.focusTarget = view.focus
    spring.damp(focus, view.focus, 0.12, frame.dt)
    const width = clamp(focus.value, 0, 1) * BAR.width
    fillMask.scale.x = width
    edge.x = Math.max(0, width - 1) + 1
    setFull(view.focusFull)

    time.text = formatTime(view.timer)
    if (time.text.length !== state.timeLength) arrangeRun()
    const hasMap = view.map !== null
    if (hasMap !== state.hasMap) {
      state.hasMap = hasMap
      arrangeRun()
    }
    if (view.zone !== state.zone) {
      const zone = zoneOf(view.zone)
      zoneWord.text = `ZONE ${zone.number}`
      zoneKanji.text = zone.kanji
      zoneName.text = zone.name
      arrangeRun()
      if (state.zone !== "") gsap.fromTo([zoneWordBody, zoneKanjiBody, nameBody], { alpha: 0, x: 16 }, { alpha: 1, x: 0, duration: 0.4, ease: drawn(0.4, "expo.out"), stagger: 0.06 })
      state.zone = view.zone
    }
    minimap.update(view)
    if (weapon.update(view.weapon)) arrangeVitals()

    const room = roomStatus(view)
    const roomKey = `${view.room?.index ?? -1}|${room.name}|${room.status ?? ""}`
    if (roomKey !== state.room) {
      const sameRoom = state.room.split("|")[0] === roomKey.split("|")[0]
      kind.text = room.name.toUpperCase()
      status.text = room.status === "sealed" ? "SEALED" : room.status === "clear" ? "CLEAR" : ""
      tag = room.status
      statusSlot.visible = room.status !== null
      arrangeRoom()
      if (sameRoom && room.status !== null) {
        gsap.fromTo(statusBody.scale, { x: 1.8, y: 1.8 }, { x: 1, y: 1, duration: 0.2, ease: drawn(0.2, "power4.in", ON_ONES) })
        gsap.fromTo(statusBody, { alpha: 0 }, { alpha: 1, duration: 0.2, ease: drawn(0.2, "power4.in", ON_ONES) })
        rattle(run, room.status === "sealed" ? 5 : 3, 0.3)
      } else if (state.room !== "") gsap.fromTo(kindBody, { alpha: 0, x: 12 }, { alpha: 1, x: 0, duration: 0.3, ease: drawn(0.3, "expo.out") })
      state.room = roomKey
    }

    const fighting = room.status === "sealed" && view.wave.total > 1 && view.wave.index > 0
    const index = fighting ? view.wave.index : 0
    if (fighting !== state.waveOn || index !== state.wave) {
      state.waveOn = fighting
      wave.visible = fighting
      waveNum.text = String(index)
      waveTotal.text = String(view.wave.total)
      arrangeRoom()
      if (index !== state.wave && state.wave > 0 && index > 0) {
        gsap.fromTo(waveNumBody, { y: waveMask.scale.y, alpha: 0 }, { y: 0, alpha: 1, duration: 0.3, ease: drawn(0.3, "back.out(2)") })
      }
      state.wave = index
    }

    if (state.combo > 0) {
      state.comboLeft -= frame.gameDt
      comboTimer.scale.x = Math.max(0, state.comboLeft / COMBO_WINDOW)
      if (state.comboLeft <= 0) dropCombo(false)
    }

    if (held !== state.retreated && state.visible) {
      state.retreated = held
      gsap.to([vitals, run], { alpha: held ? 0 : 1, duration: held ? 0.12 : 0.4, overwrite: "auto" })
      gsap.to(combo, { alpha: !held && state.combo >= 2 ? 1 : 0, duration: held ? 0.12 : 0.4, overwrite: "auto" })
    }
  }

  const tint = (next: Accent) => {
    accent = next
    for (const life of lives) for (const { line } of life.shards) line.tint = next.accent
    if (state.flash) fillBar.tint = next.accent
    glow.tint = next.accent
    readyText.tint = next.accent
    for (const key of keys) key.tint = next.accent
    zoneKanjiStyle.fill = next.accent
    zoneKanjiStyle.dropShadow = shadowOf({ color: next.accent, alpha: 0.45, blur: 10 })
    dash.tint = next.accent
    paintStatus()
    paintCount()
    minimap.tint(next)
    weapon.tint(next)
  }
  tint(accent)

  return {
    node,
    update,
    tint,
    show: (on, delay = 0) => {
      if (on === state.visible) return
      state.visible = on
      state.retreated = false
      const lifeNodes = lives.map((each) => each.life)
      gsap.killTweensOf([node, vitals, run, focusWipe, ...lifeNodes, ...lifeNodes.map((each) => each.scale)])
      if (on) {
        sheenLoop.play(0)
        node.visible = true
        node.alpha = 1
        gsap.timeline({ delay })
          .fromTo(vitals, { alpha: 0, x: -40 }, { alpha: 1, x: 0, duration: 0.5, ease: "expo.out" }, 0)
          .fromTo(lifeNodes, { alpha: 0 }, { alpha: 1, duration: 0.3, ease: drawn(0.3, "back.out(3)"), stagger: 0.06 }, 0.05)
          .fromTo(lifeNodes.map((each) => each.scale), { x: 0.2, y: 0.2 }, { x: 1, y: 1, duration: 0.3, ease: drawn(0.3, "back.out(3)"), stagger: 0.06 }, 0.05)
          .fromTo(focusWipe, { amount: 0 }, { amount: 1, duration: 0.4, ease: drawn(0.4, "power3.out", ON_ONES) }, 0.15)
          .fromTo(run, { alpha: 0, x: 40 }, { alpha: 1, x: 0, duration: 0.5, ease: "expo.out" }, 0.05)
      } else {
        sheenLoop.pause()
        shown(node, false, 0.25)
      }
    },
    hit: () => {
      state.combo += 1
      state.comboLeft = COMBO_WINDOW
      count.text = String(state.combo)
      hard.text = count.text
      placeCount()
      if (state.combo < 2) return
      const hot = state.combo >= 10
      if (hot !== state.hot || state.broken) {
        state.hot = hot
        state.broken = false
        paintCount()
      }
      gsap.killTweensOf([combo, countWrap, countWrap.scale, comboLabel])
      combo.alpha = state.retreated ? 0 : 1
      combo.x = 0
      gsap.fromTo(countWrap.scale, { x: 1.55, y: 1.55 }, { x: 1, y: 1, duration: 0.28, ease: drawn(0.28, "back.out(3)", ON_ONES) })
      gsap.fromTo(countWrap, { angle: -7 }, { angle: 0, duration: 0.28, ease: drawn(0.28, "back.out(3)", ON_ONES) })
      gsap.fromTo(comboLabel, { x: 10 }, { x: 0, duration: 0.2, ease: drawn(0.2, "power3.out") })
    },
    hurt: () => dropCombo(true),
    reset: () => {
      state.combo = 0
      state.wave = -1
      state.room = ""
      minimap.reset()
      weapon.reset()
      gsap.killTweensOf(combo)
      combo.alpha = 0
    },
    layout: (next) => {
      viewport = next
      const { width: W, height: H } = next
      scrimLow.fit(new Rectangle(0, H - 260, 600, 260), [600, 260])
      scrimHigh.fit(new Rectangle(W - 560, 0, 560, 440), [560, 440])
      arrangeVitals()
      arrangeRun()
      arrangeCombo()
    },
    rects: () => {
      const parts = [minimap.node, zoneRow, nameBody, time, rule, roomRow, livesNode, focusSlot, labelRow, weapon.node]
      return Object.fromEntries(parts.map((part) => {
        const box = part.getBounds()
        return [part.label, [Math.round(box.minX), Math.round(box.maxX), Math.round(box.minY), Math.round(box.maxY)] as const]
      }))
    },
    dispose: () => {
      sheenLoop.kill()
      strobe?.kill()
      gsap.killTweensOf([node, vitals, run, combo, countWrap, countWrap.scale, comboLabel, ready, readyWipe, focusWipe, focusBody.scale, edge, edge.scale, kindBody, statusBody, statusBody.scale, waveNumBody, zoneWordBody, zoneKanjiBody, nameBody])
      for (const life of lives) gsap.killTweensOf([life.life.scale, life.fill.scale, ...life.shards.flatMap(({ shard }) => [shard, shard.scale])])
      minimap.dispose()
      weapon.dispose()
      const rasters = new Set([track.texture, rim.texture])
      node.destroy({ children: true })
      for (const each of [lifeContexts.empty, lifeContexts.fill, ...lifeContexts.shards.flatMap((shard) => [shard.fill, shard.line])]) each.destroy()
      sheenFill.destroy()
      for (const texture of rasters) if (texture !== Texture.EMPTY) texture.destroy(true)
      bandFill.destroy()
      faces.release()
    }
  }
}
