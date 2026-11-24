/**
 * Which floodlight towers the set's few spot lights stand on, when a track has more towers than lights. Pure, so the
 * plan checks rank the same way the game does.
 */

/** How often the lights are ranked again, in seconds. */
export const RANK_INTERVAL = 0.25;
/** A tower outside the lit ones takes a light only once it's this much nearer the focus than the farthest lit one. */
export const RANK_MARGIN = 5;
/** A light that has just been given a tower keeps it this long: its fade out, its move and its fade in. */
export const MOVE_HOLD = 1;

/**
 * Lights for the towers whose aim points are nearest a focus point: the road just ahead of what the camera watches.
 * A light stays on its tower until a tower outside the lit ones is {@link RANK_MARGIN} nearer than the farthest lit
 * one, so lights don't flit between two towers about as near; the nearest tower of all is always lit, whatever the
 * margin. A light that has just moved holds for {@link MOVE_HOLD}.
 */
export class LampPool {
  /** The tower each light is given to, in light order; -1 for a light with no tower. */
  public readonly towers: number[];

  private readonly _aims: readonly number[];
  private readonly _distance: Float64Array;
  private readonly _lit: Uint8Array;
  private readonly _heldUntil: Float64Array;
  private _cold = true;

  /**
   * @param aims - Each tower's aim point, x then z.
   * @param lights - How many lights there are.
   */
  constructor(aims: readonly number[], lights: number) {
    const count = aims.length / 2;

    this._aims = aims;
    this._distance = new Float64Array(count);
    this._lit = new Uint8Array(count);
    this._heldUntil = new Float64Array(lights);
    this.towers = [];

    for (let i = 0; i < lights; i++) {
      this.towers.push(i < count ? i : -1);
      if (i < count) this._lit[i] = 1;
    }
  }

  /** Whether there are more towers than lights, so the lights move. */
  public get ranked(): boolean {
    return this._distance.length > this.towers.length;
  }

  /**
   * Give the lights to the towers nearest the focus. The first call lights the nearest outright; later ones move at
   * most what the margin and the hold allow.
   * @param x - The focus point, x.
   * @param z - The focus point, z.
   * @param now - Seconds on any steady clock.
   * @returns Whether it was the first call, after which the lights should be placed at once, not faded over.
   */
  public rank(x: number, z: number, now: number): boolean {
    const distance = this._distance;
    const lit = this._lit;
    const towers = this.towers;

    for (let t = 0; t < distance.length; t++) {
      distance[t] = Math.hypot(this._aims[t * 2] - x, this._aims[t * 2 + 1] - z);
    }

    if (this._cold) {
      const order = [...distance.keys()].sort((a, b) => distance[a] - distance[b]);

      lit.fill(0);

      for (let i = 0; i < towers.length; i++) {
        towers[i] = i < order.length ? order[i] : -1;
        if (towers[i] >= 0) lit[towers[i]] = 1;
      }

      this._cold = false;

      return true;
    }

    for (let moves = 0; moves < towers.length; moves++) {
      let nearest = -1;
      let nearestLit = Infinity;

      for (let t = 0; t < distance.length; t++) {
        if (lit[t]) nearestLit = Math.min(nearestLit, distance[t]);
        else if (nearest < 0 || distance[t] < distance[nearest]) nearest = t;
      }

      if (nearest < 0) return false;

      // The free light that stands on the farthest lit tower.
      let free = -1;

      for (let i = 0; i < towers.length; i++) {
        if (now < this._heldUntil[i]) continue;
        if (free < 0 || towers[i] < 0 || (towers[free] >= 0 && distance[towers[i]] > distance[towers[free]])) {
          free = i;
        }
      }

      if (free < 0) return false;

      const from = towers[free];
      const closest = distance[nearest] < nearestLit;

      if (from >= 0 && !closest && distance[nearest] + RANK_MARGIN > distance[from]) return false;

      if (from >= 0) lit[from] = 0;

      lit[nearest] = 1;
      towers[free] = nearest;
      this._heldUntil[free] = now + MOVE_HOLD;
    }

    return false;
  }
}
