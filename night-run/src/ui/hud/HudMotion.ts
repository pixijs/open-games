import { gsap } from 'gsap';
import type { Container } from 'pixi.js';

import { MOTION } from '../art/tokens';
import { Motion } from '../kit/Motion';

/**
 * The HUD's tweens, in the named motions of `MOTION`. It owns its tweens through a {@link Motion}, which forgets each one as
 * it completes or is killed, so `destroy` can stop what's still running without the HUD holding every target it ever
 * tweened. With `prefers-reduced-motion` the slides, skews and punches become 0.15 s fades.
 */
export class HudMotion {
  private readonly _owned = new Motion();

  public get reduced(): boolean {
    return this._owned.reduced;
  }

  /** gsap.to, owned */
  public to(target: object, vars: gsap.TweenVars): gsap.core.Tween {
    return this._owned.to(target, vars);
  }

  /** Calls `fn` after `seconds`; killed by {@link HudMotion.kill} on `fn` */
  public delay(seconds: number, fn: () => void): gsap.core.Tween {
    return this._owned.delay(seconds, fn);
  }

  /** Stops every tween on the targets */
  public kill(...targets: object[]): void {
    for (const t of targets) gsap.killTweensOf(t);
  }

  /** Numerals and badges punch in from oversize */
  public punch(view: Container, from = 1.6, delay = 0, to = 1): void {
    this.kill(view.scale);
    if (this.reduced) {
      view.scale.set(to);
      this.fadeIn(view, delay);

      return;
    }
    view.scale.set(from * to);
    this.to(view.scale, { x: to, y: to, delay, duration: MOTION.punch.duration, ease: MOTION.punch.ease });
  }

  /**
   * Seats a view at its home spot from an offset with a little overshoot, fading in; leans while it travels sideways.
   * @param view - What moves.
   * @param x - Home x.
   * @param y - Home y.
   * @param dx - Start offset x.
   * @param dy - Start offset y.
   * @param delay - Seconds before it starts.
   */
  public slot(view: Container, x: number, y: number, dx: number, dy: number, delay = 0): void {
    this.kill(view, view.position, view.skew);
    view.visible = true;
    if (this.reduced) {
      view.position.set(x, y);
      view.skew.set(0, 0);
      this.fadeIn(view, delay);

      return;
    }
    view.position.set(x + dx, y + dy);
    view.alpha = 0;
    view.skew.x = dx === 0 ? 0 : dx < 0 ? -0.21 : 0.21;
    const { ease, duration } = MOTION.slot;

    this.to(view.position, { x, y, delay, duration, ease });
    this.to(view.skew, { x: 0, delay, duration, ease: 'power2.out' });
    this.to(view, { alpha: 1, delay, duration: 0.16, ease: 'power1.out' });
  }

  /**
   * Leaves fast toward an offset, leaning the way it goes, then hides. With a delay it waits its turn behind whatever
   * brought the view in, and the offset counts from where the view is when it starts.
   */
  public whip(view: Container, dx: number, dy: number, delay = 0): void {
    if (delay === 0) {
      this.kill(view, view.position, view.skew);
      if (!view.visible) return;
    }
    if (this.reduced) {
      this.to(view, { alpha: 0, delay, duration: 0.15, ease: 'power1.in', onComplete: () => (view.visible = false) });

      return;
    }
    const { ease, duration } = MOTION.whip;

    this.to(view.position, { x: `+=${dx}`, y: `+=${dy}`, delay, duration, ease });
    this.to(view.skew, { x: dx === 0 ? 0 : dx > 0 ? -0.14 : 0.14, delay, duration, ease });
    this.to(view, {
      alpha: 0,
      delay,
      duration,
      ease: 'power1.in',
      onComplete: () => {
        view.visible = false;
      },
    });
  }

  public fadeIn(view: Container, delay = 0, duration = 0.15): void {
    this.kill(view);
    view.visible = true;
    view.alpha = 0;
    this.to(view, { alpha: 1, delay, duration, ease: 'power1.out' });
  }

  public fadeOut(view: Container, delay = 0, duration = 0.15): void {
    this.kill(view);
    this.to(view, {
      alpha: 0,
      delay,
      duration,
      ease: 'power1.in',
      onComplete: () => {
        view.visible = false;
      },
    });
  }

  /** Kills everything still running. Idempotent */
  public destroy(): void {
    this._owned.destroy();
  }
}
