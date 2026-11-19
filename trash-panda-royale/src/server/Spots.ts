/**
 * Entities with their positions copied out as plain numbers, for broad phases: an N×M loop
 * over schema instances pays a getter per field read, which is most of what those loops
 * cost. Copy once, filter on the copies, and touch the live entity only for a real
 * candidate. Reused from step to step (`reset`), so it allocates nothing once warm.
 */
export class Spots<T> {
  n = 0;
  readonly items: T[] = [];
  readonly keys: string[] = [];
  readonly x: number[] = [];
  readonly z: number[] = [];

  reset(): this {
    this.n = 0;
    return this;
  }

  add(key: string, item: T, x: number, z: number) {
    const i = this.n++;
    this.keys[i] = key;
    this.items[i] = item;
    this.x[i] = x;
    this.z[i] = z;
  }
}
