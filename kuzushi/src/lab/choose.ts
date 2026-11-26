/** `value` when `list` holds it, else `fallback`: a stored or typed string narrowed to one of a fixed list. */
export const oneOf = <T, F>(list: ReadonlyArray<T>, value: unknown, fallback: F): T | F => list.find((each) => each === value) ?? fallback

/** A guard for the values `list` holds. */
export const isOneOf = <T>(list: ReadonlyArray<T>) => (value: unknown): value is T => list.some((each) => each === value)

/** The option `by` places after `value` in `options`, wrapping round. */
export const after = <T>(options: ReadonlyArray<T>, value: T, by = 1): T | undefined =>
  options[(options.indexOf(value) + by + options.length) % options.length]
