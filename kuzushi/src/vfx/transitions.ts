import { Container, Graphics, Sprite, TilingSprite } from "pixi.js"
import type { Texture } from "pixi.js"

import { paletteOf } from "../art/palette.ts"
import { svgTextures } from "../art/svg.ts"
import type { FrameTime } from "../host/types.ts"
import { TRANSITION } from "../sim/index.ts"
import type { Side, TransitionView } from "../sim/index.ts"
import { SCREEN_TWOS } from "./cues.ts"
import { EDGE_SIZE, heroDartSvg, HERO_SIZE, inkMottleSvg, STREAK_SIZE, speedStreakSvg, wipeEdgeSvg } from "./draw/transitions.ts"
import { drawnAt, spread } from "./fx.ts"
import type { Fx } from "./fx.ts"

/**
 * The transitions between rooms and zones (docs/DESIGN.md, Transitions), drawn flat over the frame:
 *
 * - Through a door: the hero smears into the doorway with speed lines and afterimages; an ink wipe sweeps across the
 *   screen the way the hero travels, its dry-brush front boiling on twos, speed lines streaking across the ink, the
 *   hero held over it as a white drawing; the next room is built under full ink; the wipe runs off the far side, the
 *   new room inking in behind it as outlines for two drawings before it fills. Through the hold the held drawing bursts
 *   on along the travel, off the far edge and in from the near one, and settles where the hero now stands under the cut
 *   camera, its afterimages closing on it; it stays there over the hero until the ink's tail uncovers the hero, who
 *   comes in with afterimages.
 * - Into the next zone: the hero smears into the gate's glare as the frame washes toward paper white; the hero's
 *   drawing, ink rim and all, and its afterimages are held over the wash, focus lines closing on it, so the dive reads;
 *   the UI's ink sheet (src/ui/zone-card.ts) covers the frame from there through the card and lifts off the top, so
 *   the band draws only the exit's speed lines; the new zone's first room inks in under it as outlines, as through a door.
 *
 * The wipe moves in drawings at 20 a second, the edge and the speed lines change on twos.
 */

const WIPE_DRAWINGS = 20
/** How wide the wipe's front is on screen, as a share of the frame's shorter side. */
const EDGE_SHARE = 0.34
/** The solid share of the edge drawing, where it overlaps the band of ink. */
const EDGE_BODY = 96 / EDGE_SIZE.width
const STREAKS = 30
/** How far the frame washes toward paper white as the hero dives into the zone gate. */
const ZONE_WASH = 0.55
/** The hero drawing's length: the dart in its drawing spans 100 of 256, about 1.15 units of the hero. */
const HERO_UNITS = (HERO_SIZE / 100) * 1.15
/** The focus lines' least size, as a share of the frame's diagonal: how far from the hero their inner ends start. */
const FOCUS_SPAN = 1.4
/** Room past the frame's farthest corner for the hero to move on before the focus lines' next drawing. */
const FOCUS_ROOM = 1.15

/** The screen angle of travel through a side: up the screen is north. */
const SCREEN_ANGLE: Readonly<Record<Side, number>> = { north: -Math.PI / 2, east: 0, south: Math.PI / 2, west: Math.PI }

const easeIn = (t: number) => Math.pow(t, 1.7)
const easeOut = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t)
/**
 * The held drawing's afterimages through the hold: how far behind it each trails (share of the hold, so they close on
 * it as it settles) and how bright.
 */
const GHOSTS = [{ behind: 0.07, alpha: 0.5 }, { behind: 0.14, alpha: 0.32 }, { behind: 0.22, alpha: 0.18 }] as const
/** How far through the hold's run the held drawing, `progress` through the hold: off at speed, settling where the hero stands. */
const runShare = (progress: number) => easeOut(Math.min(1, (progress * TRANSITION.door.hold) / (TRANSITION.door.hold - 1)))
/**
 * How far through its run the held drawing has as good as landed. Focus lines close only on a drawing at rest: round
 * one still running they would swing across the frame with it, a whole side of the frame wide when it runs sideways.
 */
const LANDED = 0.9
/** Each beat's length in steps; a door has no card and a zone change no hold. */
const ZONE_BEATS = { ...TRANSITION.zone, hold: 0 }
const DOOR_BEATS = { ...TRANSITION.door, card: 0 }
const stepped = (t: number, seconds: number) => {
  const drawings = Math.max(1, Math.round(seconds * WIPE_DRAWINGS))
  return Math.min(1, Math.ceil(t * drawings) / drawings)
}

interface Streak {
  readonly sprite: Sprite
  u: number
  v: number
  length: number
  alpha: number
}

export interface Transitions {
  update(time: FrameTime): void
  clear(): void
  dispose(): void
}

export const installTransitions = async (fx: Fx): Promise<Transitions> => {
  const textures = await svgTextures({
    edge0: [wipeEdgeSvg(11), { ...EDGE_SIZE, label: "vfx-wipe-edge0" }],
    edge1: [wipeEdgeSvg(29), { ...EDGE_SIZE, label: "vfx-wipe-edge1" }],
    edge2: [wipeEdgeSvg(47), { ...EDGE_SIZE, label: "vfx-wipe-edge2" }],
    streak: [speedStreakSvg(), { ...STREAK_SIZE, label: "vfx-wipe-streak" }],
    hero: [heroDartSvg(), { width: HERO_SIZE, label: "vfx-wipe-hero" }],
    mottle: [inkMottleSvg(), { width: 512, repeat: true, label: "vfx-wipe-mottle" }]
  })
  const edges: ReadonlyArray<Texture> = [textures.edge0, textures.edge1, textures.edge2]
  const { context } = fx
  const root = new Container({ label: "vfx-transition", visible: false })
  const band = new Container({ label: "wipe" })
  const ink = new Graphics()
  const lead = new Sprite({ texture: textures.edge0, anchor: { x: 0, y: 0.5 } })
  const trail = new Sprite({ texture: textures.edge1, anchor: { x: 0, y: 0.5 } })
  const mottle = new TilingSprite({ texture: textures.mottle, width: 64, height: 64, alpha: 0 })
  const streaks: Array<Streak> = Array.from({ length: STREAKS }, () => ({ sprite: new Sprite({ texture: textures.streak, anchor: { x: 1, y: 0.5 } }), u: 0, v: 0, length: 0, alpha: 0 }))
  const hero = new Sprite({ texture: textures.hero, anchor: 0.5, visible: false })
  const twin = new Sprite({ texture: textures.hero, anchor: 0.5, visible: false })
  const ghosts = GHOSTS.map(() => new Sprite({ texture: textures.hero, anchor: 0.5, visible: false }))
  const focus = new Sprite({ texture: fx.kit.focusLines[0], anchor: 0.5, visible: false })
  band.addChild(ink, mottle, lead, trail, ...streaks.map((streak) => streak.sprite))
  root.addChild(band, focus, ...ghosts, twin, hero)
  context.layers.screen.addChild(root)

  let held: { x: number; y: number; size: number } | null = null
  let ghostCarry = 0
  let last: { x: number; z: number } | null = null
  let drawing = -1
  let framed = false

  const offs = [
    context.moments.on("transitionStarted", (started) => {
      held = null
      ghostCarry = 0.5
      last = { x: started.x, z: started.z }
      context.rig.punch(started.kind === "zone" ? 6 : 4)
      context.rig.shake(0.05, { dirX: Math.cos(SCREEN_ANGLE[started.side]), dirZ: Math.sin(SCREEN_ANGLE[started.side]), shape: "recoil", duration: 0.2 })
    }),
    context.moments.on("roomSwapped", () => {
      last = null
    })
  ]

  /** Where the hero is on screen and how many pixels a unit is there. */
  const heroOnScreen = () => {
    const player = context.game.view().player
    if (player === null) return null
    const { x, z } = drawnAt(fx, player.id, player)
    const at = context.view.worldToScreen({ x, y: 0.4, z })
    const beside = context.view.worldToScreen({ x: x + 1, y: 0.4, z })
    if (at === null || beside === null) return null
    return { x: at.x, y: at.y, size: Math.hypot(beside.x - at.x, beside.y - at.y) * HERO_UNITS, worldX: x, worldZ: z }
  }

  /** Afterimages and speed lines left along the hero's path, the way a dash leaves them. */
  const smear = (angle: number) => {
    const now = heroOnScreen()
    if (now === null) return
    const from = last ?? { x: now.worldX, z: now.worldZ }
    const step = Math.hypot(now.worldX - from.x, now.worldZ - from.z)
    last = { x: now.worldX, z: now.worldZ }
    if (step < 0.001 || step > 6) return
    const dirX = (now.worldX - from.x) / step
    const dirZ = (now.worldZ - from.z) / step
    let along = 0.9 - ghostCarry
    for (; along <= step; along += 0.9) {
      const x = from.x + dirX * along
      const z = from.z + dirZ * along
      fx.layers.flat.spawn({ frames: fx.f.ghost, x, y: 0.32, z, size: 1.6, rotation: angle, life: 0.3, alpha: 0.9, alphaEnd: 0, clock: "real" })
      const side = spread(fx.rng, 0.5)
      fx.layers.flat.spawn({ frames: fx.f.speedline, x: x - dirX * 1.1 - dirZ * side, y: 0.36, z: z - dirZ * 1.1 + dirX * side, vx: dirX * 3, vz: dirZ * 3, rotation: angle, size: 3.4 + fx.rng() * 1.6, sizeEnd: 2, life: 0.24, hold: 0.3, alphaEnd: 0, clock: "real" })
    }
    ghostCarry = step - (along - 0.9)
  }

  const layoutBand = (angle: number) => {
    const { width, height } = context.app.screen
    band.position.set(width / 2, height / 2)
    band.rotation = angle
    const reach = (width * Math.abs(Math.cos(angle)) + height * Math.abs(Math.sin(angle))) / 2
    const across = Math.hypot(width, height) / 2 + 40
    const edge = Math.min(width, height) * EDGE_SHARE
    return { reach, across, edge }
  }

  /** Lays the band of ink from `from` to `to` along the travel, with a boiling front at `to` and a tail at `from`. */
  const drawBand = (from: number, to: number, across: number, edge: number, color: number) => {
    ink.clear()
    if (to > from) ink.rect(from, -across, to - from, across * 2).fill(0xffffff)
    ink.tint = color
    const boil = drawing % edges.length
    lead.texture = edges[boil] ?? textures.edge0
    trail.texture = edges[(boil + 1) % edges.length] ?? textures.edge1
    for (const [sprite, at, sign] of [[lead, to, 1], [trail, from, -1]] as const) {
      sprite.tint = color
      sprite.width = edge
      sprite.height = across * 2
      sprite.scale.x = Math.abs(sprite.scale.x) * sign
      sprite.position.set(at - sign * edge * EDGE_BODY * 0.9, 0)
    }
    mottle.position.set(from, -across)
    mottle.width = Math.max(1, to - from)
    mottle.height = across * 2
  }

  /** Speed lines along the travel, paper over the ink and ink over the picture, redrawn on twos. */
  const drawStreaks = (from: number, to: number, reach: number, across: number, density: number, inkColor: number, paper: number) => {
    streaks.forEach((streak, index) => {
      if (index >= Math.round(STREAKS * density)) {
        streak.sprite.visible = false
        return
      }
      streak.u = -reach + fx.rng() * reach * 2.2
      streak.v = spread(fx.rng, across * 0.9)
      streak.length = (0.18 + fx.rng() * 0.45) * reach
      streak.alpha = 0.35 + fx.rng() * 0.6
      const onInk = streak.u > from && streak.u - streak.length * 0.5 < to
      streak.sprite.visible = true
      streak.sprite.tint = onInk ? paper : inkColor
      streak.sprite.alpha = onInk ? streak.alpha : streak.alpha * 0.55
      streak.sprite.position.set(streak.u, streak.v)
      streak.sprite.width = streak.length
      streak.sprite.height = index % 5 === 0 ? 12 + fx.rng() * 12 : 4 + fx.rng() * 6
    })
  }

  /**
   * How wide to draw the focus lines about `at`: their drawing is cut square at its edges, so its half-width reaches the
   * frame's farthest corner from `at` whichever way it turns, and the cut ends stay off the frame.
   */
  const focusSize = (at: { x: number; y: number }) => {
    const { width, height } = context.app.screen
    const farthest = Math.hypot(Math.max(at.x, width - at.x), Math.max(at.y, height - at.y))
    return Math.max(Math.hypot(width, height) * FOCUS_SPAN, farthest * 2 * FOCUS_ROOM)
  }

  /**
   * While the hero's drawing stands in for the hero (held over the wipe, run through the hold, over the gate's wash, or
   * over the hero until the ink uncovers it), the hero's body hides, so the hero is never on screen twice. Actors update
   * before effects each frame, so this holds for the frame it is set in.
   */
  const standIn = () => {
    const player = context.game.view().player
    const body = player === null ? undefined : context.actor(player.id)
    if (hero.visible && body !== undefined) body.node.visible = false
  }

  const hide = () => {
    hero.visible = false
    twin.visible = false
    focus.visible = false
    for (const ghost of ghosts) ghost.visible = false
  }

  /**
   * Where the held drawing is at `share` of its run from where the hero left the screen to where it now stands: on
   * along the travel (`u` along `angle`, `v` across), off the far edge and in from the near one when the arrival lies
   * behind. Returns screen points: the drawing, and its twin on the other side while it crosses the edge, and whether it
   * has come back in from the near edge yet. `angle` is
   * the travel square to the frame, not the wipe's slant: along a slant the far edge is reached at another height, so
   * the drawing would come back in off its line.
   */
  const runTo = (from: { x: number; y: number }, to: { x: number; y: number }, share: number, angle: number, edge: number) => {
    const { width, height } = context.app.screen
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const toBand = (point: { x: number; y: number }) => ({ u: (point.x - width / 2) * cos + (point.y - height / 2) * sin, v: -(point.x - width / 2) * sin + (point.y - height / 2) * cos })
    const toScreen = (u: number, v: number) => ({ x: width / 2 + u * cos - v * sin, y: height / 2 + u * sin + v * cos })
    const a = toBand(from)
    const b = toBand(to)
    const wrap = (width * Math.abs(cos) + height * Math.abs(sin)) / 2
    const ahead = b.u >= a.u ? b.u - a.u : wrap - a.u + (b.u + wrap)
    const along = a.u + ahead * share
    const u = along > wrap ? along - wrap * 2 : along
    const v = a.v + (b.v - a.v) * share
    const twinU = u > wrap - edge ? u - wrap * 2 : u < -wrap + edge ? u + wrap * 2 : null
    return { at: toScreen(u, v), twin: twinU === null ? null : toScreen(twinU, v), wrapped: along > wrap }
  }

  /** How far a screen point is ahead of the band's tail along the travel: positive while the ink still covers it. */
  const underInk = (point: { x: number; y: number }, angle: number, from: number) => {
    const { width, height } = context.app.screen
    return (point.x - width / 2) * Math.cos(angle) + (point.y - height / 2) * Math.sin(angle) - from
  }

  /**
   * The hero diving into the gate, `progress` through the exit and held there until the ink sheet passes over it: its
   * drawing over the frame's wash where the hero is, its afterimages trailing back along the travel, and from halfway
   * the focus lines closing on it, turning to ink.
   */
  const dive = (at: { x: number; y: number; size: number }, side: Side, progress: number, twos: number, fresh: boolean, paper: number, ink: number) => {
    const facing = SCREEN_ANGLE[side] + (twos % 2 === 0 ? 0.035 : -0.035)
    const size = at.size * (1.15 + progress * 0.3)
    hero.visible = true
    hero.position.set(at.x, at.y)
    hero.rotation = facing
    hero.width = hero.height = size
    hero.alpha = 1
    GHOSTS.forEach((each, index) => {
      const ghost = ghosts[index]
      if (ghost === undefined) return
      const back = size * (0.55 + index * 0.5) * Math.min(1, progress * 3)
      ghost.visible = back > 0
      ghost.position.set(at.x - Math.cos(facing) * back, at.y - Math.sin(facing) * back)
      ghost.rotation = facing
      ghost.width = ghost.height = size * 0.92
      ghost.alpha = each.alpha
    })
    focus.visible = progress > 0.4
    if (!focus.visible) return
    if (fresh) {
      focus.texture = fx.kit.focusLines[twos % fx.kit.focusLines.length] ?? focus.texture
      focus.rotation = fx.rng() * Math.PI * 2
      focus.width = focus.height = focusSize(at)
    }
    focus.tint = progress > 0.7 ? ink : paper
    focus.alpha = 0.35 + progress * 0.3
    focus.position.set(at.x, at.y)
  }

  const clear = () => {
    root.visible = false
    hide()
    held = null
    last = null
    if (framed) {
      context.frame.set({ lines: 0, whiteFlash: 0 })
      framed = false
    }
  }

  const show = (transition: TransitionView, time: FrameTime) => {
    const zoneChange = transition.kind === "zone"
    const angle = zoneChange ? -Math.PI / 2 : SCREEN_ANGLE[transition.side] + 0.1
    const { reach, across, edge } = layoutBand(angle)
    const start = -reach - edge
    const end = reach + edge
    const t = stepped(transition.progress, (zoneChange ? ZONE_BEATS : DOOR_BEATS)[transition.beat] / 60)
    const { ink: color, paper } = paletteOf(transition.zone)
    const twos = Math.floor(time.elapsed * SCREEN_TWOS)
    const fresh = twos !== drawing
    drawing = twos
    let from = start
    let to = start
    let density = 0.5
    switch (transition.beat) {
      case "exit":
        density = 0.35 + transition.progress * 0.4
        break
      case "cover":
        to = start + (end - start) * easeIn(t) + edge * 0.2
        density = 1
        break
      case "hold":
        to = end + edge
        density = 1
        break
      case "reveal":
        from = start + (end - start) * easeOut(t) - edge * 0.2
        to = end + edge
        density = 1 - transition.progress
        break
    }
    root.visible = true
    band.visible = !zoneChange || transition.beat === "exit"
    if (band.visible) {
      drawBand(from, to, across, edge, color)
      mottle.alpha = 0.075
      mottle.tileScale.set(3, 1)
      mottle.tilePosition.set(time.elapsed * 900, 0)
      if (fresh) drawStreaks(from, to, reach, across, density, color, paper)
    }

    const onScreen = heroOnScreen()
    if (transition.beat === "exit" || transition.beat === "cover" || (transition.beat === "hold" && held === null)) {
      if (onScreen !== null) held = { x: onScreen.x, y: onScreen.y, size: onScreen.size }
    }
    hide()
    if (!zoneChange && held !== null) {
      const facing = SCREEN_ANGLE[transition.side]
      const jitter = twos % 2 === 0 ? 0.035 : -0.035
      const place = (sprite: Sprite, point: { x: number; y: number }, size: number, alpha: number) => {
        sprite.visible = true
        sprite.position.set(point.x, point.y)
        sprite.rotation = facing + jitter
        sprite.width = sprite.height = size
        sprite.alpha = alpha
      }
      const arrival = onScreen ?? held
      if (transition.beat === "cover") {
        if (fresh) hero.position.set(held.x + spread(fx.rng, 2), held.y + spread(fx.rng, 2))
        place(hero, hero.position, held.size * (1 + t * 0.35), 1)
      } else if (transition.beat === "hold") {
        const run = runTo(held, arrival, runShare(transition.progress), facing, held.size)
        place(hero, run.at, held.size * 1.45, 1)
        if (run.twin !== null) place(twin, run.twin, held.size * 1.45, 1)
        const origin = held
        GHOSTS.forEach((each, index) => {
          const ghost = ghosts[index]
          const then = transition.progress - each.behind
          if (ghost === undefined || then <= 0) return
          const trail = runTo(origin, arrival, runShare(then), facing, origin.size)
          if (trail.wrapped === run.wrapped) place(ghost, trail.at, origin.size * 1.3, each.alpha)
        })
      } else if (transition.beat === "reveal" && underInk(arrival, angle, from) > -edge * 0.1) {
        place(hero, arrival, held.size * (1.45 - 0.45 * Math.min(1, transition.progress * 4)), 1)
      }
      const still = transition.beat === "cover" ? t > 0.75 : transition.beat === "hold" && runShare(transition.progress) >= LANDED
      focus.visible = hero.visible && still
      if (focus.visible) {
        if (fresh) {
          focus.texture = fx.kit.focusLines[twos % fx.kit.focusLines.length] ?? focus.texture
          focus.rotation = fx.rng() * Math.PI * 2
        }
        focus.width = focus.height = focusSize(hero.position)
        focus.tint = paper
        focus.alpha = transition.beat === "hold" ? 0.55 : 0.3
        focus.position.set(hero.position.x, hero.position.y)
      }
    }
    if (zoneChange && (transition.beat === "exit" || transition.beat === "cover") && onScreen !== null) dive(onScreen, transition.side, transition.beat === "exit" ? transition.progress : 1, twos, fresh, paper, color)
    standIn()
    if (transition.beat === "exit" || (!zoneChange && transition.beat === "reveal")) smear(SCREEN_ANGLE[transition.side])

    const inking = transition.beat === "reveal" ? (transition.progress < 0.5 ? 1 : transition.progress < 0.65 ? 0.45 : 0) : 0
    const glare = zoneChange ? (transition.beat === "exit" ? transition.progress * ZONE_WASH : transition.beat === "cover" ? ZONE_WASH * (1 - t) : 0) : 0
    context.frame.set({ lines: inking, whiteFlash: glare })
    framed = true
  }

  /** Drawn once, all but invisible, on the first frames, so the first transition doesn't pay for its shaders. */
  let warming = 2
  return {
    update: (time) => {
      const view = context.game.view()
      const transition = view.flow === "Playing" || view.flow === "Paused" ? view.transition : null
      if (transition === null) {
        if (warming > 0) {
          warming -= 1
          root.visible = warming > 0
          root.alpha = 0.002
          const { reach, across, edge } = layoutBand(0)
          drawBand(-reach, reach, across, edge, 0)
          return
        }
        if (root.visible || framed) clear()
        return
      }
      root.alpha = 1
      show(transition, time)
    },
    clear,
    dispose: () => {
      for (const off of offs) off()
      clear()
      root.destroy({ children: true })
      for (const texture of Object.values(textures)) texture.destroy(true)
    }
  }
}
