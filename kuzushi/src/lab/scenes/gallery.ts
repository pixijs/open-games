import { BOSSES, isBoss, Tuning, zoneOf } from "../../sim/index.ts"
import type { EnemyKind, EnemyView, GameView, Point } from "../../sim/index.ts"
import { el } from "../../ui/dom.ts"
import { after } from "../choose.ts"
import type { Scene } from "../scene.ts"
import { INK } from "../sketch.ts"
import { BEHAVIOUR, ELITE_NOTE, NAMES, NORTH, zoneKinds } from "./roster.ts"

const steps = ["Spawn", "Idle", "Telegraph", "Attack", "Stagger", "Death"] as const
type Step = (typeof steps)[number]

/** Where the telegraph is held for a look: this far through the windup. */
const HOLD_AT = 0.6
/** Gameplay steps auto-cycling stays on each step, at least. */
const AUTO_STEPS = 96
/** Pixels a label keeps clear of the screen's left edge and of the docked panel. */
const LABEL_GAP = 12
/** Gameplay steps after a kind is gone before it stands on its spot again. */
const RESPAWN_STEPS = 48

/** The zone's kinds stand in a row north of the player, its boss south of it. */
const ROWS = { spacing: 5.2, north: -4.5, boss: 4.2 } as const

/** The whole gallery in one ground circle: the row, the boss and their labels. */
const WHOLE = { z: 1.2, radius: 11 } as const

interface Slot {
  readonly kind: EnemyKind
  readonly at: Point
  /** Faces the player in the middle. */
  readonly facing: number
  id: number | null
  /** The gameplay step it was found gone, or null while it stands. */
  goneAt: number | null
  readonly label: HTMLElement
  readonly state: HTMLElement
}

/** Every pattern a boss plays, in phase order, so its telegraph step shows each in turn. */
const patternsOf = (kind: EnemyKind) => (isBoss(kind) ? [...new Set(BOSSES[kind].phases.flatMap((phase) => phase.patterns))] : [])

/**
 * One zone's enemies on their own spots in its colours: its four kinds (a splitter's splitling beside it) in a row
 * north of the player, its boss south, each with its name and health on a card kept clear of the panel, and what the
 * selected one does; as elites when asked. Selecting one steps it through spawn, idle, telegraph (held for a look; a
 * boss plays each of its patterns in turn), attack, stagger (a boss breaks) and death, by key or on its own; the camera
 * can frame it. A kind that dies stands on its spot again a moment later, and what a splitter splits into goes when
 * the selection moves on.
 */
export const galleryScene: Scene = {
  id: "gallery",
  title: "Enemy gallery",
  summary: "A zone's enemies and boss, each stepped through its states.",
  defaults: { invulnerable: true, camera: "play" },
  usesAi: false,
  create: (tools) => {
    const { game, anchor, layer } = tools
    const kinds = zoneKinds(tools.zone)
    const selected = tools.option(`selected.${tools.zone}`, kinds[0] ?? "chaser")
    const close = tools.option("close", false)
    const auto = tools.option("auto", false)
    const elites = tools.option("elite", false)
    let step: Step = "Idle"
    let holding = false
    let stepAt = 0
    let patternAt = 0

    const regular = kinds.filter((kind) => !isBoss(kind))
    const slotOf = (kind: EnemyKind): Point => {
      if (isBoss(kind)) return { x: anchor.x, z: anchor.z + ROWS.boss }
      const index = regular.indexOf(kind)
      return { x: anchor.x + (index - (regular.length - 1) / 2) * ROWS.spacing, z: anchor.z + ROWS.north }
    }
    const eliteOf = (kind: EnemyKind) => elites.get() && !isBoss(kind)
    const spawn = (slot: Pick<Slot, "kind" | "at" | "facing">) =>
      game.spawn(slot.kind, slot.at.x, slot.at.z, { facing: slot.facing, drill: "idle", elite: eliteOf(slot.kind) })

    game.teleport(anchor.x, anchor.z, NORTH)
    const slots: ReadonlyArray<Slot> = kinds.map((kind) => {
      const at = slotOf(kind)
      const facing = at.z < anchor.z ? Math.PI / 2 : NORTH
      spawn({ kind, at, facing })
      const elite = eliteOf(kind)
      const hp = Tuning.ENEMY[kind].hp * (elite ? Tuning.ELITE.health : 1)
      const state = el("span", "k-lab-tag-state")
      const label = el("div", "k-lab-tag",
        el("span", "k-lab-tag-name", elite ? `Elite ${NAMES[kind]}` : NAMES[kind]),
        el("span", "k-lab-tag-hp", `HP ${hp} · radius ${+Tuning.radiusOf(kind, elite).toFixed(2)}`),
        el("span", "k-lab-tag-note", elite ? `${BEHAVIOUR[kind]} ${ELITE_NOTE}` : BEHAVIOUR[kind]),
        state)
      label.addEventListener("click", () => select(kind))
      layer.append(label)
      return { kind, at, facing, id: null, goneAt: null, label, state }
    })

    const first = slots[0]
    if (first === undefined) throw new Error("gallery: no enemy kinds")
    const current = (): Slot => slots.find((slot) => slot.kind === selected.get()) ?? first
    const viewOf = (slot: Slot): EnemyView | undefined => tools.context.game.view().enemies.find((enemy) => enemy.id === slot.id)

    /** Takes away every enemy that has no spot: splitlings a splitter split into, a boss's summons. */
    const clearStrays = () => {
      const kept = new Set(slots.map((each) => each.id))
      for (const enemy of tools.context.game.view().enemies) if (!kept.has(enemy.id)) game.remove(enemy.id)
    }
    /** Stands the kind on its spot again, fresh. */
    const respawn = (slot: Slot) => {
      if (slot.kind === "splitter" || isBoss(slot.kind)) clearStrays()
      if (slot.id !== null) game.remove(slot.id)
      slot.id = null
      slot.goneAt = null
      spawn(slot)
    }
    /** Puts a kind its attack carried off its spot back on it. */
    const home = (slot: Slot) => {
      const enemy = viewOf(slot)
      if (enemy !== undefined && Math.hypot(enemy.x - slot.at.x, enemy.z - slot.at.z) > 0.2) game.teleport(slot.at.x, slot.at.z, slot.facing, enemy.id)
    }

    const select = (kind: EnemyKind) => {
      if (holding) {
        holding = false
        tools.transport.pause(false)
      }
      const left = current()
      if (left.kind !== kind) {
        clearStrays()
        if (viewOf(left) === undefined) respawn(left)
        else home(left)
      }
      selected.set(kind)
      step = "Idle"
    }
    const shift = (by: number) => select(after(kinds, current().kind, by) ?? first.kind)

    /** Plays `next` on the selected enemy. */
    const go = (next: Step) => {
      const slot = current()
      step = next
      stepAt = tools.context.game.view().tempo.playStep
      if (holding) {
        holding = false
        tools.transport.pause(false)
      }
      switch (next) {
        case "Spawn":
          respawn(slot)
          return
        case "Idle":
          home(slot)
          return
        case "Telegraph": {
          home(slot)
          const patterns = patternsOf(slot.kind)
          const pattern = patterns[patternAt++ % Math.max(1, patterns.length)]
          if (pattern !== undefined) game.bossPattern(pattern)
          if (slot.id !== null) game.attack(slot.id)
          return
        }
        case "Attack": return
        case "Stagger":
          if (slot.id === null) return
          if (isBoss(slot.kind)) game.breakBoss()
          else game.blow(slot.id, 0, 3)
          return
        case "Death":
          if (slot.id !== null) game.blow(slot.id, 9999, 1)
      }
    }
    const advance = () => go(steps[(steps.indexOf(step) + 1) % steps.length] ?? "Spawn")

    /** How far the selected one's telegraph has come: its own, or its boss's furthest. */
    const tellProgress = (view: GameView, enemy: EnemyView | undefined): number => {
      if (enemy === undefined) return 0
      if (view.boss !== null && view.boss.id === enemy.id) return Math.max(0, ...view.boss.telegraphs.map((each) => each.progress))
      return enemy.telegraph?.progress ?? 0
    }

    tools.on("enemySpawned", (moment) => {
      const slot = slots.find((each) => each.kind === moment.kind && Math.hypot(each.at.x - moment.x, each.at.z - moment.z) < 0.5)
      if (slot !== undefined) slot.id = moment.id
    })

    return {
      controls: [
        { kind: "action", label: "Previous", run: () => shift(-1) },
        { kind: "action", label: "Next", run: () => shift(1) },
        { kind: "action", label: "Next state", run: advance },
        { kind: "toggle", label: "Auto", get: auto.get, set: auto.set },
        { kind: "toggle", label: "Frame it", get: close.get, set: close.set },
        { kind: "toggle", label: "Elites", get: elites.get, set: (on) => {
          elites.set(on)
          tools.replay()
        } }
      ],
      update: (view) => {
        const slot = current()
        const enemy = viewOf(slot)
        if (step === "Telegraph" && !holding && tellProgress(view, enemy) >= HOLD_AT && !auto.get()) {
          holding = true
          tools.transport.pause(true)
        }
        if (holding && !tools.transport.paused) holding = false
        if (auto.get() && view.tempo.playStep - stepAt >= AUTO_STEPS && (step !== "Attack" || enemy === undefined || enemy.state === "Move")) advance()
        for (const each of slots) {
          if (each.id === null || view.enemies.some((one) => one.id === each.id)) continue
          each.goneAt ??= view.tempo.playStep
          if (view.tempo.playStep - each.goneAt >= RESPAWN_STEPS) respawn(each)
        }
        const focus = enemy ?? { x: slot.at.x, z: slot.at.z }
        const near = isBoss(slot.kind) ? 4.6 : 2.6
        tools.frame(close.get() ? { x: focus.x, z: focus.z, radius: near, close: true } : { x: anchor.x, z: anchor.z + WHOLE.z, radius: WHOLE.radius })
      },
      readouts: (view) => {
        const slot = current()
        const enemy = viewOf(slot)
        const zone = zoneOf(tools.zone)
        const boss = view.boss !== null && view.boss.id === enemy?.id ? view.boss : null
        return [
          { label: "Zone", value: `${zone.number} ${zone.name} ${zone.kanji}` },
          { label: "Enemy", value: `${eliteOf(slot.kind) ? "Elite " : ""}${NAMES[slot.kind]}` },
          { label: "Step", value: holding ? `${step} · held` : step, hot: step === "Telegraph" || step === "Attack" },
          { label: "Enemy state", value: enemy === undefined ? "Gone" : `${enemy.state}${enemy.timeLeft > 0 ? ` · ${enemy.timeLeft.toFixed(2)} s` : ""}` },
          { label: "Health", value: enemy === undefined ? "0" : `${Math.round(enemy.hp)} / ${enemy.maxHp}` },
          ...(boss === null ? [] : [{ label: "Pattern", value: `${boss.pattern ?? "resting"} · phase ${boss.phase}/${boss.phases} · ${boss.state}` }])
        ]
      },
      draw: (sketch, view) => {
        const slot = current()
        const right = tools.context.app.screen.width - tools.insets().right - LABEL_GAP
        for (const each of slots) {
          const enemy = view.enemies.find((one) => one.id === each.id)
          const at = enemy ?? each.at
          const screen = tools.toScreen(at.x, at.z + Tuning.radiusOf(each.kind, eliteOf(each.kind)) + 0.35)
          each.label.hidden = screen === null || (close.get() && each !== slot)
          if (each.label.hidden || screen === null) continue
          const half = each.label.offsetWidth / 2
          const x = Math.max(half + LABEL_GAP, Math.min(right - half, screen.x))
          each.label.style.transform = `translate(${Math.round(x)}px, ${Math.round(screen.y)}px) translateX(-50%)`
          each.label.classList.toggle("is-selected", each === slot)
          const shown = each === slot ? (holding ? `${step} · held` : step) : ""
          if (each.state.textContent !== shown) each.state.textContent = shown
        }
        sketch.circle(slot.at.x, slot.at.z, Tuning.radiusOf(slot.kind, eliteOf(slot.kind)) + 0.6, { ...INK.red, width: 1 })
      },
      dispose: () => {
        if (holding) tools.transport.pause(false)
      }
    }
  }
}
