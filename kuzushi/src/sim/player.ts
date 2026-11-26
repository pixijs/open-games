import { Clock } from "@typeonce/ritmo"
import { Vec2 } from "@typeonce/ritmo-math"

import { move } from "./arena.ts"
import { castSpot, slamTarget } from "./arsenal/aim.ts"
import { dartDraft } from "./arsenal/darts.ts"
import { arcShape } from "./arsenal/shapes.ts"
import { angleOf, dirOf, lengthOf, normalize } from "./geometry.ts"
import type { Dir } from "./geometry.ts"
import { groundOf } from "./ground.ts"
import type { ComboStep, PlayerAction } from "./moments.ts"
import { Actor, Aim, Body, Buffer, CurrentStage, Dart, Flow, Game, Hazard, Input, Loadout, Moments, Motion, Moves, PlayerState, PrevBody, Run, Steer, Trigger, Vitals } from "./schema.ts"
import type { BodyValue, PlayerStateValue } from "./schema.ts"
import { playing } from "./tempo.ts"
import { after, inSteps, PlayTime, secondsOf, Time } from "./time.ts"
import { BUFFER, DARTS, DASH, MOVE, PARRY, PLAYER, SIGIL, WEAPON } from "./tuning.ts"
import type { MoveFrames } from "./tuning.ts"
import { chainLength, moveAt, weaponOfMove } from "./weapons.ts"
import type { Mark, WeaponId } from "./weapons.ts"

/** Keeps the latest pressed action for a moment, so a press during hit-stop or an attack still lands. */
export const BufferInput = Game.System("Game/BufferInput", {
  when: [playing],
  resources: {
    input: Game.System.readResource(Input),
    time: Game.System.readResource(Time),
    buffer: Game.System.writeResource(Buffer)
  }
}, ({ resources }) => {
  const { actions } = resources.input.get()
  const time = resources.time.get()
  const pressed: PlayerAction | null = actions.special.pressed ? "special"
    : actions.dash.pressed ? "dash"
    : actions.parry.pressed ? "parry"
    : actions.slash.pressed ? "slash"
    : null
  const buffer = resources.buffer.get()
  if (pressed !== null) resources.buffer.set({ _tag: "Held", action: pressed, until: Clock.deadline(time, BUFFER.time) })
  else if (buffer._tag === "Held" && Clock.reached(time, buffer.until)) resources.buffer.set({ _tag: "Empty" })
})

const ready = (time: Clock.Time<60>, at: Clock.Deadline<60> | null): boolean => at === null || Clock.reached(time, at)

/** The chain step after `step` in a chain `length` long: the start again after its last. */
const following = (step: ComboStep, length: number): ComboStep => step >= length ? 1 : step === 1 ? 2 : 3

/** The deadlines of a move started now: its active frames, its recovery, its combo's cancel window and its end. */
const framesOf = (play: Clock.Time<60>, spec: MoveFrames) => ({
  activeAt: after(play, spec.windup),
  recoverAt: after(play, spec.windup, spec.active),
  cancelAt: after(play, spec.windup, spec.active, spec.cancel),
  endAt: after(play, spec.windup, spec.active, spec.recover)
})

/** The weapon an attacking state swings. */
const wielding = (state: Extract<PlayerStateValue, { readonly _tag: "Attack" | "Slam" | "Charge" }>): WeaponId =>
  state._tag === "Attack" ? weaponOfMove(state.move) : state._tag === "Slam" ? "breaker" : "darts"

/**
 * The player's verbs on the gameplay clock: run, the weapon in hand's chain of moves (the blade's three cuts, the
 * breaker's cleave and hopping slam, darts and the held pierce, sigils), the dash and the parry, inside the floor's
 * walls and edges. Each move fires as its active frames start: a sweep, a dart from the tip, a sigil placed at the
 * aim. Movement numbers come from `Moves`; a held `Steer` stands in for the stick and a held `Trigger` for the attack
 * button. The special, taking hits and every hit the player lands live in their own systems.
 */
export const PlayerControl = Game.System("Game/PlayerControl", {
  resources: {
    input: Game.System.readResource(Input),
    aim: Game.System.readResource(Aim),
    play: Game.System.readResource(PlayTime),
    buffer: Game.System.writeResource(Buffer),
    run: Game.System.writeResource(Run),
    stage: Game.System.readResource(CurrentStage),
    hazard: Game.System.readResource(Hazard),
    moves: Game.System.readResource(Moves),
    steer: Game.System.readResource(Steer),
    trigger: Game.System.readResource(Trigger),
    loadout: Game.System.writeResource(Loadout)
  },
  queries: {
    players: Game.Query({
      selection: {
        body: Game.Query.write(Body),
        motion: Game.Query.write(Motion),
        state: Game.Query.write(PlayerState),
        vitals: Game.Query.write(Vitals)
      }
    })
  },
  events: { moments: Game.System.writeEvent(Moments) },
  commands: Game.System.commands(Game.System.spawns(Actor, Body, PrevBody, Dart))
}, ({ resources, queries, events, commands }) => {
  const play = resources.play.get()
  const dt = play.dt
  const aim = resources.aim.get()
  const held = resources.steer.get()
  const stick = held._tag === "Held" ? { x: held.x, y: held.z } : resources.input.get().vectors.move
  const trigger = resources.trigger.get()
  const holding = resources.input.get().actions.slash.held || (trigger._tag === "Held" && !Clock.reached(play, trigger.until))
  const moves = resources.moves.get()
  const terrain = groundOf(resources.stage.get(), resources.hazard.get())
  const walls = terrain.bounded
  const { data } = queries.players

  const consume = (action: PlayerAction): boolean => {
    const buffer = resources.buffer.get()
    if (buffer._tag !== "Held" || buffer.action !== action) return false
    resources.buffer.set({ _tag: "Empty" })
    return true
  }
  const buffered = (action: PlayerAction): boolean => {
    const buffer = resources.buffer.get()
    return buffer._tag === "Held" && buffer.action === action
  }

  const aimFacing = (body: BodyValue): number | null => {
    if (aim._tag !== "Point") return null
    const dx = aim.x - body.x
    const dz = aim.z - body.z
    return lengthOf(dx, dz) > 0.2 ? angleOf(dx, dz) : null
  }

  /** Runs toward the stick at `factor` of full speed, sliding along walls, and turns to the aim or the run. */
  const steer = (body: BodyValue, entityMotion: { vx: number; vz: number }, factor: number, turn: boolean) => {
    const target = { x: stick.x * moves.speed * factor, y: stick.y * moves.speed * factor }
    const current = { x: entityMotion.vx, y: entityMotion.vz }
    const rate = Vec2.lengthSquared(target) > 0 ? moves.acceleration : moves.deceleration
    const velocity = Vec2.moveToward(current, target, rate * dt)
    const moved = move(walls, body.x, body.z, velocity.x * dt, velocity.y * dt, PLAYER.radius)
    const running = lengthOf(stick.x, stick.y) > 0.1 ? angleOf(stick.x, stick.y) : null
    const facing = turn ? aimFacing(body) ?? running ?? body.facing : body.facing
    return { body: { x: moved.x, z: moved.z, facing }, motion: { vx: velocity.x, vz: velocity.y } }
  }

  /** The next attack's number, counted through the run, so each names itself to the enemies it hits. */
  const nextSwing = (): number => {
    const swing = resources.run.get().swings + 1
    resources.run.update((run) => ({ ...run, swings: swing }))
    return swing
  }

  for (const entity of queries.players.each()) {
    const state = data.state.get(entity)
    const body = data.body.get(entity)
    const vitals = data.vitals.get(entity)
    const hand = resources.loadout.get()

    if ((state._tag === "Attack" || state._tag === "Slam" || state._tag === "Charge") && wielding(state) !== hand.weapon) {
      data.state.transition(entity, { from: state._tag, to: "Free" })
      data.vitals.set(entity, { ...vitals, comboNext: 1, comboUntil: null })
      continue
    }

    const facingDir = (): Dir => dirOf(aimFacing(body) ?? body.facing)

    const dashData = () => {
      const dir = lengthOf(stick.x, stick.y) > 0.1 ? normalize(stick.x, stick.y, dirOf(body.facing)) : dirOf(body.facing)
      events.moments.emit({ type: "dashStarted", x: body.x, z: body.z, dirX: dir.x, dirZ: dir.z })
      if (hand.weapon === "darts" && hand.loaded < DARTS.clip) {
        resources.loadout.set({ ...hand, loaded: DARTS.clip, reloadAt: null })
        events.moments.emit({ type: "reloaded", loaded: DARTS.clip, size: DARTS.clip, dash: true })
      }
      return { dirX: dir.x, dirZ: dir.z, endAt: Clock.deadline(play, inSteps(moves.dashSteps)), nearMiss: false }
    }

    const canDash = ready(play, vitals.dashReadyAt)
    const nextStep = (): ComboStep => vitals.comboUntil !== null && !Clock.reached(play, vitals.comboUntil) ? vitals.comboNext : 1

    /** Whether press `step` of the chain can start now: darts need their ammo loaded, a sigil a free mark. */
    const canStart = (step: ComboStep): boolean => {
      const spec = MOVE[moveAt(hand.weapon, step)]
      if (spec.kind === "shot") return hand.loaded >= spec.ammo
      if (spec.kind === "cast") return hand.marks.length < SIGIL.most
      return true
    }

    /** Press `step` of the chain, from Free or from the move before it, turned to the aim. */
    const begin = (from: "Free" | "Attack", step: ComboStep) => {
      const chosen = moveAt(hand.weapon, step)
      const swing = nextSwing()
      const dir = facingDir()
      data.body.set(entity, { ...body, facing: angleOf(dir.x, dir.z) })
      if (chosen === "slam") {
        const spec = MOVE.slam
        const to = slamTarget(terrain, body, dir, aim)
        const { activeAt, recoverAt, endAt } = framesOf(play, spec)
        const slam = {
          swing,
          dirX: dir.x,
          dirZ: dir.z,
          fromX: body.x,
          fromZ: body.z,
          toX: to.x,
          toZ: to.z,
          activeAt,
          recoverAt,
          endAt
        }
        if (from === "Free") data.state.transition(entity, { from: "Free", to: "Slam", data: slam })
        else data.state.transition(entity, { from: "Attack", to: "Slam", data: slam })
        events.moments.emit({ type: "marked", weapon: "breaker", move: "slam", mark: swing, x: to.x, z: to.z, radius: spec.radius, delay: secondsOf(spec.windup) })
        return
      }
      const spec = MOVE[chosen]
      const attack = { move: chosen, step, swing, dirX: dir.x, dirZ: dir.z, ...framesOf(play, spec) }
      if (from === "Free") data.state.transition(entity, { from: "Free", to: "Attack", data: attack })
      else data.state.transition(entity, { from: "Attack", to: "Attack", data: attack })
    }

    /** A dart (or the pierce) leaves the hero's tip along the aim, spending its ammo and putting reloading back. */
    const shoot = (dart: "dart" | "pierce", swing: number, perfect: boolean) => {
      const spec = MOVE[dart]
      const dir = facingDir()
      const x = body.x + dir.x * DARTS.muzzle
      const z = body.z + dir.z * DARTS.muzzle
      const damage = spec.damage + (perfect ? DARTS.perfectDamage : 0)
      const id = commands.spawn(dartDraft(dart, x, z, dir, damage, perfect, swing, play))
      resources.loadout.set({ ...hand, loaded: Math.max(0, hand.loaded - spec.ammo), reloadAt: Clock.deadline(play, DARTS.reloadAfter) })
      events.moments.emit({ type: "shot", id, x, z, dirX: dir.x, dirZ: dir.z, speed: spec.speed, pierce: dart === "pierce", perfect })
      events.moments.emit({
        type: "attack",
        weapon: "darts",
        move: dart,
        step: 1,
        shape: { kind: "line", x, z, dirX: dir.x, dirZ: dir.z, length: spec.reach, halfWidth: spec.radius },
        duration: spec.reach / spec.speed,
        charged: dart === "pierce"
      })
      return angleOf(dir.x, dir.z)
    }

    /** A move's active frames start: a sweep goes live, a dart flies, a sigil is placed at the aim. */
    const fire = (attack: PlayerStateValue & { readonly _tag: "Attack" }) => {
      const spec = MOVE[attack.move]
      const weapon = weaponOfMove(attack.move)
      switch (spec.kind) {
        case "arc": {
          const shape = arcShape(attack.move, body, attack.dirX, attack.dirZ)
          if (shape === null || shape.kind !== "arc") return
          if (weapon === "blade") {
            events.moments.emit({ type: "slash", step: attack.step, x: body.x, z: body.z, facing: shape.facing, range: spec.range, halfAngle: spec.halfAngle, sweep: spec.sweep, duration: secondsOf(spec.active) })
          }
          events.moments.emit({ type: "attack", weapon, move: attack.move, step: attack.step, shape, duration: secondsOf(spec.active), charged: false })
          return
        }
        case "shot": {
          if (attack.move !== "dart") return
          data.body.set(entity, { ...body, facing: shoot("dart", attack.swing, false) })
          return
        }
        case "cast": {
          const cast: Mark["move"] = attack.move === "seal" ? "seal" : "sigil"
          const spot = castSpot(terrain, body, facingDir(), aim, spec.radius)
          const mark = { id: attack.swing, move: cast, x: spot.x, z: spot.z, radius: spec.radius, landAt: Clock.deadline(play, spec.delay), steps: Clock.steps(spec.delay) }
          resources.loadout.set({ ...hand, marks: [...hand.marks, mark] })
          data.vitals.set(entity, { ...vitals, comboNext: following(attack.step, chainLength("sigil")), comboUntil: Clock.deadline(play, WEAPON.sigil.grace) })
          const delay = secondsOf(spec.delay)
          events.moments.emit({ type: "marked", weapon: "sigil", move: cast, mark: attack.swing, x: spot.x, z: spot.z, radius: spec.radius, delay })
          events.moments.emit({ type: "attack", weapon: "sigil", move: cast, step: attack.step, shape: { kind: "circle", x: spot.x, z: spot.z, radius: spec.radius }, duration: delay, charged: false })
          return
        }
        case "slam":
          return
      }
    }

    switch (state._tag) {
      case "Free": {
        if (buffered("dash") && canDash) {
          consume("dash")
          data.state.transition(entity, { from: "Free", to: "Dash", data: dashData() })
        } else if (buffered("parry") && ready(play, vitals.parryReadyAt)) {
          consume("parry")
          data.state.transition(entity, { from: "Free", to: "Parry", data: { windowEnd: Clock.deadline(play, PARRY.window), endAt: Clock.deadline(play, PARRY.time) } })
          data.vitals.set(entity, { ...vitals, parryReadyAt: Clock.deadline(play, PARRY.cooldown) })
          events.moments.emit({ type: "parryStarted", x: body.x, z: body.z, facing: aimFacing(body) ?? body.facing })
        } else if (buffered("slash") && canStart(nextStep())) {
          consume("slash")
          begin("Free", nextStep())
        } else {
          const next = steer(body, data.motion.get(entity), 1, true)
          data.body.set(entity, next.body)
          data.motion.set(entity, next.motion)
        }
        break
      }
      case "Attack": {
        const spec = MOVE[state.move]
        const weapon = weaponOfMove(state.move)
        if (buffered("dash") && canDash) {
          consume("dash")
          data.state.transition(entity, { from: "Attack", to: "Dash", data: dashData() })
          break
        }
        if (Clock.reached(play, state.endAt) && state.move === "dart" && holding && hand.loaded >= DARTS.chargeNeeds) {
          data.state.transition(entity, { from: "Attack", to: "Charge", data: { fullAt: after(play, DARTS.charge), perfectUntil: after(play, DARTS.charge, DARTS.perfect) } })
          break
        }
        const length = chainLength(weapon)
        const next = state.step < length ? following(state.step, length) : length === 1 ? 1 : null
        if (next !== null && Clock.reached(play, state.cancelAt) && buffered("slash") && canStart(next)) {
          consume("slash")
          begin("Attack", next)
          break
        }
        if (Clock.reached(play, state.endAt)) {
          data.state.transition(entity, { from: "Attack", to: "Free" })
          if (spec.kind !== "cast") data.vitals.set(entity, { ...vitals, comboNext: following(state.step, length), comboUntil: Clock.deadline(play, WEAPON[weapon].grace) })
          break
        }
        if (play.step === state.activeAt) fire(state)
        const placed = data.body.get(entity)
        const active = Clock.reached(play, state.activeAt) && !Clock.reached(play, state.recoverAt)
        switch (spec.kind) {
          case "arc": {
            const next = steer(placed, data.motion.get(entity), WEAPON[weapon].moveFactor, false)
            const lunge = active ? spec.lunge * dt : 0
            const lunged = move(walls, next.body.x, next.body.z, state.dirX * lunge, state.dirZ * lunge, PLAYER.radius)
            data.body.set(entity, { x: lunged.x, z: lunged.z, facing: angleOf(state.dirX, state.dirZ) })
            data.motion.set(entity, next.motion)
            break
          }
          case "cast": {
            const cast = Clock.reached(play, state.activeAt)
            const next = steer(placed, data.motion.get(entity), cast ? 1 : WEAPON.sigil.moveFactor, cast)
            data.body.set(entity, next.body)
            data.motion.set(entity, next.motion)
            break
          }
          case "shot":
          case "slam": {
            const next = steer(placed, data.motion.get(entity), WEAPON.darts.moveFactor, true)
            data.body.set(entity, next.body)
            data.motion.set(entity, next.motion)
            break
          }
        }
        break
      }
      case "Slam": {
        const windup = !Clock.reached(play, state.activeAt)
        if (windup && buffered("dash") && canDash) {
          consume("dash")
          data.state.transition(entity, { from: "Slam", to: "Dash", data: dashData() })
          break
        }
        if (Clock.reached(play, state.endAt)) {
          data.state.transition(entity, { from: "Slam", to: "Free" })
          data.vitals.set(entity, { ...vitals, comboNext: 1, comboUntil: Clock.deadline(play, WEAPON.breaker.grace) })
          break
        }
        const facing = angleOf(state.dirX, state.dirZ)
        if (windup) {
          const total = Clock.steps(MOVE.slam.windup)
          const through = Math.min(1, (total - Clock.remaining(play, state.activeAt) + 1) / total)
          const x = state.fromX + (state.toX - state.fromX) * through
          const z = state.fromZ + (state.toZ - state.fromZ) * through
          const hopped = move(walls, body.x, body.z, x - body.x, z - body.z, PLAYER.radius)
          data.body.set(entity, { x: hopped.x, z: hopped.z, facing })
          data.motion.set(entity, { vx: 0, vz: 0 })
          break
        }
        if (play.step === state.activeAt) {
          events.moments.emit({
            type: "attack",
            weapon: "breaker",
            move: "slam",
            step: 2,
            shape: { kind: "circle", x: body.x, z: body.z, radius: MOVE.slam.radius },
            duration: secondsOf(MOVE.slam.active),
            charged: false
          })
        }
        const next = steer(body, data.motion.get(entity), WEAPON.breaker.moveFactor, false)
        data.body.set(entity, { ...next.body, facing })
        data.motion.set(entity, next.motion)
        break
      }
      case "Charge": {
        if (buffered("dash") && canDash) {
          consume("dash")
          data.state.transition(entity, { from: "Charge", to: "Dash", data: dashData() })
          break
        }
        if (!holding) {
          if (!Clock.reached(play, state.fullAt) || hand.loaded < MOVE.pierce.ammo) {
            data.state.transition(entity, { from: "Charge", to: "Free" })
            break
          }
          const swing = nextSwing()
          const facing = shoot("pierce", swing, !Clock.reached(play, state.perfectUntil))
          const dir = dirOf(facing)
          data.state.transition(entity, {
            from: "Charge",
            to: "Attack",
            data: { move: "pierce", step: 1, swing, dirX: dir.x, dirZ: dir.z, ...framesOf(play, MOVE.pierce) }
          })
          data.body.set(entity, { ...body, facing })
          break
        }
        if (play.step === state.fullAt) events.moments.emit({ type: "charged", x: body.x, z: body.z, facing: body.facing })
        const next = steer(body, data.motion.get(entity), DARTS.chargeFactor, true)
        data.body.set(entity, next.body)
        data.motion.set(entity, next.motion)
        break
      }
      case "Dash": {
        const moved = move(walls, body.x, body.z, state.dirX * moves.dashSpeed * dt, state.dirZ * moves.dashSpeed * dt, PLAYER.radius)
        data.body.set(entity, { x: moved.x, z: moved.z, facing: angleOf(state.dirX, state.dirZ) })
        if (!Clock.reached(play, state.endAt)) break
        data.state.transition(entity, { from: "Dash", to: "Free" })
        data.vitals.set(entity, {
          ...vitals,
          invulnerableUntil: Clock.deadline(play, DASH.afterglow),
          dashReadyAt: Clock.deadline(play, DASH.cooldown)
        })
        data.motion.set(entity, { vx: state.dirX * moves.speed, vz: state.dirZ * moves.speed })
        events.moments.emit({ type: "dashEnded", x: moved.x, z: moved.z })
        break
      }
      case "Parry": {
        if (buffered("dash") && canDash) {
          consume("dash")
          data.state.transition(entity, { from: "Parry", to: "Dash", data: dashData() })
          break
        }
        if (Clock.reached(play, state.endAt)) {
          data.state.transition(entity, { from: "Parry", to: "Free" })
          break
        }
        const next = steer(body, data.motion.get(entity), PLAYER.attackMoveFactor, true)
        data.body.set(entity, next.body)
        data.motion.set(entity, next.motion)
        break
      }
      case "Special":
      case "Down":
        break
    }
  }
})

/** After the player goes down, the beat on the run clock before the game over screen. */
export const Defeat = Game.System("Game/Defeat", {
  when: [playing],
  resources: { time: Game.System.readResource(Time), run: Game.System.writeResource(Run), stage: Game.System.readResource(CurrentStage) },
  queries: { players: Game.Query({ selection: { state: Game.Query.read(PlayerState) } }) },
  nextMachines: { flow: Game.System.nextState(Flow) },
  events: { moments: Game.System.writeEvent(Moments) }
}, ({ resources, queries, nextMachines, events }) => {
  const time = resources.time.get()
  for (const entity of queries.players.each()) {
    const state = queries.players.data.state.get(entity)
    if (state._tag !== "Down" || !Clock.reached(time, state.until)) continue
    const run = resources.run.get()
    const stage = resources.stage.get()
    resources.run.set({ ...run, endedAt: time.step })
    nextMachines.flow.transition({ from: "Playing", to: "GameOver" })
    events.moments.emit({ type: "gameOver", zone: stage.id, room: stage.room?.index ?? null, time: (time.step - run.startedAt) / time.hz, kills: run.kills, rooms: run.rooms })
  }
})
