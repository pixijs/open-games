/**
 * Linear interpolation between two values.
 * @param x - Starting value.
 * @param y - Ending value.
 * @param t - Interpolation factor (0 to 1).
 * @returns The interpolated value.
 */
export function lerp(x: number, y: number, t: number): number {
    return (1 - t) * x + t * y;
}
