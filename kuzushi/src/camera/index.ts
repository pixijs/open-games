import { clamp } from "math"
import { spring } from "math/time"

import type { Install } from "../host/types.ts"
import { SIDE_DIRS } from "../sim/index.ts"
import type { ArenaLayout, GameView, StageId } from "../sim/index.ts"
import { COURTYARD_BOUNDS, CUT_IN, SPECIAL_FOV } from "./rig.ts"
import type { PlayBounds, ShotName } from "./rig.ts"

export { CameraRig } from "./rig.ts"
export type { ShotName, TitleShot } from "./rig.ts"

/**
 * How far the play frame reaches on each stage. The Courtyard shows its walls and a margin beyond; the Spiral's round
 * floor fits the wide frame side to side, so it follows mostly up and down; the Void's small floor stays framed whole
 * with the column of light at the top, the dark all round it.
 */
const BOUNDS: Readonly<Record<StageId, PlayBounds>> = {
  courtyard: COURTYARD_BOUNDS,
  spiral: { centerX: 0, halfWidth: 20, minZ: -9, maxZ: 9.5 },
  void: { centerX: 0.5, halfWidth: 15.5, minZ: -3, maxZ: 1.5 }
}

/** After a door's cut the frame starts this far back along the way the hero came and glides on into the room. */
const GLIDE = 1.6

/** In a boss fight the follow target leans from the player toward the boss by this share of the way, up to `most` units, so both stay in frame. */
const BOSS_LEAN = { share: 0.5, most: 6 } as const

/** Where the follow target leans from the player toward the room's boss while it fights; (0, 0) with no boss. */
const bossLean = (view: GameView): { readonly x: number; readonly z: number } => {
  const player = view.player
  const boss = view.boss === null || view.boss.state === "intro" ? undefined : view.enemies.find((enemy) => enemy.id === view.boss?.id)
  if (player === null || boss === undefined) return { x: 0, z: 0 }
  const dx = (boss.x - player.x) * BOSS_LEAN.share
  const dz = (boss.z - player.z) * BOSS_LEAN.share
  const scale = Math.min(1, BOSS_LEAN.most / Math.max(1e-6, Math.hypot(dx, dz)))
  return { x: dx * scale, z: dz * scale }
}

/**
 * Once the zone gate opens, the frame turns toward it. Across, its middle comes within `inside` of the frame's half
 * width of the gate (a quarter of the frame in from its edge) as far as keeps the hero within `hero` of the half width
 * of the middle. Up and down, the follow target comes to where the gate stands no more than `north` units north of it
 * or `south` units south (a quarter of the frame in from its top or bottom), as far as keeps the hero no more than
 * `above` units north of it and `below` units south. The bound on the gate's side gives way to let it. So the gate, its
 * glare and the hero's dive into it stay well inside the frame.
 */
const GATE_FRAME = { inside: 0.38, hero: 0.5, north: 5.5, south: 4.5, above: 7, below: 4.5 } as const

/** The zone gate's doorway while it stands open, else null. */
const openGate = (view: GameView) => view.room?.doors.find((door) => door.mark === "gate") ?? null

/**
 * Where the follow target leans from the player toward the open gate, for a frame `half` units wide each side whose
 * middle stands `shift` units right of its subject; (0, 0) with no gate open.
 */
const gateLean = (view: GameView, half: number, shift: number): { readonly x: number; readonly z: number } => {
  const gate = openGate(view)
  const player = view.player
  if (gate === null || player === null) return { x: 0, z: 0 }
  const reach = GATE_FRAME.inside * half
  const keep = GATE_FRAME.hero * half
  const middle = clamp(clamp(player.x + shift, gate.x - reach, gate.x + reach), player.x - keep, player.x + keep)
  const target = clamp(clamp(player.z, gate.z - GATE_FRAME.south, gate.z + GATE_FRAME.north), player.z - GATE_FRAME.below, player.z + GATE_FRAME.above)
  return { x: middle - shift - player.x, z: target - player.z }
}

/** `bounds` given way on the open gate's side, for a frame `half` units wide each side whose middle stands `shift` right of its subject. */
const towardGate = (view: GameView, bounds: PlayBounds, half: number, shift: number): PlayBounds => {
  const gate = openGate(view)
  if (gate === null) return bounds
  const reach = half * (1 - GATE_FRAME.inside)
  const left = bounds.centerX - bounds.halfWidth
  const right = bounds.centerX + bounds.halfWidth
  const widen = (from: number, to: number) => ({ ...bounds, centerX: (from + to) / 2, halfWidth: (to - from) / 2 })
  switch (gate.side) {
    case "east": return widen(left, Math.max(right, gate.x + reach - shift))
    case "west": return widen(Math.min(left, gate.x - reach - shift), right)
    case "north": return { ...bounds, minZ: Math.min(bounds.minZ, gate.z + GATE_FRAME.north) }
    case "south": return { ...bounds, maxZ: Math.max(bounds.maxZ, gate.z - GATE_FRAME.south) }
  }
}

/**
 * A boss's bar across the top of the screen (src/ui/boss-bar.ts) and its scrim are about `bar` px tall: while it shows,
 * the play frame keeps that band clear of its subject and stands `pull` times further back, so a boss at the far side
 * of its room stays below the bar with the hero still in frame.
 */
const BOSS_FRAME = { bar: 120, pull: 1.1 } as const

/** Whether a boss's bar is up: its fight is on, from the bar filling in to the killing blow. */
const bossBarUp = (view: GameView): boolean => view.flow === "Playing" && view.boss !== null && view.boss.state !== "intro" && view.boss.state !== "defeated"

/**
 * The HUD's right column (minimap, zone, timer, the room's line) takes about a fifth of a narrow screen: below an
 * aspect of `below`, in a room with a doorway on its east side, the play frame's subject moves left by up to `most` of
 * the half width, `rate` for each step of aspect under it, so that door and its seal's emblem stand clear of the
 * column; half as far when a west doorway would be pushed off the frame's other edge.
 */
const HUD_COLUMN = { below: 2, rate: 0.6, most: 0.14 } as const

const hudColumn = (view: GameView, aspect: number): number => {
  const sides = view.room?.doors.map((door) => door.side) ?? []
  if (!sides.includes("east")) return 0
  const share = Math.min(HUD_COLUMN.most, Math.max(0, (HUD_COLUMN.below - aspect) * HUD_COLUMN.rate))
  return sides.includes("west") ? share / 2 : share
}

/** How far inside the Void's standing slabs, north and south, its follow band keeps, so a shrinking floor stays centred. */
const SLAB_INSET = { north: 4, south: 3.5 } as const

/**
 * A room's frame (docs/DESIGN.md, Camera): the frame's edges within the floor's half width plus 4 of its centre line,
 * and the follow target within z from -halfDepth + 5 to halfDepth - 3 (far enough south that the south door and its
 * seal's emblem stand clear of the frame's bottom edge), collapsed to their middle on a shallow floor.
 */
const ROOM_FRAME = { side: 4, north: 5, south: 3 } as const

const roomBounds = (layout: ArenaLayout): PlayBounds => {
  const minZ = -layout.halfDepth + ROOM_FRAME.north
  const maxZ = layout.halfDepth - ROOM_FRAME.south
  const middle = (minZ + maxZ) / 2
  return { centerX: 0, halfWidth: layout.halfWidth + ROOM_FRAME.side, minZ: Math.min(minZ, middle), maxZ: Math.max(maxZ, middle) }
}

/** The room's or stage's bounds; on Void slabs the follow band tightens to the slabs still standing after each collapse. */
const boundsFor = (view: GameView): PlayBounds => {
  const bounds = view.room === null ? BOUNDS[view.zone] : roomBounds(view.room.layout)
  if (view.hazard.kind !== "slabs") return bounds
  const standing = view.hazard.slabs.filter((slab) => slab.state !== "fallen")
  if (standing.length === 0) return bounds
  const north = Math.min(...standing.map((slab) => slab.z - slab.halfDepth)) + SLAB_INSET.north
  const south = Math.max(...standing.map((slab) => slab.z + slab.halfDepth)) - SLAB_INSET.south
  const middle = (north + south) / 2
  const within = (z: number) => clamp(z, bounds.minZ, bounds.maxZ)
  return north <= south ? { ...bounds, minZ: within(north), maxZ: within(south) } : { ...bounds, minZ: within(middle), maxZ: within(middle) }
}

const shotFor = (view: GameView): ShotName => {
  switch (view.flow) {
    case "Title": return "title"
    case "Playing": return view.tempo.frozen ? "special" : view.boss?.state === "intro" ? "boss" : "play"
    case "Paused":
    case "RunClear":
    case "GameOver":
      return "pause"
  }
}

const CANDIDATES = 24
/** How near the lens an enemy may stand in front of it before it fills the shot as a blur. */
const FOREGROUND = 3.2

/** Distance from (px, pz) to the ground segment a→b, and how far along it the nearest point lies. */
const toSegment = (px: number, pz: number, ax: number, az: number, bx: number, bz: number) => {
  const dx = bx - ax
  const dz = bz - az
  const along = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1), 0, 1)
  return { distance: Math.hypot(px - (ax + dx * along), pz - (az + dz * along)), along }
}

/** How far ground point (px, pz) is from the nearest block, pillar or backdrop monolith of `layout`; 0 inside one. */
const clearance = (layout: ArenaLayout, px: number, pz: number): number => {
  let nearest = Number.POSITIVE_INFINITY
  for (const block of [...layout.blocks, ...layout.backdrop]) {
    const dx = Math.max(0, Math.abs(px - block.x) - block.halfWidth)
    const dz = Math.max(0, Math.abs(pz - block.z) - block.halfDepth)
    nearest = Math.min(nearest, Math.hypot(dx, dz))
  }
  for (const pillar of layout.pillars) nearest = Math.min(nearest, Math.max(0, Math.hypot(px - pillar.x, pz - pillar.z) - pillar.radius))
  return nearest
}

/** Whether a lens over ground point (x, z) would stand outside the walls. The Void has none: a lens may hang over the dark. */
const pastWalls = (layout: ArenaLayout, x: number, z: number): boolean => {
  const margin = 0.5
  switch (layout.floor.kind) {
    case "rect": return Math.abs(x) > layout.halfWidth - margin || Math.abs(z) > layout.halfDepth - margin
    case "round": return Math.hypot(x, z) > layout.floor.radius - margin
    case "slabs": return false
  }
}

/** Ground samples across the cut-in's view, by distance from the lens and turn off its axis (radians). */
const VIEW_SAMPLES = [0.8, 1.8, 2.8, 4.2, 5.6, 7].flatMap((distance) => [-0.5, -0.25, 0, 0.25, 0.5].map((turn) => ({ distance, turn })))

/** How much of a lens at (cx, cz) looking along `look` is filled by props; those nearer than the player count double. */
const framed = (layout: ArenaLayout, cx: number, cz: number, look: number): number => {
  let filled = 0
  for (const { distance, turn } of VIEW_SAMPLES) {
    if (clearance(layout, cx + Math.cos(look + turn) * distance, cz + Math.sin(look + turn) * distance) > 0.1) continue
    filled += distance < CUT_IN.from ? 2 : 1
  }
  return filled
}

/** How many enemies stand within `FOREGROUND` in front of a lens at (cx, cz) looking toward (x, z). */
const foreground = (view: GameView, cx: number, cz: number, x: number, z: number): number => {
  const look = Math.atan2(z - cz, x - cx)
  let count = 0
  for (const enemy of view.enemies) {
    const distance = Math.hypot(enemy.x - cx, enemy.z - cz)
    const bearing = Math.atan2(enemy.z - cz, enemy.x - cx) - look
    if (distance < FOREGROUND && Math.cos(bearing) > 0.5) count += 1
  }
  return count
}

/** The share of the frame's width kept clear at each side for the lock-on marks, and their half size in world units. */
const MARK = { margin: 0.06, halfSize: 1.1, height: 0.55 } as const

/** Which side of the frame (-1 left, 1 right) the player takes from a lens on bearing `azimuth`: opposite the enemies. */
const sideFor = (toward: number, azimuth: number): -1 | 1 => (Math.cos(toward) * Math.sin(azimuth) - Math.sin(toward) * Math.cos(azimuth) > 0 ? -1 : 1)

/**
 * How many of `marked` would sit outside the cut-in's frame, lock-on marks and all, from a lens on bearing `azimuth`
 * that puts the player at its screen spot on `side`. Taken where the push-in ends, the tightest it gets.
 */
const offFrame = (marked: ReadonlyArray<{ readonly x: number; readonly z: number }>, x: number, z: number, azimuth: number, side: -1 | 1, aspect: number): number => {
  const tanV = Math.tan((SPECIAL_FOV * Math.PI) / 360)
  const tanH = tanV * aspect
  const lx = x + Math.cos(azimuth) * CUT_IN.to
  const lz = z + Math.sin(azimuth) * CUT_IN.to
  const ly = CUT_IN.height + CUT_IN.rise
  const yaw = azimuth + Math.PI - Math.atan(side * (1 - 2 * CUT_IN.screenX) * tanH)
  const pitch = Math.atan2(ly - 0.15, CUT_IN.to) + Math.atan(CUT_IN.screenY * tanV)
  const limit = 1 - 2 * MARK.margin
  let off = 0
  for (const target of marked) {
    const dx = target.x - lx
    const dz = target.z - lz
    const depth = Math.cos(pitch) * (dx * Math.cos(yaw) + dz * Math.sin(yaw)) + Math.sin(pitch) * (ly - MARK.height)
    if (depth < 0.5) {
      off += 1
      continue
    }
    const across = dz * Math.cos(yaw) - dx * Math.sin(yaw)
    if (Math.abs(across) / (depth * tanH) + MARK.halfSize / (depth * tanH) > limit) off += 1
  }
  return off
}

/**
 * The special's cut-in: the ground direction to film from, over the player's shoulder toward the enemies (or behind
 * its facing), turned away from any enemy or prop between the lens and the player, from enemies right in front of
 * the lens, from props filling the frame, from the walls, and from leaving a marked enemy's lock-on at the frame's
 * edge; and the side of the frame the player takes, opposite the enemies so they fill the rest.
 */
const cutIn = (view: GameView, layout: ArenaLayout, x: number, z: number, facing: number, reach: number, aspect: number): { readonly azimuth: number; readonly side: -1 | 1 } => {
  const near = view.enemies.filter((enemy) => Math.hypot(enemy.x - x, enemy.z - z) < 10)
  const marked = view.enemies.filter((enemy) => Math.hypot(enemy.x - x, enemy.z - z) <= reach + 0.5)
  const toward = near.length === 0 ? facing : Math.atan2(near.reduce((sum, e) => sum + e.z - z, 0), near.reduce((sum, e) => sum + e.x - x, 0))
  const ideal = toward + Math.PI - 0.55
  let best = ideal
  let bestScore = Number.NEGATIVE_INFINITY
  for (let index = 0; index < CANDIDATES; index++) {
    const azimuth = ideal + (index / CANDIDATES) * Math.PI * 2
    const cx = x + Math.cos(azimuth) * CUT_IN.from
    const cz = z + Math.sin(azimuth) * CUT_IN.from
    let score = Math.cos(azimuth - ideal) * 3
    score -= offFrame(marked, x, z, azimuth, sideFor(toward, azimuth), aspect) * 6
    for (const enemy of view.enemies) {
      const { distance, along } = toSegment(enemy.x, enemy.z, cx, cz, x, z)
      if (along < 0.97 && distance < 1.1) score -= 10
    }
    score -= foreground(view, cx, cz, x, z) * 12
    let sightLine = Number.POSITIVE_INFINITY
    for (let sample = 0; sample <= 6; sample++) {
      const along = (sample / 6) * 0.85
      sightLine = Math.min(sightLine, clearance(layout, cx + (x - cx) * along, cz + (z - cz) * along))
    }
    if (sightLine < 0.35) score -= 20
    score -= framed(layout, cx, cz, azimuth + Math.PI) * 1.5
    if (pastWalls(layout, cx, cz)) score -= 15
    if (score > bestScore) {
      bestScore = score
      best = azimuth
    }
  }
  return { azimuth: best, side: sideFor(toward, best) }
}

/**
 * Picks the shot from the screen the game is on, keeps the play frame inside the room's (or stage's) bounds, feeds
 * the follow target (leaning toward a fighting boss, or the open zone gate with its side's bound given way) and its
 * lead toward the aim, keeps the HUD's bands clear (a boss's bar, standing back a step while it shows; the right
 * column on a narrow screen), cuts to the new room under a transition's cover, holds a boss's name card in its low
 * shot, and frames the special against the current room's props and walls.
 */
export const installCamera: Install = (context) => {
  const { rig } = context
  const leadX = spring.create(0)
  const leadZ = spring.create(0)
  const leanX = spring.create(0)
  const leanZ = spring.create(0)
  const pull = spring.create(1)
  const band = spring.create(0)
  const column = spring.create(0)
  let bounds: PlayBounds | null = null
  let cut = false
  let glide: { x: number; z: number } | null = null
  const offs = [
    context.moments.on("specialStarted", (moment) => {
      const { width, height } = context.app.screen
      const { azimuth, side } = cutIn(context.game.view(), context.game.arena, moment.x, moment.z, moment.facing, moment.radius, width / Math.max(1, height))
      rig.setSpecial(moment.x, moment.z, azimuth, side)
    }),
    context.moments.on("roomSwapped", (swapped) => {
      cut = true
      const through = SIDE_DIRS[swapped.kind === "zone" ? "north" : swapped.side]
      glide = { x: -through.x * GLIDE, z: -through.z * GLIDE }
    }),
    context.moments.on("runStarted", () => {
      cut = true
    }),
    context.moments.on("bossIntro", (moment) => {
      const player = context.game.view().player
      rig.setBoss(moment.x, moment.z, player?.x ?? moment.x, player?.z ?? moment.z + 6)
    })
  ]
  return {
    update: (frame) => {
      // The camera holds the title's opening shot while loading, so its first visible frame starts the framing afresh.
      if (context.loading) return
      const view = context.game.view()
      const { width, height } = context.app.screen
      const barUp = bossBarUp(view)
      spring.damp(pull, barUp ? BOSS_FRAME.pull : 1, 0.6, frame.dt)
      spring.damp(band, barUp ? BOSS_FRAME.bar / Math.max(1, height) : 0, 0.6, frame.dt)
      rig.pullBack(Math.abs(pull.value - 1) < 1e-4 ? 1 : pull.value)
      const columnGoal = view.flow === "Playing" || view.flow === "Paused" ? hudColumn(view, width / Math.max(1, height)) : 0
      if (cut) column.value = columnGoal
      spring.damp(column, columnGoal, 0.5, frame.dt)
      rig.reserve(band.value < 1e-4 ? 0 : band.value, column.value < 1e-4 ? 0 : column.value)
      const half = rig.frameHalfWidth
      const shift = column.value * half
      const next = towardGate(view, boundsFor(view), half, shift)
      if (bounds === null || next.centerX !== bounds.centerX || next.halfWidth !== bounds.halfWidth || next.minZ !== bounds.minZ || next.maxZ !== bounds.maxZ) {
        bounds = next
        rig.setBounds(next)
      }
      const player = view.player
      const gate = gateLean(view, half, shift)
      const lean = gate.x !== 0 || gate.z !== 0 ? gate : bossLean(view)
      spring.damp(leanX, lean.x, 0.5, frame.dt)
      spring.damp(leanZ, lean.z, 0.5, frame.dt)
      if (player !== null) {
        const placed = context.actor(player.id)?.node.position
        rig.setPlayer((cut ? player.x : placed?.x ?? player.x) + leanX.value, (cut ? player.z : placed?.z ?? player.z) + leanZ.value)
      }
      if (cut && view.flow === "Playing") {
        rig.cutPlay()
        leadX.value = glide?.x ?? 0
        leadZ.value = glide?.z ?? 0
        glide = null
        cut = false
      }
      const leading = player !== null && view.flow === "Playing"
      spring.damp(leadX, leading ? Math.cos(player.facing) : 0, 0.35, frame.dt)
      spring.damp(leadZ, leading ? Math.sin(player.facing) : 0, 0.35, frame.dt)
      rig.lead(leadX.value, leadZ.value)
      rig.setShot(shotFor(view))
    },
    dispose: () => {
      for (const off of offs) off()
    }
  }
}
