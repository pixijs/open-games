import { ROAD_Y } from '../../race/route';
import type { PyroKit } from './PyroKit';
import type { PyroRandom } from './PyroRandom';

const STREAM_SHELL = 41;
const STREAM_BURST = 42;
const STREAM_CONFETTI = 43;

/** A shell's pull while it climbs. */
const SHELL_GRAVITY = 9.8;
const SHELL_TRAIL_RATE = 90;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const PINK = 0xff3fa8;
const CYAN = 0x38f2ff;
const GOLD = 0xffc048;
const WHITE = 0xfff4e6;

/**
 * One shell: where it bursts, as an offset from the show's origin, when (seconds into the show), how long it climbs to
 * get there, and its burst. `drag` is how hard the stars brake, so `radius` is how far they get.
 */
interface Shell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly time: number;
  readonly climb: number;
  readonly color: number;
  /** Chrysanthemums leave long glittering trails and cool to orange; peonies keep their colour. */
  readonly chrysanthemum: boolean;
  readonly radius: number;
  readonly drag: number;
  readonly stars: number;
  /** Whether it carries a light that tints the wet track in its colour. */
  readonly lit: boolean;
}

function shell(
  x: number,
  y: number,
  z: number,
  time: number,
  color: number,
  chrysanthemum: boolean,
  radius: number,
  drag: number,
  lit = false,
): Shell {
  const stars = Math.round((chrysanthemum ? 16 : 19) * radius);

  return { x, y, z, time, climb: 1.2 + y * 0.02, color, chrysanthemum, radius, drag, stars, lit };
}

/**
 * The show over the podium: a big gold chrysanthemum high beyond it, pink and cyan peonies close in either side, and
 * smaller, further ones round them, bursting one after another; +z is away from the camera. The close pair carry the lights, so the wet track
 * under the podium flashes in their colours. It repeats every {@link SHOW_LENGTH} seconds while it plays.
 */
const SHELLS: readonly Shell[] = [
  shell(0, 8.5, 14, 0.6, GOLD, true, 6.5, 6),
  shell(-5.5, 6, 9, 1.3, PINK, false, 4.5, 7, true),
  shell(5.5, 6.5, 10, 1.9, CYAN, true, 4.5, 7, true),
  shell(-10, 8, 17, 2.6, WHITE, false, 5, 6),
  shell(10, 7.5, 16, 3.1, GOLD, false, 5, 6),
  shell(-2.5, 9.5, 19, 3.8, PINK, true, 6, 5),
  shell(3.5, 6, 11, 4.4, CYAN, false, 4, 8, true),
  shell(-7, 8.5, 14, 5.0, GOLD, true, 5, 6, true),
];

/** Seconds before the show starts over. */
const SHOW_LENGTH = 6.5;

/** Star size per unit of burst radius, so far, wide bursts still read. */
const STAR_SIZE = 0.05;
/** How far from the origin toward its burst each light sits, so it tints the track under the podium. */
const LIGHT_PULL = 0.35;
/** Brightness of a burst's light; it sits high, so it washes the asphalt in colour rather than pooling white on it. */
const LIGHT_INTENSITY = 110;

/** Seconds of flight a star's tail shows: short on a peony, long on a chrysanthemum. */
const TAIL_SHORT = 0.035;
const TAIL_LONG = 0.1;

/** Seconds into the show the confetti cannons fire. */
const CONFETTI_TIME = 0.2;
const CONFETTI_COLORS: readonly number[] = [PINK, CYAN, GOLD, WHITE, 0xb66bff];

/**
 * Fireworks and confetti for the podium. Shells climb with sparking tails and burst into peonies and glittering
 * chrysanthemums in pink, cyan, gold and white, each a flash, a lens flare and, for the close ones, a light tinting the
 * wet track. Two cannons fire confetti over the podium as the show starts.
 */
export class Fireworks {
  private readonly _kit: PyroKit;
  /** Game time the current show started, or -1 while none plays. */
  private _start = -1;
  private _x = 0;
  private _z = 0;

  constructor(kit: PyroKit) {
    this._kit = kit;
  }

  /** Whether a show is playing. */
  public get playing(): boolean {
    return this._start >= 0;
  }

  /**
   * Start the show over a place, now, and keep repeating it until {@link Fireworks.stop}.
   * @param time - Game time now.
   * @param x - Where the show centres, x; shells burst beyond it, toward +z.
   * @param z - Where the show centres, z.
   */
  public play(time: number, x: number, z: number): void {
    this._start = time;
    this._x = x;
    this._z = z;
  }

  /** Let the shells in the air finish and launch no more. */
  public stop(): void {
    this._start = -1;
  }

  /**
   * Emit everything that happens between two game times.
   * @param from - Game time of the last frame.
   * @param to - Game time now.
   */
  public update(from: number, to: number): void {
    if (this._start < 0) return;

    while (to - this._start >= SHOW_LENGTH) this._start += SHOW_LENGTH;

    const a = from - this._start;
    const b = to - this._start;

    if (a < CONFETTI_TIME && CONFETTI_TIME <= b) this._confetti();

    for (let i = SHELLS.length - 1; i >= 0; i--) {
      const shell = SHELLS[i];
      const launch = shell.time - shell.climb;

      if (b < launch) continue;

      if (b < shell.time) {
        this._climb(i, a, b);
        continue;
      }

      if (a < shell.time) this._burst(i);
      if (a < shell.time + 0.1) this._climb(i, a, Math.min(b, shell.time));

      this._glow(shell, b - shell.time);
    }
  }

  /** The shell's launch velocity on one axis, to reach `d` in `climb` seconds against `accel`. */
  private _launchVelocity(d: number, accel: number, climb: number): number {
    return (d - 0.5 * accel * climb * climb) / climb;
  }

  /** The climbing shell: its head, and a tail of sparks it sheds. */
  private _climb(index: number, from: number, to: number): void {
    const shell = SHELLS[index];
    const { sparks, glows, rng, density } = this._kit;
    const launch = shell.time - shell.climb;
    const bx = this._x + shell.x;
    const bz = this._z + shell.z;
    // Launched from the ground a little to the side of where it bursts, so the tails lean.
    const x0 = bx + (shell.x < 0 ? 1.2 : -1.2);
    const z0 = bz - 1.5;
    const y0 = ROAD_Y + 0.2;
    const vx = this._launchVelocity(bx - x0, 0, shell.climb);
    const vy = this._launchVelocity(shell.y - y0, -SHELL_GRAVITY, shell.climb);
    const vz = this._launchVelocity(bz - z0, 0, shell.climb);
    const rate = SHELL_TRAIL_RATE * density;
    const first = Math.max(Math.floor((from - launch) * rate) + 1, 0);
    const last = Math.min(Math.floor((to - launch) * rate), Math.floor(shell.climb * rate));

    for (let k = first; k <= last; k++) {
      const t = k / rate;

      rng.seed(STREAM_SHELL + index * 53, k);
      sparks.x = x0 + vx * t + rng.signed() * 0.03;
      sparks.y = y0 + vy * t - 0.5 * SHELL_GRAVITY * t * t;
      sparks.z = z0 + vz * t + rng.signed() * 0.03;
      sparks.vx = rng.signed() * 0.6;
      sparks.vy = (vy - SHELL_GRAVITY * t) * 0.15 - rng.range(0.5, 1.5);
      sparks.vz = rng.signed() * 0.6;
      sparks.birth = this._start + launch + t;
      sparks.life = rng.range(0.35, 0.7);
      sparks.size = rng.range(0.05, 0.08);
      sparks.sizeEnd = 0.01;
      sparks.heat = 1.5;
      sparks.heatEnd = 0.45;
      sparks.drag = 2;
      sparks.gravity = 0.3;
      sparks.flicker = 0.5;
      sparks.trail = 0;
      sparks.streak = 1;
      sparks.tint(0xffffff, 0.9);
      sparks.emit();
    }

    const t = Math.min(to, shell.time) - launch;

    if (t < 0 || to >= shell.time) return;

    glows.add(x0 + vx * t, y0 + vy * t - 0.5 * SHELL_GRAVITY * t * t, z0 + vz * t, 0.35, 0xffd9a0, 0.9);
  }

  /** Every star of a burst: a bright head and a glowing tail behind it, and glitter strewn along a chrysanthemum. */
  private _burst(index: number): void {
    const shell = SHELLS[index];
    const { stars, rng, density } = this._kit;
    const count = Math.round(shell.stars * (0.5 + 0.5 * density));
    const speed = shell.radius * shell.drag;
    // A tail's length is the star's speed now times this; braking hard, it covered more than that, so stretch it.
    const tail = shell.chrysanthemum ? TAIL_LONG : TAIL_SHORT;
    const trail = (tail * (Math.exp(shell.drag * tail) - 1)) / (shell.drag * tail);
    const birth = this._start + shell.time;

    rng.seed(STREAM_BURST, index);

    for (let i = 0; i < count; i++) {
      // An even spread over the sphere, jittered so it doesn't read as a lattice.
      const y = 1 - (2 * (i + 0.5)) / count;
      const r = Math.sqrt(1 - y * y);
      const a = i * GOLDEN_ANGLE + rng.signed() * 0.15;
      const v = speed * rng.range(0.88, 1.04);
      const vx = Math.cos(a) * r * v;
      const vy = y * v;
      const vz = Math.sin(a) * r * v;
      const life = rng.range(2.6, 3.4);

      this._star(rng, shell, vx, vy, vz, birth, life);
      stars.tint(shell.chrysanthemum ? WHITE : shell.color, 1);
      stars.trail = 0.004;
      stars.streak = 1;
      stars.emit();

      this._star(rng, shell, vx, vy, vz, birth, life);
      stars.size *= 0.7;
      stars.tint(shell.color, 0.55);
      stars.trail = trail;
      stars.streak = 1;
      stars.emit();

      if (!shell.chrysanthemum) continue;

      const scale = rng.range(0.5, 0.92);

      this._star(rng, shell, vx * scale, vy * scale, vz * scale, birth + rng.range(0, 0.03), 1.4);
      stars.size *= 0.45;
      stars.sizeEnd *= 0.45;
      stars.flicker = 0.9;
      stars.tint(WHITE, 1);
      stars.emit();
    }
  }

  /** Fill a star's spawn fields from the burst. */
  private _star(rng: PyroRandom, shell: Shell, vx: number, vy: number, vz: number, birth: number, life: number): void {
    const stars = this._kit.stars;

    stars.x = this._x + shell.x;
    stars.y = shell.y;
    stars.z = this._z + shell.z;
    stars.vx = vx;
    stars.vy = vy;
    stars.vz = vz;
    stars.birth = birth;
    stars.life = life;
    stars.size = shell.radius * STAR_SIZE * rng.range(0.85, 1.15);
    stars.sizeEnd = shell.radius * STAR_SIZE * 0.3;
    stars.heat = shell.chrysanthemum ? 1.5 : 1.25;
    stars.heatEnd = shell.chrysanthemum ? 0.55 : 1;
    stars.drag = shell.drag;
    stars.gravity = 0.25;
    stars.flicker = shell.chrysanthemum ? 0.3 : 0.08;
    stars.trail = 0;
    stars.streak = 1;
  }

  /** A burst's flash, its flare, and its light if it carries one. */
  private _glow(shell: Shell, since: number): void {
    const { glows, lights, fx } = this._kit;
    const flash = Math.exp(-since * 14);
    const glow = 0.3 + 0.7 * Math.exp(-since * 4);
    const x = this._x + shell.x;
    const z = this._z + shell.z;

    // The bursts hang for their stars' life, then fade with them.
    if (since > 3.4) return;

    glows.add(x, shell.y, z, (2.6 * flash + 0.5 * glow) * shell.radius * 0.2, WHITE, 0.15 + 0.5 * flash);
    glows.add(x, shell.y, z, shell.radius * 2.2, shell.color, 0.08 * glow);
    fx.flare(x, shell.y, z, shell.color, 0.4 + 1.4 * flash);

    if (!shell.lit) return;

    lights.set(
      this._x + shell.x * LIGHT_PULL,
      shell.y,
      this._z + shell.z * LIGHT_PULL,
      shell.color,
      LIGHT_INTENSITY * glow,
      36,
    );
  }

  /** Two cannons either side of the podium fire paper over it. */
  private _confetti(): void {
    const { confetti, rng, density } = this._kit;
    const count = Math.round(220 * density);

    rng.seed(STREAM_CONFETTI, 0);

    for (let i = 0; i < count; i++) {
      const side = i & 1 ? 1 : -1;

      confetti.x = this._x + side * rng.range(2.4, 3.2);
      confetti.y = 3.5 + rng.signed() * 0.15;
      confetti.z = this._z + rng.signed() * 0.3;
      confetti.vx = -side * rng.range(1.5, 5);
      confetti.vy = rng.range(0.5, 3.5);
      confetti.vz = rng.signed() * 2;
      confetti.birth = this._start + CONFETTI_TIME - rng.next() * 0.6;
      confetti.life = rng.range(3.5, 4.5);
      confetti.size = rng.range(0.035, 0.055);
      confetti.sizeEnd = confetti.size;
      confetti.rotation = rng.next() * Math.PI;
      confetti.spin = rng.signed() * 9;
      confetti.heat = 1;
      confetti.heatEnd = 1;
      confetti.drag = 2;
      confetti.gravity = 1;
      // Paper catching the floodlights as it turns.
      confetti.flicker = 0.7;
      confetti.trail = 0;
      confetti.tint(CONFETTI_COLORS[i % CONFETTI_COLORS.length], 0.9);
      confetti.emit();
    }
  }
}
