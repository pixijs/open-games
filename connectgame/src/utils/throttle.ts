const map: Record<string, unknown> = {};

/**
 * Throtle function calls to a minimum interval, in millisecons, using a name as reference for simplicity
 * @param name The name in which the throle function will store timeouts
 * @param interval The minimum interval between calls in milliseconds
 * @param fn The throttled function
 * @returns
 */
export function throttle(name: string, interval: number, fn: () => void) {
    if (map[name]) return;
    fn();
    map[name] = setTimeout(() => delete map[name], interval);
}
