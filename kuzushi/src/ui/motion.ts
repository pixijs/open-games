import { gsap } from "gsap"

/** Drawings per second for hand-drawn moments: 12 is "on twos" at 24 fps, 24 is "on ones". */
export const ON_TWOS = 12
export const ON_ONES = 24

/**
 * An ease held like hand-drawn animation: the tween shows a new drawing `rate` times a second, each pose
 * snapped to `ease`. The first drawing lands at once, so a press never waits on a blank frame.
 */
export const drawn = (duration: number, ease = "power2.out", rate = ON_TWOS): gsap.EaseFunction => {
  const base = gsap.parseEase(ease)
  const drawings = Math.max(1, Math.round(duration * rate))
  return (progress) => progress >= 1 ? 1 : base(Math.ceil(progress * drawings) / drawings)
}

/** A random jitter that dies out, held on twos, for a hit that rattles something. It sets x and y outright and ends at 0, 0: rattle a body that rests there. */
export const rattle = (target: gsap.TweenTarget, strength: number, duration = 0.25): gsap.core.Timeline => {
  const timeline = gsap.timeline()
  const drawings = Math.max(2, Math.round(duration * ON_TWOS))
  for (let i = 0; i < drawings; i++) {
    const fall = 1 - i / drawings
    timeline.set(target, { x: gsap.utils.random(-strength, strength) * fall, y: gsap.utils.random(-strength, strength) * fall }, i / ON_TWOS)
  }
  return timeline.set(target, { x: 0, y: 0 }, drawings / ON_TWOS)
}

/**
 * Fades `node` in or out; it draws and takes the pointer only while shown, like GSAP's `autoAlpha`. It waits for its place in a timeline even
 * at zero length (where GSAP would otherwise apply it at once), so a lone zero-length one lands on GSAP's next tick.
 * A zero-length tween never fires onStart, so its onComplete sets `visible` too.
 */
export const shown = (node: { alpha: number; visible: boolean }, on: boolean, duration = 0): gsap.core.Tween =>
  gsap.to(node, {
    alpha: on ? 1 : 0,
    duration,
    ease: "power2.out",
    overwrite: "auto",
    immediateRender: false,
    onStart: () => {
      node.visible = true
    },
    onComplete: () => {
      node.visible = on
    }
  })
