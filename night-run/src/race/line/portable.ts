/**
 * `exp`, `log` and `cos` from IEEE arithmetic alone, so the line search hands out the same candidates in every
 * engine. `Math`'s versions are only approximated by the spec, and Chrome's and Node's differ in the last bit on a few
 * percent of arguments: through CMA-ES's sampling and update that's enough for a search in the game to wander off
 * the one the bot checks run in Node. Addition, multiplication, division and `Math.sqrt` are exact in every engine.
 * Within a few units in the last place (the cosine's in absolute terms), which is all the search needs. Pure.
 */

const LN2 = 0.6931471805599453;
const HALF_PI = 1.5707963267948966;

/**
 * The natural logarithm.
 * @param x - A positive finite number.
 * @returns ln x.
 */
export function log(x: number): number {
  let m = x;
  let e = 0;

  // m in [1/sqrt 2, sqrt 2), by exact halvings and doublings.
  while (m >= 1.4142135623730951) {
    m /= 2;
    e++;
  }

  while (m < 0.7071067811865476) {
    m *= 2;
    e--;
  }

  // ln m = 2 atanh t, t = (m - 1) / (m + 1), |t| < 0.172.
  const t = (m - 1) / (m + 1);
  const t2 = t * t;
  let term = t;
  let sum = 0;

  for (let k = 1; k < 40; k += 2) {
    sum += term / k;
    term *= t2;
  }

  return e * LN2 + 2 * sum;
}

/**
 * e to a power.
 * @param x - A finite number, |x| under 700.
 * @returns e^x.
 */
export function exp(x: number): number {
  const k = Math.round(x / LN2);
  const r = x - k * LN2;
  let term = 1;
  let sum = 1;

  for (let n = 1; n < 24; n++) {
    term *= r / n;
    sum += term;
  }

  for (let i = 0; i < k; i++) sum *= 2;
  for (let i = 0; i > k; i--) sum /= 2;

  return sum;
}

/**
 * The cosine.
 * @param x - An angle in radians, |x| under a few thousand.
 * @returns cos x.
 */
export function cos(x: number): number {
  // To a quarter turn's offset r from a multiple q of a quarter turn: cos x = +-cos r or +-sin r.
  const q = Math.round(x / HALF_PI);
  const r = x - q * HALF_PI;
  const quarter = ((q % 4) + 4) % 4;
  const r2 = r * r;
  let c = 1;
  let s = r;
  let cTerm = 1;
  let sTerm = r;

  for (let n = 1; n < 12; n++) {
    cTerm *= -r2 / ((2 * n - 1) * (2 * n));
    sTerm *= -r2 / (2 * n * (2 * n + 1));
    c += cTerm;
    s += sTerm;
  }

  return quarter === 0 ? c : quarter === 1 ? -s : quarter === 2 ? -c : s;
}
