import { gsap } from "gsap"

import type { FrameControls } from "../art/frame.ts"
import type { ShotName } from "../camera/rig.ts"
import type { WarmupReport } from "../gpu/warmup.ts"
import type { BossPattern, BossView, ComboStep, DrillMode, EnemyKind, GameView, PlayerAction, PlayerMoves, RoomKind, StageId, WeaponId, WeaponMove, ZoneId } from "../sim/index.ts"
import type { HostControls, LateCompiles } from "./host.ts"

/** A compact summary of the game for scripts and logs. */
export interface DebugState {
  readonly flow: GameView["flow"]
  readonly zone: ZoneId
  /** The room the player is in, by index and kind, its map state and whether its seals are shut, or null outside a dungeon. */
  readonly room: { readonly index: number; readonly kind: RoomKind; readonly state: string; readonly sealed: boolean } | null
  /** The transition playing, by kind and beat, or null. */
  readonly transition: { readonly kind: string; readonly beat: string; readonly swapped: boolean } | null
  readonly weapon: WeaponId
  readonly boss: Pick<BossView, "boss" | "hp" | "phase" | "state" | "balance" | "pattern"> | null
  readonly wave: GameView["wave"]
  readonly lives: number
  readonly focus: number
  readonly timer: number
  readonly kills: number
  readonly seed: number
  readonly tempo: GameView["tempo"]
  readonly player: { readonly x: number; readonly z: number; readonly state: string; readonly move: WeaponMove | null; readonly step: number } | null
  readonly enemies: ReadonlyArray<{ readonly id: number; readonly kind: EnemyKind; readonly state: string; readonly hp: number; readonly x: number; readonly z: number; readonly drill: DrillMode | null }>
  readonly projectiles: number
  readonly shot: ShotName
  readonly liveShot: string | null
  readonly frozen: boolean
}

/** `window.__game`: drive the game from screenshot scripts, tests in the browser, and the console. It lands once loading ends. */
export interface DebugApi {
  readonly ready: true
  /** Starts a run of The Courtyard's dungeon (`wave` 0: its sandbox, the classic arena with no fights), with the seed set by `setSeed` unless given. */
  start(wave?: number, seed?: number): void
  /** Starts a run of `stage`'s zone, its dungeon (`wave` 0: its sandbox), with the seed set by `setSeed` unless given. */
  startStage(stage: StageId, wave?: number, seed?: number): void
  /**
   * Starts a run in `zone`, in its start room or in `room` (by index, or the first room of a kind such as "boss"),
   * holding `weapon` (the blade unless given), with the seed set by `setSeed` unless given.
   */
  startZone(zone: ZoneId, room?: number | RoomKind, options?: { readonly seed?: number; readonly weapon?: WeaponId }): void
  /**
   * Goes through to room `room` of the zone (by index, or the first room of a kind: "boss" skips to the boss room) with
   * a door's transition, or at once with `instant`.
   */
  enterRoom(room: number | RoomKind, options?: { readonly instant?: boolean }): void
  /** Ends the room's fight as if its enemies fell (no kills): it clears and its doors open; a boss room's gate opens. */
  openDoors(): void
  /** Shuts the room's seals (default) or breaks them, leaving its fight alone. */
  lockDoors(locked?: boolean): void
  /** Shows every room of the zone on the map. */
  revealMap(): void
  /** Marks every other room of the zone cleared: walking into one never locks it, and the boss room's gate stands open. For the lab. */
  clearRooms(): void
  /** Presses the interact key once: takes the weapon on the altar the player stands by. */
  interact(): void
  /** Puts `weapon` in the player's hand. */
  setWeapon(weapon: WeaponId): void
  /** Sets the player's diamonds (1 to the most). */
  setLives(lives: number): void
  /** Takes the room's boss to the start of phase `phase`. */
  bossPhase(phase: number): void
  /** Fills the room's boss's balance: it breaks open. */
  breakBoss(): void
  /** Makes the room's boss play `pattern` next, at once if it is resting. */
  bossPattern(pattern: BossPattern): void
  /** Sets the room's boss's health; crossing a threshold plays that phase's shift. */
  bossHealth(hp: number): void
  pause(): void
  resume(): void
  restart(): void
  quit(): void
  /** Fills FOCUS. */
  grantFocus(): void
  /** Fills FOCUS and fires KUZUSHI. */
  special(): void
  /**
   * Spawns an enemy at (x, z), or at a spawn point away from the player, facing `facing` (radians, 0 is +x) or the
   * player. `drill: "idle"` turns its AI off (it stands until `attack`); `"dummy"` also never dies and is never moved.
   * `elite` makes it an elite.
   */
  spawn(kind: EnemyKind, x?: number, z?: number, options?: { readonly facing?: number; readonly drill?: DrillMode; readonly elite?: boolean }): void
  /** Makes the enemy `id` (every enemy when left out) standing in Move start its attack now. */
  attack(id?: number): void
  /** The player takes no hits while on (default true). Lasts across runs. */
  invulnerable(on?: boolean): void
  /** Puts the player (or the enemy `id`) at (x, z), at rest, facing `facing` (radians) or as before. */
  teleport(x: number, z: number, facing?: number, id?: number): void
  /**
   * Presses attack (`slash`), dash, parry or special once, as a key press would; an attack with `step` plays that press
   * of the weapon's chain (the blade's 3 is its spin, the breaker's 2 its slam, the sigil's 3 a seal).
   */
  press(action: PlayerAction, step?: ComboStep): void
  /** Presses attack and holds it down for `seconds` of gameplay time: with darts, a dart and then the pierce's charge. */
  hold(seconds: number): void
  /** Removes the enemy `id` without a kill. */
  remove(id: number): void
  /** Lands a blow of `damage` on the enemy `id` as slash `step` (default 1) would: knockback, stagger or death. */
  blow(id: number, damage: number, step?: ComboStep): void
  /** Refills the player's lives. */
  heal(): void
  /** Swaps the stage's floor for the open floor (The Courtyard's size, no props) for this run, or back. */
  floor(open: boolean): void
  /** How fast time runs: 1 real time, down to 0.1 (simulation, visuals, camera and GSAP together). */
  speed(scale: number): void
  /** Whether Esc, P and Enter pause and confirm in the game (default true); the debug scenes take them while open. */
  flowKeys(on: boolean): void
  /** Holds a move direction (x right, z down the screen) as the stick would; `steer(0, 0)` lets go. A new run lets go too. */
  steer(x: number, z: number): void
  /** Overrides some of the player's movement numbers (dash time in seconds); `tune(null)` puts back tuning.ts. Lasts across runs. */
  tune(moves: Partial<PlayerMoves> | null): void
  /** Switches the stage hazard on or off for this run. */
  hazard(on: boolean): void
  /** The Spiral: starts the beam's telegraph now, then a sweep, even with the hazard off. */
  sweep(): void
  /** The Void: cracks the next slab group now; it falls after its telegraph, even with the hazard off. */
  collapse(): void
  /** Removes every enemy and orb: the wave then clears as if they were killed. */
  clearWave(): void
  /** Points the player at a ground point, as the mouse does. */
  aim(x: number, z: number): void
  /** Freezes the simulation, the visuals and GSAP for a still (`false` resumes). */
  freeze(on?: boolean): void
  /** While frozen: advances `steps` fixed steps, visuals in step. */
  step(steps?: number): void
  /** The seed of the next `start`. */
  setSeed(seed: number): void
  /** The whole-frame looks (impact frames, flashes, focus blur), to pose them for stills. */
  readonly frame: FrameControls
  /** Forces a camera shot for `seconds` (default 9999), or releases it with `null`. */
  camera(shot: ShotName | null, seconds?: number): void
  state(): DebugState
  view(): GameView
  /** Resolves `true` once `check(state())` holds (polled every frame), or `false` after `timeoutMs`. For screenshot steps. */
  until(check: (state: DebugState) => boolean, timeoutMs?: number): Promise<boolean>
  /** What compiled since loading ended, by kind and one by one with its program's label: nothing, but after a device change or in the lab. */
  compiles(): LateCompiles
  /** What loading uploaded and drew, step by step, and any pose still compiling when it gave up on it. */
  loadReport(): WarmupReport | null
}

declare global {
  interface Window {
    __game?: DebugApi
  }
}

export const installDebugApi = (host: HostControls): DebugApi => {
  const { context, intents } = host
  const api: DebugApi = {
    ready: true,
    start: intents.start,
    startStage: intents.startStage,
    startZone: (zone, room, options) =>
      intents.send({ type: "startZone", zone, room: room ?? null, seed: options?.seed ?? host.seed, weapon: options?.weapon ?? null }),
    enterRoom: (room, options) => intents.send({ type: "enterRoom", room, instant: options?.instant ?? null }),
    openDoors: () => intents.send({ type: "openDoors" }),
    lockDoors: (locked = true) => intents.send({ type: "lockDoors", locked }),
    revealMap: () => intents.send({ type: "revealMap" }),
    clearRooms: () => intents.send({ type: "clearRooms" }),
    interact: () => intents.send({ type: "interact" }),
    setWeapon: (weapon) => intents.send({ type: "setWeapon", weapon }),
    setLives: (lives) => intents.send({ type: "lives", lives }),
    bossPhase: (phase) => intents.send({ type: "bossPhase", phase }),
    breakBoss: () => intents.send({ type: "breakBoss" }),
    bossPattern: (pattern) => intents.send({ type: "bossPattern", pattern }),
    bossHealth: (hp) => intents.send({ type: "bossHealth", hp }),
    pause: intents.pause,
    resume: intents.resume,
    restart: intents.restart,
    quit: intents.quit,
    grantFocus: () => intents.send({ type: "grantFocus" }),
    special: () => intents.send({ type: "special" }),
    spawn: (kind, x, z, options) =>
      intents.send({ type: "spawn", kind, x: x ?? null, z: z ?? null, facing: options?.facing ?? null, drill: options?.drill ?? null, elite: options?.elite ?? null }),
    attack: (id) => intents.send({ type: "attack", id: id ?? null }),
    invulnerable: (on = true) => intents.send({ type: "invulnerable", on }),
    teleport: (x, z, facing, id) => intents.send({ type: "teleport", x, z, facing: facing ?? null, id: id ?? null }),
    press: (action, step) => intents.send({ type: "press", action, step: step ?? null }),
    hold: (seconds) => intents.send({ type: "hold", seconds }),
    remove: (id) => intents.send({ type: "remove", id }),
    blow: (id, damage, step = 1) => intents.send({ type: "blow", id, damage, step }),
    heal: () => intents.send({ type: "heal" }),
    floor: (open) => intents.send({ type: "floor", open }),
    flowKeys: (on) => {
      host.flowKeys = on
    },
    speed: (scale) => {
      host.timeScale = scale
      gsap.globalTimeline.timeScale(Math.max(0.01, scale))
    },
    steer: (x, z) => intents.send({ type: "steer", x, z }),
    tune: (moves) => intents.send({ type: "tune", moves }),
    hazard: (on) => intents.send({ type: "hazard", on }),
    sweep: () => intents.send({ type: "sweep" }),
    collapse: () => intents.send({ type: "collapse" }),
    clearWave: () => intents.send({ type: "clearWave" }),
    aim: (x, z) => intents.send({ type: "aim", x, z }),
    freeze: (on = true) => {
      host.freeze(on)
      if (on) gsap.globalTimeline.pause()
      else gsap.globalTimeline.resume()
    },
    step: (steps = 1) => host.step(steps),
    setSeed: (seed) => {
      host.seed = seed
    },
    frame: context.frame,
    camera: (shot, seconds = 9999) => {
      if (shot === null) context.rig.release()
      else context.rig.hold(shot, seconds)
    },
    state: () => {
      const view = context.game.view()
      return {
        flow: view.flow,
        zone: view.zone,
        room: view.room === null ? null : { index: view.room.index, kind: view.room.kind, state: view.room.state, sealed: view.room.doors.some((door) => door.state === "locked") },
        transition: view.transition === null ? null : { kind: view.transition.kind, beat: view.transition.beat, swapped: view.transition.swapped },
        weapon: view.weapon.id,
        boss: view.boss === null ? null : { boss: view.boss.boss, hp: view.boss.hp, phase: view.boss.phase, state: view.boss.state, balance: view.boss.balance, pattern: view.boss.pattern },
        wave: view.wave,
        lives: view.lives,
        focus: view.focus,
        timer: view.timer,
        kills: view.kills,
        seed: view.seed,
        tempo: view.tempo,
        player: view.player === null ? null : { x: view.player.x, z: view.player.z, state: view.player.state, move: view.player.move, step: view.player.step },
        enemies: view.enemies.map((enemy) => ({ id: enemy.id, kind: enemy.kind, state: enemy.state, hp: enemy.hp, x: enemy.x, z: enemy.z, drill: enemy.drill ?? null })),
        projectiles: view.projectiles.length,
        shot: context.rig.shot,
        liveShot: context.rig.live,
        frozen: host.frozen
      }
    },
    view: () => context.game.view(),
    until: (check, timeoutMs = 20000) => new Promise((resolve) => {
      const started = performance.now()
      const poll = () => {
        if (check(api.state())) resolve(true)
        else if (performance.now() - started > timeoutMs) resolve(false)
        else requestAnimationFrame(poll)
      }
      poll()
    }),
    compiles: () => host.compiles(),
    loadReport: () => host.loadReport
  }
  void context.loaded.then(() => {
    window.__game = api
  })
  return api
}
