import type { Bounds } from 'pixi.js';

import type { NavInput } from '../contract';
import type { Focusable } from './kit';

type Dir = Exclude<NavInput, 'confirm' | 'back'>;

const DIRS: Record<Dir, readonly [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/**
 * The things one screen (or dialog) lets keys and a gamepad focus. Arrows move to the nearest item that way, weighting
 * sideways drift twice as much as distance, so a column of buttons and a grid of keys both read naturally.
 */
export class FocusGroup {
  private readonly _items: Focusable[] = [];
  private _default: Focusable | null = null;
  private _current: Focusable | null = null;

  public get current(): Focusable | null {
    return this._current;
  }

  /** Adds an item; `isDefault` makes it the one the first arrow or a key-driven enter focuses. */
  public add(item: Focusable, isDefault = false): void {
    this._items.push(item);
    if (isDefault || !this._default) this._default = item;
  }

  public remove(item: Focusable): void {
    const i = this._items.indexOf(item);

    if (i >= 0) this._items.splice(i, 1);
    if (this._current === item) this._current = null;
    if (this._default === item) this._default = this._items[0] ?? null;
  }

  public setDefault(item: Focusable): void {
    this._default = item;
  }

  /** Focuses `item`, or the default when `item` is missing or null. */
  public focus(item?: Focusable | null): void {
    item ??= this._default;
    if (item && !item.focusable) item = this._items.find((it) => it.focusable) ?? null;
    if (this._current === item) return;
    this._current?.setFocused(false);
    this._current = item;
    item?.setFocused(true);
  }

  /** Where the focus is, so a rebuilt screen can put it back on the same control: its label and its place. */
  public mark(): { label: string; index: number } | null {
    const cur = this._current;

    return cur ? { label: cur.node.label, index: this._items.indexOf(cur) } : null;
  }

  /** The item a {@link FocusGroup.mark} points at in this group: the same label, nearest the same place. */
  public find(mark: { label: string; index: number } | null): Focusable | null {
    if (!mark || !mark.label) return null;
    let best: Focusable | null = null;
    let gap = Infinity;

    this._items.forEach((item, i) => {
      if (item.node.label !== mark.label || Math.abs(i - mark.index) >= gap) return;
      gap = Math.abs(i - mark.index);
      best = item;
    });

    return best;
  }

  /** Drops the focus ring; the next key focuses the default again. */
  public blur(): void {
    this._current?.setFocused(false);
    this._current = null;
  }

  /** Handles one menu input; returns whether it did anything. `back` is the screen's job. */
  public navigate(input: NavInput): boolean {
    if (input === 'back') return false;
    if (input === 'confirm') {
      if (!this._current?.focusable) return false;
      this._current.activate();

      return true;
    }
    if (!this._current || !this._current.focusable) {
      this.focus();

      return !!this._current;
    }
    const next = this._nearest(this._current, DIRS[input]);

    if (!next) return true;
    this.focus(next);

    return true;
  }

  public clear(): void {
    this._current?.setFocused(false);
    this._items.length = 0;
    this._current = null;
    this._default = null;
  }

  private _nearest(from: Focusable, [dx, dy]: readonly [number, number]): Focusable | null {
    const a = centre(from.node.getBounds());
    let best: Focusable | null = null;
    let bestScore = Infinity;

    for (const item of this._items) {
      if (item === from || !item.focusable) continue;
      const b = centre(item.node.getBounds());
      const along = (b.x - a.x) * dx + (b.y - a.y) * dy;

      if (along <= 1) continue;
      const across = Math.abs((b.x - a.x) * dy) + Math.abs((b.y - a.y) * dx);
      const score = along + across * 2;

      if (score < bestScore) {
        bestScore = score;
        best = item;
      }
    }

    return best;
  }
}

function centre(b: Bounds): { x: number; y: number } {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
