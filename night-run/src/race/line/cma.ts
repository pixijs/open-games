/**
 * CMA-ES over a racing line's offsets, asked for a generation at a time and told its scores, so the generation can be
 * raced on several workers at once. Hansen's (mu/mu_w, lambda) form with full covariance; past {@link FULL_LIMIT}
 * offsets, the separable form (a diagonal covariance, Ros and Hansen 2008), whose work grows with the offsets rather
 * than their cube. Candidates race clamped to the road; the part of a sample past the road costs it a little, so the
 * mean stays near the road. Pure and seeded: the same start, seed and scores give the same candidates, in every engine,
 * as its transcendental math is `portable.ts`'s.
 */

import { rng } from '../../track/generate';
import { cos, exp, log } from './portable';

/** The most offsets the full covariance is kept for: its update and eigendecomposition grow as the cube of the count. */
export const FULL_LIMIT = 200;
/** Score per square metre a sample reaches past the road. */
const OUTSIDE_COST = 0.05;
/** The step size never grows past this, metres. */
const MAX_SIGMA = 3;

/** How a search starts. */
export interface CmaOptions {
  /** Initial step size, metres. */
  readonly sigma: number;
  /** Offsets race clamped to this either side of the centreline. */
  readonly limit: number;
  readonly seed: number;
  /** Force the separable form, or the full one; by default it's separable past {@link FULL_LIMIT} offsets. */
  readonly separable?: boolean;
}

/**
 * The population a generation has for `n` offsets: 4 + floor(3 ln n).
 * @param n - Offsets.
 * @returns Candidates a generation.
 */
export function populationSize(n: number): number {
  return 4 + Math.floor(3 * log(n));
}

/** One CMA-ES search. */
export class Cma {
  /** Candidates a generation. */
  public readonly lambda: number;
  public readonly separable: boolean;

  private readonly _n: number;
  private readonly _mu: number;
  private readonly _weights: number[];
  private readonly _mueff: number;
  private readonly _cc: number;
  private readonly _cs: number;
  private readonly _c1: number;
  private readonly _cmu: number;
  private readonly _damps: number;
  private readonly _chiN: number;
  private readonly _limit: number;
  private readonly _random: () => number;
  private _mean: number[];
  private _sigma: number;
  private readonly _pc: number[];
  private readonly _ps: number[];
  /** Full form: the covariance, its eigenvectors as columns and the square roots of its eigenvalues. */
  private _c: number[][] = [];
  private _b: number[][] = [];
  private _d: number[] = [];
  /** Separable form: the covariance's diagonal. */
  private readonly _diag: number[] = [];
  private _eigenAt = 0;
  private _told = 0;
  /** (1 - cs) to the power of twice the generations told, for the evolution path's normalisation. */
  private _psDecay = 1;
  /** The last generation asked, unclamped, for its update. */
  private _asked: number[][] = [];

  /**
   * @param start - The mean to search round: the best line so far.
   * @param options - Step size, road clamp, seed and form.
   */
  constructor(start: readonly number[], options: CmaOptions) {
    const n = start.length;
    const lambda = populationSize(n);
    const mu = Math.floor(lambda / 2);
    const raw = Array.from({ length: mu }, (_, i) => log(mu + 0.5) - log(i + 1));
    const sum = raw.reduce((a, b) => a + b, 0);
    const weights = raw.map((w) => w / sum);
    const mueff = 1 / weights.reduce((a, w) => a + w * w, 0);

    this.lambda = lambda;
    this.separable = options.separable ?? n > FULL_LIMIT;
    this._n = n;
    this._mu = mu;
    this._weights = weights;
    this._mueff = mueff;
    this._cc = (4 + mueff / n) / (n + 4 + (2 * mueff) / n);
    this._cs = (mueff + 2) / (n + mueff + 5);

    const c1 = 2 / ((n + 1.3) * (n + 1.3) + mueff);
    const cmu = Math.min(1 - c1, (2 * (mueff - 2 + 1 / mueff)) / ((n + 2) * (n + 2) + mueff));

    if (this.separable) {
      // A diagonal learns n numbers rather than n squared, so it can learn (n + 2) / 3 times as fast.
      this._c1 = (c1 * (n + 2)) / 3;
      this._cmu = Math.min(1 - this._c1, (cmu * (n + 2)) / 3);
    } else {
      this._c1 = c1;
      this._cmu = cmu;
    }

    this._damps = 1 + 2 * Math.max(0, Math.sqrt((mueff - 1) / (n + 1)) - 1) + this._cs;
    this._chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
    this._limit = options.limit;
    this._random = rng(options.seed);
    this._mean = start.slice();
    this._sigma = options.sigma;
    this._pc = new Array<number>(n).fill(0);
    this._ps = new Array<number>(n).fill(0);

    if (this.separable) {
      for (let i = 0; i < n; i++) this._diag.push(1);
    } else {
      this._c = identity(n);
      this._b = identity(n);
      this._d = new Array<number>(n).fill(1);
    }
  }

  /** The step size now, metres. */
  public get sigma(): number {
    return this._sigma;
  }

  /** The search's mean, clamped to the road as a candidate is: its estimate of the best line. */
  public get mean(): number[] {
    return this._mean.map((v) => Math.max(-this._limit, Math.min(this._limit, v)));
  }

  /**
   * The next generation's candidates, clamped to the road, to race.
   * @param count - How many: a whole generation for {@link Cma.tell} to learn from, or fewer for a budget's last few.
   * @returns The lines.
   */
  public ask(count = this.lambda): number[][] {
    const n = this._n;
    const asked: number[][] = [];
    const lines: number[][] = [];

    for (let k = 0; k < count; k++) {
      const z = Array.from({ length: n }, () => this._gauss());
      const x = new Array<number>(n);

      if (this.separable) {
        for (let i = 0; i < n; i++) x[i] = this._mean[i] + this._sigma * Math.sqrt(this._diag[i]) * z[i];
      } else {
        for (let i = 0; i < n; i++) {
          const row = this._b[i];
          let v = 0;

          for (let j = 0; j < n; j++) v += row[j] * this._d[j] * z[j];

          x[i] = this._mean[i] + this._sigma * v;
        }
      }

      asked.push(x);
      lines.push(x.map((v) => Math.max(-this._limit, Math.min(this._limit, v))));
    }

    this._asked = asked;

    return lines;
  }

  /**
   * Learn from the generation just asked.
   * @param totals - Each candidate's score, lower better, in the order asked; Infinity for one that didn't finish.
   * @returns False, learning nothing, unless the whole generation was asked.
   */
  public tell(totals: readonly number[]): boolean {
    const n = this._n;
    const xs = this._asked;

    if (xs.length !== this.lambda || totals.length !== xs.length) return false;

    const fitness = xs.map((x, k) => {
      let outside = 0;

      for (let i = 0; i < n; i++) {
        const clamped = Math.max(-this._limit, Math.min(this._limit, x[i]));

        outside += (x[i] - clamped) * (x[i] - clamped);
      }

      return totals[k] + OUTSIDE_COST * outside;
    });
    const order = fitness.map((_, k) => k).sort((a, b) => fitness[a] - fitness[b] || a - b);
    const old = this._mean;
    const sigma = this._sigma;
    const mean = new Array<number>(n).fill(0);

    for (let k = 0; k < this._mu; k++) {
      const x = xs[order[k]];
      const w = this._weights[k];

      for (let i = 0; i < n; i++) mean[i] += w * x[i];
    }

    const yw = mean.map((m, i) => (m - old[i]) / sigma);
    // C^-1/2 * yw: through the eigenbasis for the full form, a division for the diagonal.
    const whitened = this.separable ? yw.map((v, i) => v / Math.sqrt(this._diag[i])) : this._invSqrt(yw);
    const cs = this._cs;
    const cc = this._cc;
    const mueff = this._mueff;

    for (let i = 0; i < n; i++) this._ps[i] = (1 - cs) * this._ps[i] + Math.sqrt(cs * (2 - cs) * mueff) * whitened[i];

    const psNorm = Math.sqrt(this._ps.reduce((a, v) => a + v * v, 0));

    this._told += this.lambda;
    this._psDecay *= (1 - cs) * (1 - cs);

    const hsig = psNorm / Math.sqrt(1 - this._psDecay) / this._chiN < 1.4 + 2 / (n + 1) ? 1 : 0;

    for (let i = 0; i < n; i++) this._pc[i] = (1 - cc) * this._pc[i] + hsig * Math.sqrt(cc * (2 - cc) * mueff) * yw[i];

    const c1 = this._c1;
    const cmu = this._cmu;
    const keep = 1 - c1 - cmu;
    const lost = (1 - hsig) * cc * (2 - cc);
    const steps: number[][] = [];

    for (let k = 0; k < this._mu; k++) steps.push(xs[order[k]].map((v, i) => (v - old[i]) / sigma));

    if (this.separable) {
      for (let i = 0; i < n; i++) {
        let rankMu = 0;

        for (let k = 0; k < this._mu; k++) rankMu += this._weights[k] * steps[k][i] * steps[k][i];

        this._diag[i] = keep * this._diag[i] + c1 * (this._pc[i] * this._pc[i] + lost * this._diag[i]) + cmu * rankMu;
      }
    } else {
      const c = this._c;

      for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
          let rankMu = 0;

          for (let k = 0; k < this._mu; k++) rankMu += this._weights[k] * steps[k][i] * steps[k][j];

          const v = keep * c[i][j] + c1 * (this._pc[i] * this._pc[j] + lost * c[i][j]) + cmu * rankMu;

          c[i][j] = v;
          c[j][i] = v;
        }
      }
    }

    this._mean = mean;
    this._sigma = Math.min(MAX_SIGMA, sigma * exp((cs / this._damps) * (psNorm / this._chiN - 1)));

    // The eigenbasis lags the covariance by a few generations, as it may: it costs n cubed to refresh.
    if (!this.separable && this._told - this._eigenAt > this.lambda / (c1 + cmu) / n / 10) {
      this._eigenAt = this._told;

      const [values, vectors] = jacobi(this._c);

      this._d = values.map((v) => Math.sqrt(Math.max(v, 1e-20)));
      this._b = vectors;
    }

    return true;
  }

  /** B * D^-1 * B^T * v. */
  private _invSqrt(v: readonly number[]): number[] {
    const n = this._n;
    const b = this._b;
    const projected = new Array<number>(n);
    const out = new Array<number>(n);

    for (let j = 0; j < n; j++) {
      let s = 0;

      for (let i = 0; i < n; i++) s += b[i][j] * v[i];

      projected[j] = s / this._d[j];
    }

    for (let i = 0; i < n; i++) {
      let s = 0;

      for (let j = 0; j < n; j++) s += b[i][j] * projected[j];

      out[i] = s;
    }

    return out;
  }

  /** A standard normal sample, Box-Muller. */
  private _gauss(): number {
    return Math.sqrt(-2 * log(this._random() + 1e-12)) * cos(2 * Math.PI * this._random());
  }
}

function identity(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

/**
 * Eigendecomposition of a symmetric matrix by cyclic Jacobi rotations.
 * @param m - The matrix; left as it was.
 * @returns The eigenvalues, and the eigenvectors as columns.
 */
export function jacobi(m: readonly (readonly number[])[]): [number[], number[][]] {
  const n = m.length;
  const a = m.map((row) => row.slice());
  const v = identity(n);

  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;

    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];

    if (off < 1e-18) break;

    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;

        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];

          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }

        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];

          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }

        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];

          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  return [a.map((row, i) => row[i]), v];
}
