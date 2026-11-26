import { Descriptor } from "@typeonce/ritmo"
import { NodeRegistry, RenderSync } from "@typeonce/ritmo-render"
import type { Container3D } from "@pixi/3d"

import type { ActorView, ActorVisual, FrameTime } from "../host/types.ts"
import { createActorVisual } from "../look/actors.ts"
import { Actor, Body, Game, Moments, PrevBody } from "../sim/index.ts"
import type { GameView, Moment } from "../sim/index.ts"

/** One visual per actor entity, made by src/look. */
export const ActorVisuals = Descriptor.Service<NodeRegistry.NodeRegistry<ActorVisual>>()("Game/ActorVisuals")

/** Where the render schedule hands the simulation's moments to the host. */
export const MomentSink = Descriptor.Service<{ push(moments: ReadonlyArray<Moment>): void }>()("Game/MomentSink")

/** Hands every moment since the last drawn frame to the host, once, in order: the stream is kept until this reader runs. */
const ForwardMoments = Game.System("Game/ForwardMoments", {
  events: { moments: Game.System.readEvent(Moments) },
  services: { sink: Game.System.service(MomentSink) }
}, ({ events, services }) => {
  const moments = events.moments.all()
  if (moments.length > 0) services.sink.push(moments)
})

/** How far between its last two gameplay steps each actor is drawn: set by the host every frame. */
export const RenderClock = Descriptor.Service<{ alpha: number }>()("Game/RenderClock")

export const makeActorRegistry = (layer: Container3D): NodeRegistry.NodeRegistry<ActorVisual> =>
  NodeRegistry.make<ActorVisual>({
    attach: (visual, parent) => (parent?.node ?? layer).addChild(visual.node),
    detach: (visual) => visual.destroy()
  })

const RenderActors = RenderSync.system(Game, {
  name: "Game/RenderActors",
  renderable: Actor,
  registry: ActorVisuals,
  create: ({ renderable }) => createActorVisual(renderable.kind),
  apply: () => {}
})

const turn = (from: number, to: number, alpha: number): number => {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from))
  return from + delta * alpha
}

const PlaceActors = RenderSync.interpolate(Game, {
  name: "Game/PlaceActors",
  registry: ActorVisuals,
  previous: PrevBody,
  current: Body,
  clock: RenderClock,
  blend: (from, to, alpha) => ({
    x: from.x + (to.x - from.x) * alpha,
    z: from.z + (to.z - from.z) * alpha,
    facing: turn(from.facing, to.facing, alpha)
  }),
  place: (visual, { x, z, facing }) => visual.place(x, z, facing)
})

/** Ticked once per drawn frame, after the fixed updates: forwards moments, then makes, places and removes actor visuals. */
export const render = Game.Schedule(ForwardMoments, RenderActors, PlaceActors)

/** Hands every actor visual its latest view. Called once per drawn frame after `render`. */
export const updateActors = (registry: NodeRegistry.NodeRegistry<ActorVisual>, view: GameView, frame: FrameTime): void => {
  const update = (id: number, actor: ActorView) => registry.get(id)?.update(actor, frame)
  if (view.player !== null) update(view.player.id, { role: "player", player: view.player })
  for (const enemy of view.enemies) update(enemy.id, { role: "enemy", enemy })
  for (const orb of view.projectiles) update(orb.id, { role: "orb", orb })
  for (const dart of view.darts) update(dart.id, { role: "dart", dart })
}
