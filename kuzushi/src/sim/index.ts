import { Clock, Random } from "@typeonce/ritmo"
import type { HostClock } from "@typeonce/ritmo"
import { InputCapture } from "@typeonce/ritmo-browser"

import { ReloadDarts } from "./arsenal/darts.ts"
import { Combat } from "./combat.ts"
import { ControlsInput, idleInput } from "./controls.ts"
import { DebugCheats, DebugIntents } from "./debug.ts"
import { DungeonIntents } from "./dungeon/debug.ts"
import { BossRoom } from "./dungeon/boss-room.ts"
import { Shrines } from "./dungeon/shrines.ts"
import { Transitions } from "./dungeon/transitions.ts"
import { RingOuts } from "./edges.ts"
import { BossBrain } from "./bosses/brain.ts"
import { BossDebug } from "./bosses/debug.ts"
import { EnemyBrain } from "./enemies.ts"
import { PreparePaths } from "./paths.ts"
import { BurnSeams } from "./seams.ts"
import { AimIntents, RunFlow } from "./flow.ts"
import { RunHazards } from "./hazards.ts"
import { BufferInput, Defeat, PlayerControl } from "./player.ts"
import { MoveDarts, MoveOrbs } from "./projectiles.ts"
import { Body, Flow, Game, Input, PrevBody } from "./schema.ts"
import { Special } from "./special.ts"
import { AdvancePlay, AdvanceTime, calmTempo, playHeld, playing } from "./tempo.ts"
import { step } from "./time.ts"
import { MOVES, PLAYER } from "./tuning.ts"
import { RunWaves } from "./waves.ts"
import { loadoutFor, STARTING_WEAPON } from "./weapons.ts"

export * from "./schema.ts"
export * from "./moments.ts"
export * from "./view.ts"
export { ARENA } from "./stages/courtyard.ts"
export { OPEN_FLOOR } from "./ground.ts"
export { warmPaths } from "./paths.ts"
export type { ArenaLayout, Block, FloorShape, LayoutDoor, Pillar, Point, Slab } from "./arena.ts"
export { DOORWAY, doorLine, landingOf, onSide } from "./arena.ts"
export { buttons, ControlsInput, keys, makeControls } from "./controls.ts"
export { PlayTime, step, Time } from "./time.ts"
export * as Tuning from "./tuning.ts"
export type { BossId, EnemyKind } from "./tuning.ts"
export { bossIds, enemyKinds, isBoss } from "./tuning.ts"
export { slabGroupsOf, stageOf, STAGES, stageIds, terrainOf } from "./stages.ts"
export type { BeamHazard, CollapseHazard, SlabGroup, Stage, StageHazard, StageId } from "./stages.ts"
export { homeOf, ZONE_LIST, zoneIds, ZONES, zoneOf } from "./zones.ts"
export type { Zone, ZoneHazard, ZoneId } from "./zones.ts"
export { chainLength, CHAINS, STARTING_WEAPON, WEAPON_LIST, weaponIds, WEAPONS, weaponOf } from "./weapons.ts"
export type { DartView, Hand, Mark, MarkView, Weapon, WeaponId, WeaponMove, WeaponStyle, WeaponView } from "./weapons.ts"
export type { AttackFrame, AttackPhase } from "./arsenal/view.ts"
export { opposite, ROOM_KINDS, SIDE_DIRS, sides } from "./rooms.ts"
export type {
  AltarView,
  DoorMark,
  DoorState,
  DoorView,
  DropKind,
  DropView,
  MapRoomView,
  MapView,
  RoomKind,
  RoomKindInfo,
  RoomState,
  RoomView,
  Side,
  SpringView,
  TransitionBeat,
  TransitionKind,
  TransitionView
} from "./rooms.ts"
export { bossOf, BOSSES } from "./bosses.ts"
export { dungeonSeedOf, generateDungeon } from "./dungeon/generate.ts"
export { DOOR, RANK, ROOM, TRANSITION } from "./dungeon/rules.ts"
export type { Rank } from "./dungeon/rules.ts"
export { isTemplateId, templateIds, templateOf, templatesFor } from "./dungeon/templates.ts"
export type { TemplateId } from "./dungeon/templates.ts"
export type { RoomTemplate, TemplateRole } from "./dungeon/plan.ts"
export type { RoomRecord } from "./dungeon/schema.ts"
export { POOLS } from "./dungeon/pools.ts"
export type { Tier, WaveSlot } from "./dungeon/pools.ts"
export type { RunView, WaveMix } from "./dungeon/view.ts"
export type { BossPattern, BossPhase, BossStateName, BossTelegraph, BossView, MoonView } from "./bosses.ts"

/** Copies each actor's body before the step moves it, so the renderer can draw between steps. */
const SavePrev = Game.System("Game/SavePrev", {
  queries: { bodies: Game.Query({ selection: { body: Game.Query.read(Body), prev: Game.Query.write(PrevBody) } }) }
}, ({ queries }) => {
  const { data } = queries.bodies
  for (const entity of queries.bodies.each()) data.prev.set(entity, data.body.get(entity))
})

/** One fixed step. Needs only the controls service, so it runs headless. */
export const update = Game.Schedule(
  AdvanceTime,
  AdvancePlay,
  InputCapture.system(Game, { name: "Game/CaptureInput", source: ControlsInput, resource: Input }),
  AimIntents,
  RunFlow,
  Game.Schedule.applyStateTransitions(),
  DebugCheats,
  DebugIntents,
  BossDebug,
  DungeonIntents,
  Game.Schedule.when(
    [playing],
    BufferInput,
    Special,
    Defeat,
    PreparePaths,
    Transitions,
    Shrines,
    Game.Schedule.applyDeferred(),
    Game.Schedule.pauseWhile(
      [playHeld],
      SavePrev,
      PlayerControl,
      ReloadDarts,
      EnemyBrain,
      BossBrain,
      BurnSeams,
      BossRoom,
      MoveOrbs,
      MoveDarts,
      RunHazards,
      Combat,
      RingOuts,
      Game.Schedule.applyDeferred(),
      RunWaves
    )
  ),
  Game.Schedule.applyStateTransitions()
)

export const DEFAULT_SEED = 0x5eed

export const initialResources = () => ({
  Time: Clock.start(step),
  PlayTime: Clock.start(step),
  Input: idleInput(),
  Rng: Random.seed(DEFAULT_SEED),
  Run: { lives: PLAYER.lives, focus: 0, startedAt: 0, endedAt: null, swings: 0, kills: 0, seed: DEFAULT_SEED, from: "courtyard" as const, rooms: 0, hits: 0 },
  Waves: { _tag: "Idle" as const },
  Tempo: calmTempo(),
  Aim: { _tag: "Free" as const },
  Buffer: { _tag: "Empty" as const },
  CurrentStage: { id: "courtyard" as const, hazard: true, open: false, room: null },
  Hazard: { _tag: "None" as const },
  Loadout: loadoutFor(STARTING_WEAPON),
  Cheats: { invulnerable: false },
  Trigger: { _tag: "Free" as const },
  Steer: { _tag: "Free" as const },
  Moves: { ...MOVES },
  Dungeon: { _tag: "None" as const },
  Transition: { _tag: "None" as const }
})

export const initialMachines = () => Game.Runtime.machines(Game.Runtime.machine(Flow, { _tag: "Title" }))

type Controls = Parameters<typeof Game.Runtime.service<typeof ControlsInput>>[1]

/** A runtime with only the simulation's services, for tests, lint, and debug sessions. */
export const makeHeadlessRuntime = (options: { readonly controls: Controls; readonly debug?: { readonly hostClock: HostClock.HostClock } }) =>
  Game.Runtime.make({
    services: Game.Runtime.services(Game.Runtime.service(ControlsInput, options.controls)),
    resources: initialResources(),
    machines: initialMachines(),
    debug: options.debug
  })
