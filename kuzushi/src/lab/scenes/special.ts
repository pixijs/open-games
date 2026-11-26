import { Tuning, zoneOf } from "../../sim/index.ts"
import type { EnemyKind, GameView } from "../../sim/index.ts"
import { oneOf } from "../choose.ts"
import type { Scene } from "../scene.ts"
import { INK } from "../sketch.ts"
import { facingTo, NAMES, NORTH, ringAround, rosterChoices, settler } from "./roster.ts"

/** The enemies the special would strike now: before its first beat, what the kills count toward. */
const inReach = (view: GameView): number => {
  const player = view.player
  if (player === null) return 0
  return view.enemies.filter((enemy) => enemy.state !== "Falling" && Math.hypot(enemy.x - player.x, enemy.z - player.z) <= Tuning.SPECIAL.radius).length
}

/** Gameplay steps a looping special waits after the slow motion before the ring comes back. */
const REST_STEPS = 72
/** Room a boss in the ring keeps clear round its body. */
const BOSS_GAP = 1.2

/**
 * KUZUSHI against a ring of 1 to 12 of the zone's enemies round the player, and its boss if asked, fired on demand or
 * on a loop: the real special with its freeze, cut-in, six beats, finisher and slow motion, in the zone's colours. The
 * ring stands still (AI off) or fights (AI on); the boss can be broken first, when the special lands twice as hard.
 */
export const specialScene: Scene = {
  id: "special",
  title: "Special",
  summary: "KUZUSHI against a ring of the zone's enemies, or its boss.",
  defaults: { invulnerable: true, camera: "play" },
  usesAi: true,
  create: (tools) => {
    const { game, anchor } = tools
    const count = tools.option("count", 8)
    const radius = tools.option("radius", 4)
    const kind = tools.option("kind", "mixed")
    const loop = tools.option("loop", false)
    const withBoss = tools.option("boss", false)
    const zone = zoneOf(tools.zone)
    const choices = rosterChoices(tools.zone)
    const chosen = (): EnemyKind | null => oneOf(zone.roster, kind.get(), null)
    const changed = settler(0.25)
    const beat: { index: number; count: number; targets: number; fired: number } = { index: 0, count: Tuning.SPECIAL.hits, targets: 0, fired: 0 }
    /** Every enemy the special has struck so far, and those it has killed, counted as each beat lands. */
    const struck = new Set<number>()
    const killed = new Set<number>()
    let endedAt: number | null = null

    game.teleport(anchor.x, anchor.z, NORTH)
    const drill = tools.ai ? undefined : "idle" as const
    const boss = withBoss.get() ? { x: anchor.x, z: anchor.z - Math.max(radius.get(), Tuning.radiusOf(zone.boss) + 2) } : null
    if (boss !== null) game.spawn(zone.boss, boss.x, boss.z, { facing: Math.PI / 2, drill })
    ringAround(anchor, count.get(), radius.get()).forEach((spot, index) => {
      if (boss !== null && Math.hypot(spot.x - boss.x, spot.z - boss.z) < Tuning.radiusOf(zone.boss) + BOSS_GAP + 0.6) return
      const each = chosen() ?? zone.roster[index % zone.roster.length] ?? "chaser"
      game.spawn(each, spot.x, spot.z, { facing: facingTo(spot, anchor), drill })
    })
    tools.frame({ x: anchor.x, z: anchor.z - (boss === null ? 0 : 0.8), radius: radius.get() + (boss === null ? 2.5 : 3.5) })

    const fire = () => {
      beat.index = 0
      game.special()
    }

    tools.on("specialStarted", () => {
      beat.fired += 1
      beat.index = 0
      beat.targets = 0
      struck.clear()
      killed.clear()
    })
    tools.on("specialHit", (moment) => {
      beat.index = moment.index
      beat.count = moment.count
      beat.targets = moment.targets.length
      for (const target of moment.targets) {
        struck.add(target.id)
        if (target.killed) killed.add(target.id)
      }
    })
    tools.on("specialEnded", () => {
      endedAt = tools.context.game.view().tempo.playStep
    })

    return {
      controls: [
        { kind: "action", label: "Fire KUZUSHI", run: fire },
        { kind: "toggle", label: "Loop", get: loop.get, set: loop.set },
        { kind: "action", label: "New ring", run: tools.replay },
        { kind: "toggle", label: "With boss", get: withBoss.get, set: (on) => {
          withBoss.set(on)
          changed.touch()
        } },
        ...(boss === null ? [] : [{ kind: "action" as const, label: "Break the boss", run: game.breakBoss }]),
        {
          kind: "choice",
          label: "Kind",
          options: [{ value: "mixed", label: "Mixed" }, ...choices],
          get: () => chosen() ?? "mixed",
          set: (value) => {
            kind.set(value)
            changed.touch()
          }
        },
        { kind: "range", label: "Enemies", min: 1, max: 12, step: 1, get: count.get, set: (value) => {
          count.set(value)
          changed.touch()
        }, format: (value) => `${value}` },
        { kind: "range", label: "Ring radius", min: 2, max: 8, step: 0.5, get: radius.get, set: (value) => {
          radius.set(value)
          changed.touch()
        }, format: (value) => `${value.toFixed(1)} u` }
      ],
      update: (view) => {
        if (changed.due()) {
          tools.replay()
          return
        }
        const settled = view.enemies.every((enemy) => enemy.state !== "Spawning") && view.player?.state === "Free" && view.tempo.slowScale === 1
        if (!loop.get() || !settled) return
        if (beat.fired === 0) {
          fire()
          return
        }
        if (endedAt !== null && view.tempo.playStep - endedAt >= REST_STEPS) {
          endedAt = null
          tools.replay()
        }
      },
      readouts: (view) => [
        { label: "Beat", value: view.player?.state === "Special" ? `${beat.index} / ${beat.count}` : beat.fired === 0 ? "Ready" : "Done", hot: view.player?.state === "Special" },
        { label: "Struck", value: `${beat.targets} this beat · ${struck.size} in all` },
        { label: "Kills", value: `${killed.size} of ${struck.size > 0 ? struck.size : inReach(view)}` },
        { label: "Reach", value: `${Tuning.SPECIAL.radius} u · ${Tuning.SPECIAL.hits} beats ${Tuning.SPECIAL.interval.steps} f apart` },
        ...(view.boss === null ? [] : [{
          label: "Boss",
          value: `${NAMES[view.boss.boss]} ${Math.round(view.boss.hp)}/${view.boss.maxHp} · ${view.boss.state}${view.boss.state === "broken" ? " · special ×2" : ""}`,
          hot: view.boss.state === "broken"
        }])
      ],
      draw: (sketch, view) => {
        if (view.player !== null) sketch.circle(view.player.x, view.player.z, Tuning.SPECIAL.radius, { ...INK.redFaint, alpha: 0.3 })
      }
    }
  }
}
