import { PALETTE } from "../art/palette.ts"
import type { PaletteName } from "../art/palette.ts"
import type { MomentOf, SpecialTarget } from "../sim/index.ts"
import type { Arc, ArcShapeName } from "./arcs.ts"
import { ON_TWOS } from "./cues.ts"
import { focusOn, setImpact, settleFocus } from "./frame.ts"
import type { ImpactKind } from "./frame.ts"
import { drawnAt, spray, spread } from "./fx.ts"
import type { Fx } from "./fx.ts"

/**
 * KUZUSHI, the showpiece. Time stops: a paper flash, the world drains to ink and red round a vignette on the
 * player, cinema bars close in, focus lines race round them and every enemy in reach is marked. On the first
 * beat the camera cuts wide; on every beat a crescent slashes across each target, the frame strobes red and
 * white and impact frames punch through. The final beat crosses two brush cuts over the whole screen and
 * everything holds, drawn, until time resumes: then every held stroke shatters in the slow motion, the picture
 * blurs out from the player and the camera whips back.
 */

/** Crescents drawn per beat: the nearest targets get one each, and every one is held until time resumes. */
const MAX_STRUCK = 8
/** The special's own drawing rate while the world stands still. */
const FPS = 12

const BEAT_FRAMES: Readonly<Record<number, ReadonlyArray<Exclude<ImpactKind, "none">>>> = { 1: ["ink", "ink"], 3: ["red"], 5: ["stark"] }

interface Held {
  readonly arc: Arc
  readonly shape: ArcShapeName
  readonly x: number
  readonly z: number
  readonly radius: number
}

interface Running {
  readonly x: number
  readonly z: number
  /** Real seconds since it began, counted only while the game is played. */
  age: number
  drawing: number
  held: Array<Held>
  finalAt: number | null
  strobe: { readonly color: PaletteName; readonly until: number }
  readonly slashAngles: readonly [number, number]
}

const distanceTo = (special: Running) => (target: SpecialTarget) => Math.hypot(target.x - special.x, target.z - special.z)

export const installSpecial = (fx: Fx) => {
  let running: Running | null = null

  const screenOf = (x: number, z: number) => fx.context.view.worldToScreen({ x, y: 0.4, z })

  const strike = (special: Running, x: number, z: number, final: boolean, beat: number) => {
    const shape: ArcShapeName = final ? "wide" : "cut"
    const arc = fx.arcs.take(shape)
    const radius = final ? 3.2 : 2.3 + fx.rng() * 0.6
    const facing = fx.rng() * Math.PI * 2
    arc.place(x - Math.cos(facing) * radius * 0.55, 0.7, z - Math.sin(facing) * radius * 0.55, facing, radius, fx.rng() < 0.5, spread(fx.rng, 0.5))
    arc.pose(0, 0.65, 0, 2.8, beat)
    fx.cues.play({
      clock: "real",
      life: 2 / 24,
      fps: 24,
      draw: (drawing) => {
        if (drawing === 1) arc.pose(0, 1, 0, final ? 2.4 : 2, beat + 1)
      },
      end: () => arc.pose(0, 1, 0, final ? 1.9 : 1.6, beat + 2)
    })
    special.held.push({ arc, shape, x, z, radius })
    fx.layers.face.spawn({ frames: fx.f.burst, x, y: 0.7, z, size: final ? 3.6 : 2.4, sizeEnd: final ? 4.2 : 2.8, rotation: fx.rng() * 6, life: 3 / 24, fps: 24, clock: "real", alphaEnd: 0.6 })
    spray(fx, { count: 4, x, y: 0.6, z, angle: 0, cone: Math.PI, speed: [8, 12], size: [0.5, 0.7], frame: () => fx.f.sparkRed, life: 0.2, clock: "real" })
  }

  /** Every held stroke erodes on the game clock (so the slow motion drags it out) and throws its shards. */
  const shatterHeld = (special: Running) => {
    for (const { arc, shape, x, z, radius } of special.held) {
      fx.cues.play({
        clock: "game",
        life: 5 / ON_TWOS,
        fps: ON_TWOS,
        draw: (drawing) => arc.pose(0.15 * drawing, 1, 0.25 + drawing * 0.2, 1.8 - drawing * 0.2, drawing),
        end: () => fx.arcs.give(shape, arc)
      })
      for (let index = 0; index < 5; index++) {
        const direction = fx.rng() * Math.PI * 2
        const speed = 5 + fx.rng() * 8
        fx.layers.flat.spawn({
          frames: index % 2 === 0 ? fx.f.shard : fx.f.sparkRed,
          x: x + Math.cos(direction) * radius * 0.5,
          y: 0.7,
          z: z + Math.sin(direction) * radius * 0.5,
          vx: Math.cos(direction) * speed,
          vy: 2 + fx.rng() * 3,
          vz: Math.sin(direction) * speed,
          rotation: direction,
          spin: spread(fx.rng, 8),
          gravity: 10,
          size: 0.5 + fx.rng() * 0.6,
          sizeEnd: 0.2,
          drag: 2,
          life: 0.9,
          hold: 0.5,
          alphaEnd: 0
        })
      }
    }
    special.held = []
  }

  const mark = (started: MomentOf<"specialStarted">) => {
    const inReach = fx.context.game.view().enemies.filter((enemy) => Math.hypot(enemy.x - started.x, enemy.z - started.z) <= started.radius + 0.5)
    inReach.forEach((enemy, index) => {
      fx.cues.play({
        clock: "real",
        life: 0.45,
        fps: FPS,
        draw: (drawing) => {
          if (drawing !== Math.min(4, index)) return
          const at = drawnAt(fx, enemy.id, enemy)
          fx.layers.face.spawn({ frames: fx.f.lockon, x: at.x, y: 0.55, z: at.z, size: 2.2, sizeEnd: 1.3, rotation: Math.PI / 4, life: 0.5 - drawing / FPS, fps: FPS, clock: "real", alpha: 1, alphaEnd: 1 })
        }
      })
    })
  }

  const onStarted = (started: MomentOf<"specialStarted">) => {
    if (running !== null) shatterHeld(running)
    const angle = fx.rng() * Math.PI
    running = { x: started.x, z: started.z, age: 0, drawing: -1, held: [], finalAt: null, strobe: { color: "paper", until: 1 / FPS }, slashAngles: [angle - 0.35, angle + Math.PI * 0.5 + 0.3] }
    fx.layers.flatGlow.spawn({ frames: fx.f.haloRing, x: started.x, y: 0.1, z: started.z, size: started.radius * 2.25, color: PALETTE.red, alpha: 0.5, alphaEnd: 0.5, life: 1.4, clock: "real", fps: 0 })
    fx.layers.flat.spawn({ frames: fx.f.shock, x: started.x, y: 0.09, z: started.z, size: started.radius * 0.6, sizeEnd: started.radius * 2.1, color: PALETTE.red, life: 0.35, clock: "real", fps: FPS, alpha: 1, alphaEnd: 0.6 })
    mark(started)
    fx.context.rig.shake(0.1, { x: started.x, z: started.z, duration: 0.3, shape: "rumble" })
  }

  const cutWide = (special: Running, targets: ReadonlyArray<SpecialTarget>) => {
    const cx = (special.x + targets.reduce((sum, target) => sum + target.x, 0)) / (targets.length + 1)
    const cz = (special.z + targets.reduce((sum, target) => sum + target.z, 0)) / (targets.length + 1)
    const reach = [special, ...targets].reduce((most, point) => Math.max(most, Math.hypot(point.x - cx, point.z - cz)), 2)
    fx.context.rig.specialStrike(cx, cz, reach)
  }

  const onHit = (beat: MomentOf<"specialHit">) => {
    const special = running
    if (special === null) return
    if (beat.index === 1) cutWide(special, beat.targets)
    const distance = distanceTo(special)
    const nearest = [...beat.targets].sort((a, b) => distance(a) - distance(b)).slice(0, MAX_STRUCK)
    for (const target of nearest) strike(special, target.x, target.z, beat.final, beat.index)
    if (nearest.length === 0) strike(special, special.x + spread(fx.rng, 1.5), special.z + spread(fx.rng, 1.5), beat.final, beat.index)
    fx.context.rig.dutch(beat.final ? 0 : beat.index % 2 === 0 ? 6 : -6)
    if (beat.final) {
      special.finalAt = special.age
      special.strobe = { color: "red", until: special.age + 1 / FPS }
      fx.impacts.frame(["ink", "red", "ink"], { fps: 18, force: true })
      fx.layers.face.spawn({ frames: fx.f.radial, x: special.x, y: 0.8, z: special.z, size: 7, sizeEnd: 9, rotation: fx.rng() * 6, life: 0.3, clock: "real", fps: FPS, alphaEnd: 0.4 })
      fx.context.rig.shake(0.5, { x: special.x, z: special.z, shape: "explosion", duration: 0.5 })
      fx.context.rig.punch(6)
      return
    }
    special.strobe = { color: beat.index % 2 === 0 ? "red" : "paper", until: special.age + 1 / 24 }
    const frames = BEAT_FRAMES[beat.index]
    if (frames !== undefined) fx.impacts.frame(frames, { force: true })
    fx.context.rig.shake(0.16, { x: special.x, z: special.z, duration: 0.14 })
  }

  const onEnded = (ended: MomentOf<"specialEnded">) => {
    const special = running
    running = null
    if (special !== null) shatterHeld(special)
    fx.screen.clear()
    setImpact(fx.frame, "none")
    fx.context.rig.dutch(0)
    fx.layers.flatGlow.spawn({ frames: fx.f.shock, x: ended.x, y: 0.12, z: ended.z, size: 3, sizeEnd: 20, color: PALETTE.red, life: 0.5, clock: "real", alpha: 1, alphaEnd: 0 })
    fx.layers.flat.spawn({ frames: fx.f.dryRing, x: ended.x, y: 0.1, z: ended.z, size: 2, sizeEnd: 16, life: 0.45, clock: "real", alpha: 0.8, alphaEnd: 0 })
    const screen = screenOf(ended.x, ended.z)
    fx.cues.play({
      clock: "real",
      life: 0.4,
      fps: ON_TWOS,
      draw: (drawing) => {
        const fade = Math.max(0, 1 - (drawing / 6) * 1.4)
        fx.frame.set({ crush: fade, vignette: 0.6 * fade })
        fx.screen.setBars(Math.max(0, 1 - drawing / 3))
        fx.screen.setStrobe("paper", drawing === 0 ? 0.6 : 0)
        if (screen === null) return
        const { width, height } = fx.context.app.screen
        focusOn(fx.frame, screen.x, screen.y, width, height, 0.6 * Math.max(0, 1 - drawing / 3.5))
        fx.screen.setFocus(drawing, screen.x, screen.y, "paper", Math.max(0, 0.7 - drawing * 0.15), 1 + drawing * 0.13, fx.rng)
      },
      end: () => {
        settleFocus(fx.frame)
        fx.screen.clear()
      }
    })
    fx.context.rig.shake(0.3, { x: ended.x, z: ended.z, shape: "explosion", duration: 0.4 })
  }

  /** The strobe every frame; the grade, bars, focus lines, brush cuts and aura on each of the special's drawings. */
  const update = (realDt: number) => {
    const special = running
    if (special === null || realDt === 0) return
    special.age += realDt
    fx.screen.setStrobe(special.strobe.color, special.age < special.strobe.until ? (special.strobe.color === "paper" ? 0.9 : 0.4) : 0)
    const drawing = Math.floor(special.age * FPS)
    if (drawing === special.drawing) return
    special.drawing = drawing
    const settle = Math.min(1, drawing / 3)
    fx.frame.set({ crush: settle, vignette: 0.6 * settle })
    fx.screen.setBars(settle)
    const sinceFinal = special.finalAt === null ? -1 : Math.floor((special.age - special.finalAt) * FPS)
    const screen = screenOf(special.x, special.z)
    if (screen !== null) {
      const { width, height } = fx.context.app.screen
      focusOn(fx.frame, screen.x, screen.y, width, height, 0)
      fx.screen.setFocus(drawing, screen.x, screen.y, sinceFinal >= 0 && sinceFinal % 2 === 0 ? "red" : "paper", sinceFinal >= 0 ? 0.85 : 0.6, 1, fx.rng)
      if (sinceFinal >= 0) {
        const reveal = Math.min(1, (sinceFinal + 1) / 2)
        const [first, second] = special.slashAngles
        fx.screen.setSlash(0, screen.x, screen.y, first, reveal)
        fx.screen.setSlash(1, screen.x, screen.y, second, sinceFinal >= 1 ? reveal : 0)
      }
    }
    if (special.finalAt !== null) return
    fx.layers.glow.spawn({ frames: fx.f.halo, x: special.x, y: 0.6, z: special.z, size: 2.2 + fx.rng() * 0.6, color: drawing % 2 === 0 ? 0xffffff : PALETTE.red, alpha: 0.55, life: 1 / FPS, fps: 0, clock: "real" })
    for (let index = 0; index < 2; index++) {
      const direction = fx.rng() * Math.PI * 2
      fx.layers.glow.spawn({ frames: fx.f.ember, x: special.x + Math.cos(direction) * 0.8, y: 0.2, z: special.z + Math.sin(direction) * 0.8, vy: 2.5, size: 0.22, sizeEnd: 0.05, color: PALETTE.red, life: 0.5, clock: "real", fps: FPS, alphaEnd: 0 })
    }
  }

  const { moments } = fx.context
  const offs = [moments.on("specialStarted", onStarted), moments.on("specialHit", onHit), moments.on("specialEnded", onEnded)]
  return {
    update,
    clear: () => {
      if (running !== null) for (const held of running.held) fx.arcs.give(held.shape, held.arc)
      running = null
      settleFocus(fx.frame)
      setImpact(fx.frame, "none")
    },
    dispose: () => {
      for (const off of offs) off()
    }
  }
}
