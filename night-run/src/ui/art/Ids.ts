/**
 * Hands out ids that are unique inside one document, so primitives can be layered into one SVG without their
 * gradients colliding. Deterministic: the same calls give the same ids.
 */
export class Ids {
  private _next = 0;

  /** A fresh id starting with `prefix`. */
  public get(prefix: string): string {
    return `${prefix}${this._next++}`;
  }
}
