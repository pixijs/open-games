import { Clock } from "@typeonce/ritmo"

import { BOSSES } from "../bosses.ts"
import { Boss, Drill, EnemyState, Game, Health, Intents, Twin } from "../schema.ts"
import { playing } from "../tempo.ts"
import { PlayTime, step } from "../time.ts"
import { BOSS } from "../tuning.ts"

/**
 * The debug hooks for the room's boss, during a run: take it to the start of a phase (its health set to that phase's
 * threshold, so the shift plays; a drill, which never shifts, takes the phase at once), fill its balance so it breaks, make it play a pattern next, or set its health.
 */
export const BossDebug = Game.System("Game/BossDebug", {
  when: [playing],
  resources: { play: Game.System.readResource(PlayTime) },
  events: { intents: Game.System.readEvent(Intents) },
  queries: {
    bosses: Game.Query({
      selection: { boss: Game.Query.write(Boss), health: Game.Query.write(Health), state: Game.Query.write(EnemyState), drill: Game.Query.optional(Drill) },
      without: [Twin]
    })
  }
}, ({ resources, events, queries }) => {
  const play = resources.play.get()
  const { data } = queries.bosses
  const entity = queries.bosses.each()[0]
  if (entity === undefined) return
  for (const intent of events.intents.all()) {
    const boss = data.boss.get(entity)
    const health = data.health.get(entity)
    switch (intent.type) {
      case "bossPhase": {
        const phases = BOSSES[boss.boss].phases
        const phase = Math.min(phases.length, Math.max(1, Math.round(intent.phase)))
        const from = phases[phase - 1]?.from ?? 1
        const drilled = data.drill.get(entity) !== undefined
        data.boss.set(entity, { ...boss, phase: drilled ? phase : Math.max(1, phase - 1), cursor: 0 })
        data.health.set(entity, { ...health, hp: Math.round(from * health.max) })
        break
      }
      case "breakBoss":
        data.boss.set(entity, { ...boss, balance: BOSS.balance.max })
        break
      case "bossPattern": {
        data.boss.set(entity, { ...boss, forced: intent.pattern })
        const state = data.state.get(entity)
        if (state._tag === "Move") data.state.update(entity, { state: "Move", data: (move) => ({ ...move, attackAt: Clock.deadline(play, Clock.durationOfSteps(step, 1)) }) })
        break
      }
      case "bossHealth":
        data.health.set(entity, { ...health, hp: Math.min(health.max, Math.max(1, Math.round(intent.hp))) })
        break
      default:
        break
    }
  }
})
