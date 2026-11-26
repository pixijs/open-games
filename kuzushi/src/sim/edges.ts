import { Clock } from "@typeonce/ritmo"
import { Vec2 } from "@typeonce/ritmo-math"

import { normalize } from "./geometry.ts"
import { groundOf } from "./ground.ts"
import { Actor, Body, CurrentStage, Drill, enemyKindOf, EnemyState, gainFocus, Game, Hazard, Health, Moments, Motion, Run, Tempo, Waves } from "./schema.ts"
import { hitStopMoment, withHitStop } from "./tempo.ts"
import { PlayTime, secondsOf, Time } from "./time.ts"
import { FOCUS, HIT_STOP, isBoss, RING_OUT } from "./tuning.ts"
import { allSpawned } from "./waves.ts"

/**
 * Ring-outs: an enemy whose centre leaves the floor (The Void's edges, or a slab falling under it) is dead at once
 * and falls, drifting on its momentum, until it is gone. It counts as a kill, and a splitter falls whole. Dummies
 * from the debug hooks stay where they were put.
 */
export const RingOuts = Game.System("Game/RingOuts", {
  resources: {
    play: Game.System.readResource(PlayTime),
    time: Game.System.readResource(Time),
    run: Game.System.writeResource(Run),
    tempo: Game.System.writeResource(Tempo),
    waves: Game.System.readResource(Waves),
    stage: Game.System.readResource(CurrentStage),
    hazard: Game.System.readResource(Hazard)
  },
  queries: {
    enemies: Game.Query({
      selection: {
        actor: Game.Query.read(Actor),
        body: Game.Query.write(Body),
        motion: Game.Query.write(Motion),
        health: Game.Query.write(Health),
        state: Game.Query.write(EnemyState),
        drill: Game.Query.optional(Drill)
      }
    })
  },
  events: { moments: Game.System.writeEvent(Moments) },
  commands: Game.System.commands(Game.System.despawns(Actor))
}, ({ resources, queries, events, commands }) => {
  const play = resources.play.get()
  const time = resources.time.get()
  const current = resources.stage.get()
  const terrain = groundOf(current, resources.hazard.get())
  const { data } = queries.enemies
  const waves = resources.waves.get()
  const lastSpawned = allSpawned(waves)
  let alive = queries.enemies.each().filter((enemy) => data.health.get(enemy).hp > 0).length

  for (const enemy of queries.enemies.each()) {
    const kind = enemyKindOf(data.actor.get(enemy).kind)
    if (kind === undefined || isBoss(kind)) continue
    const state = data.state.get(enemy)
    const body = data.body.get(enemy)
    const motion = data.motion.get(enemy)

    if (state._tag === "Falling") {
      if (Clock.reached(play, state.endAt)) {
        commands.despawn(enemy)
        continue
      }
      data.body.set(enemy, { ...body, x: body.x + motion.vx * play.dt, z: body.z + motion.vz * play.dt })
      const fade = Vec2.decayToward({ x: motion.vx, y: motion.vz }, Vec2.zero, RING_OUT.driftDecay, play.dt)
      data.motion.set(enemy, { vx: fade.x, vz: fade.y })
      continue
    }

    const health = data.health.get(enemy)
    if (health.hp <= 0 || state._tag === "Blink" || state._tag === "Leap" || data.drill.get(enemy)?.mode === "dummy" || terrain.onFloor(body.x, body.z)) continue

    data.state.transition(enemy, { from: state._tag, to: "Falling", data: { endAt: Clock.deadline(play, RING_OUT.fall) } })
    data.health.set(enemy, { ...health, hp: 0 })
    alive -= 1
    const dir = normalize(motion.vx, motion.vz, normalize(body.x, body.z, { x: 0, z: 1 }))
    const run = resources.run.get()
    const gained = gainFocus(run, FOCUS.kill)
    resources.run.set({ ...gained.run, kills: run.kills + 1 })
    if (gained.filled) events.moments.emit({ type: "focusFull" })
    resources.tempo.update((tempo) => withHitStop(tempo, time, HIT_STOP.kill))
    events.moments.emit(hitStopMoment(HIT_STOP.kill))
    events.moments.emit({ type: "ringOut", id: enemy.id, kind, x: body.x, z: body.z, dirX: dir.x, dirZ: dir.z, duration: secondsOf(RING_OUT.fall) })
    events.moments.emit({ type: "enemyKilled", id: enemy.id, kind, x: body.x, z: body.z, dirX: dir.x, dirZ: dir.z, source: "ringOut", lastOfWave: lastSpawned && alive === 0 })
  }
})
