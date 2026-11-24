export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(x: number, y: number, t: number): number {
  return (1 - t) * x + t * y;
}

/** 0 to 1 with an eased start and end; `t` is clamped to 0 to 1 first. */
export function smoothstep(t: number): number {
  const k = clamp(t, 0, 1);

  return k * k * (3 - 2 * k);
}
