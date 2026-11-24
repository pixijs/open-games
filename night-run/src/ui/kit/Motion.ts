import gsap from 'gsap';

import { MOTION } from '../art/tokens';

type Animation = gsap.core.Animation;
type Tick = (time: number, deltaMs: number) => void;

let reducedQuery: MediaQueryList | null = null;

/** Whether the player asked for less motion: slides, skews, shakes and confetti drop out, fades stay. */
export function prefersReducedMotion(): boolean {
  if (typeof matchMedia === 'undefined') return false;
  reducedQuery ??= matchMedia('(prefers-reduced-motion: reduce)');

  return reducedQuery.matches;
}

/**
 * The gsap tweens, timelines, delayed calls and ticker callbacks one owner (a screen, a card, the shell) started, so
 * `kill` stops every one of them when the owner goes. Eases and durations come from {@link MOTION}.
 */
export class Motion {
  public readonly reduced: boolean = prefersReducedMotion();
  private readonly _live = new Set<Animation>();
  private readonly _ticks = new Set<Tick>();
  private _dead = false;

  /** `gsap.to`, owned. */
  public to(target: gsap.TweenTarget, vars: gsap.TweenVars): gsap.core.Tween {
    return this._own(gsap.to(target, vars));
  }

  /** `gsap.fromTo`, owned. */
  public fromTo(target: gsap.TweenTarget, from: gsap.TweenVars, to: gsap.TweenVars): gsap.core.Tween {
    return this._own(gsap.fromTo(target, from, to));
  }

  /** `gsap.timeline`, owned. */
  public timeline(vars?: gsap.TimelineVars): gsap.core.Timeline {
    return this._own(gsap.timeline(vars));
  }

  /** Calls `fn` after `seconds`, owned. */
  public delay(seconds: number, fn: () => void): gsap.core.Tween {
    return this._own(gsap.delayedCall(seconds, fn));
  }

  /** Runs `fn` every animation frame until `stop` or `kill`; returns `stop`. */
  public tick(fn: Tick): () => void {
    if (this._dead) return () => undefined;
    this._ticks.add(fn);
    gsap.ticker.add(fn);

    return () => {
      this._ticks.delete(fn);
      gsap.ticker.remove(fn);
    };
  }

  /** Kills the tweens on `targets` this owner started (and any other), so a new move can take over. */
  public stop(...targets: object[]): void {
    for (const t of targets) gsap.killTweensOf(t);
  }

  /**
   * `punch`: in from `from` times its size to 1 with the elastic ease, on a container whose pivot is its centre.
   * Reduced motion keeps the scale at 1.
   */
  public punch(scale: { x: number; y: number }, from = 1.6, duration: number = MOTION.punch.duration): void {
    this.stop(scale);
    if (this.reduced) {
      scale.x = scale.y = 1;

      return;
    }
    this.fromTo(scale, { x: from, y: from }, { x: 1, y: 1, ease: MOTION.punch.ease, duration });
  }

  /** Shakes `node` sideways by `px`, `times` full swings over `duration`, ending where it started. */
  public shake(node: { x: number }, px: number, duration: number, times = 2): void {
    if (this.reduced) return;
    const home = node.x;
    const steps = times * 2;
    const tl = this.timeline({ onComplete: () => void (node.x = home) });

    for (let i = 0; i < steps; i++) {
      const fall = 1 - i / steps;

      tl.to(node, { x: home + (i % 2 ? -px : px) * fall, duration: duration / (steps + 1), ease: 'sine.inOut' });
    }
    tl.to(node, { x: home, duration: duration / (steps + 1), ease: 'sine.out' });
  }

  /** Stops everything this owner started. Idempotent. */
  public kill(): void {
    for (const a of this._live) a.kill();
    this._live.clear();
    for (const fn of this._ticks) gsap.ticker.remove(fn);
    this._ticks.clear();
  }

  /** Kills everything and refuses new work. */
  public destroy(): void {
    this.kill();
    this._dead = true;
  }

  private _own<T extends Animation>(a: T): T {
    if (this._dead) {
      a.kill();

      return a;
    }
    this._live.add(a);
    a.eventCallback('onInterrupt', () => this._live.delete(a));
    const done = a.eventCallback('onComplete');

    a.eventCallback('onComplete', (...args: unknown[]) => {
      this._live.delete(a);
      if (done) (done as (...rest: unknown[]) => void)(...args);
    });

    return a;
  }
}
