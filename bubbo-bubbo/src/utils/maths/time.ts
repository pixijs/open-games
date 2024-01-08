/**
 * Converts a number of milliseconds to the default scalar time in Pixi (60 fps).
 * @param ms - The number of milliseconds to convert.
 * @returns The equivalent time in the default scalar time of Pixi.
 */
export function toDefaultScalarTime(ms: number) {
    return (ms * 60) / 1000; // default scalar time in Pixi (60 fps)
}

/**
 * Converts a number of milliseconds to seconds.
 * @param ms - The number of milliseconds to convert.
 * @returns The equivalent time in seconds.
 */
export function toSeconds(ms: number) {
    return ms / 1000; // gsap uses seconds base
}
