import { CanvasTextMetrics, Container, Rectangle, Sprite, Texture } from 'pixi.js';

import type { IconName } from '../art/icons';
import type { ToastTone } from '../art/panels';
import { toastSvg } from '../art/panels';
import type { RacerColor } from '../art/tokens';
import { COLORS, MOTION, RACERS } from '../art/tokens';
import type { Toast, UiCue } from '../contract';
import { ArtSprite } from './ArtSprite';
import type { UiKit } from './kit';
import { Motion } from './Motion';
import { fitText, makeText } from './text';

/** The menu toasts: the game's, plus the share sheet's result, which only the UI knows about. */
export type MenuToast = Toast | { kind: 'shared' };

/** Where desktop toasts hang: a side of the box, or its middle, with the front toast's top edge at `top`. */
export interface ToastHang {
  readonly side: 'left' | 'centre' | 'right';
  readonly top: number;
}

/** The screen showing, as far as its toasts care: the room it keeps clear for them. */
export interface ToastScreen {
  /** On a phone, the box y the front toast's bottom edge sits on, or null for the layout's own band */
  toastBottom(): number | null;
  /** On desktop, where the toasts hang */
  toastHang(): ToastHang;
  /** On a phone held sideways, the side of the box the toasts keep to */
  toastSide(): 'left' | 'right';
}

interface Item {
  readonly toast: MenuToast;
  readonly node: Container;
  readonly motion: Motion;
  leaving: boolean;
  /** Its time is running: it reached the front of the queue */
  shown: boolean;
  /** performance.now() its time started, and when it runs out */
  shownAt: number;
  endsAt: number;
  timer: ReturnType<Motion['delay']> | null;
}

interface ToastLook {
  readonly tone: ToastTone;
  readonly text: string;
  /** A second line under the text, in mist */
  readonly sub?: string;
  readonly color?: RacerColor;
  readonly icon?: IconName;
  readonly cue: UiCue;
  readonly pitch: number;
}

/** Where a toast sits: its face's bottom-centre in box px, its scale and alpha. */
interface Place {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly alpha: number;
}

const STAY_S = 3.2;
/** A toast with another waiting behind it gives way after this long */
const HURRY_S = 1.6;
/** Toasts queued behind the one showing; the oldest waiting one drops out past this */
const QUEUE_MAX = 3;
/** How far each waiting toast peeks out above the one in front, how much smaller and fainter it is */
const PEEK_Y = 7;
const PEEK_SCALE = 0.05;
const PEEK_ALPHA = [1, 0.8, 0.5, 0];

/** What a toast says and how it looks. */
function lookOf(toast: MenuToast, wide: boolean): ToastLook {
  switch (toast.kind) {
    case 'joined':
      return {
        tone: 'join',
        text: `${toast.name} joined the party`,
        color: RACERS[toast.car],
        cue: 'pluck',
        pitch: 1.25,
      };
    case 'left':
      return { tone: 'leave', text: `${toast.name} left the party`, cue: 'pluck', pitch: 0.8 };
    case 'colorReassigned':
      return {
        tone: 'info',
        text: `${RACERS[toast.from].name} was taken, so you're ${RACERS[toast.to].name.toLowerCase()}`,
        color: RACERS[toast.to],
        icon: 'driver',
        cue: 'pluck',
        pitch: 1,
      };
    case 'linkCopied':
      return {
        tone: 'info',
        text: wide ? 'Invite link copied. Paste it to your friends.' : 'Link copied',
        icon: 'copy',
        cue: 'pluck',
        pitch: 1.12,
      };
    case 'shared':
      return {
        tone: 'info',
        text: 'Shared',
        sub: 'Keep this page open while your friends join.',
        icon: 'share',
        cue: 'pluck',
        pitch: 1.12,
      };
    case 'notice':
      return { tone: 'info', text: toast.text, cue: 'pluck', pitch: 1 };
  }
}

/**
 * The menu toasts, one at a time, so a burst of them never covers more of a screen than one does. The one in front
 * slides in with its icon cell punching, stays 3.2 s and whips out; the rest queue behind it as smaller, fainter cards
 * peeking out past it, and while one waits the front gives way after 1.6 s. On desktop the queue hangs near the top
 * edge where the screen leaves room, and the waiting cards peek out below; on a phone it sits on a band the screen
 * keeps clear, and they peek out above. A resize redraws them for the new layout. In a race the HUD shows toasts
 * instead.
 */
export class ToastStack {
  public readonly container = new Container();
  private readonly _kit: UiKit;
  private readonly _screen: () => ToastScreen | null;
  /** Oldest first */
  private readonly _items: Item[] = [];

  /** `screen` is the screen showing, which says where its toasts go. */
  constructor(kit: UiKit, screen: () => ToastScreen | null) {
    this._kit = kit;
    this._screen = screen;
    this.container.eventMode = 'none';
  }

  public push(toast: MenuToast): void {
    const item: Item = {
      toast,
      node: new Container(),
      motion: new Motion(),
      leaving: false,
      shown: false,
      shownAt: 0,
      endsAt: 0,
      timer: null,
    };
    const look = lookOf(toast, false);

    this.container.addChild(item.node);
    this._paint(item);
    this._items.push(item);
    this._kit.sound.play(look.cue, look.pitch);
    const waiting = this._live().filter((i) => !i.shown);

    while (waiting.length > QUEUE_MAX) this._drop(waiting.shift()!);
    const front = this._live().find((i) => i.shown);

    if (front) {
      this._hurry(front);
      this._restack(true, item);
    } else this._toFront(item, true);
  }

  /** Redraws every toast for the layout and puts it where the layout wants it (after a resize or rotation). */
  public relayout(): void {
    for (const item of this._live()) {
      item.motion.stop(item.node, item.node.scale);
      this._paint(item);
    }
    this._restack(false);
  }

  /** The screen changed: the toasts move to the band the new screen keeps for them. */
  public restack(): void {
    this._restack(true);
  }

  public clear(): void {
    for (const item of this._items.slice()) this._drop(item);
  }

  public destroy(): void {
    this.clear();
    this.container.destroy({ children: true });
  }

  private _live(): Item[] {
    return this._items.filter((i) => !i.leaving);
  }

  private _start(item: Item, seconds: number): void {
    item.shown = true;
    item.shownAt = performance.now();
    item.endsAt = item.shownAt + seconds * 1000;
    item.timer = item.motion.delay(seconds, () => this._leave(item));
  }

  /** `item` comes to the front: its time starts and its icon cell punches. */
  private _toFront(item: Item, entering: boolean): void {
    this._start(item, this._live().some((i) => !i.shown && i !== item) ? HURRY_S : STAY_S);
    this._restack(true, entering ? item : null);
    this._punchCell(item);
  }

  /** Something waits behind the front toast: it gives way once it has shown for {@link HURRY_S}. */
  private _hurry(front: Item): void {
    const now = performance.now();
    const left = Math.max(0, HURRY_S - (now - front.shownAt) / 1000);

    if (front.endsAt - now <= left * 1000) return;
    front.timer?.kill();
    front.endsAt = now + left * 1000;
    front.timer = front.motion.delay(left, () => this._leave(front));
  }

  /** Draws the toast's plate and words into its node, its pivot at the face's bottom-centre. */
  private _paint(item: Item): void {
    const L = this._kit.layout;
    const look = lookOf(item.toast, L.kind === 'd');
    const { w, h } = this._size(item);
    const art = toastSvg(look.tone, { width: w, height: h, color: look.color, icon: look.icon });
    const f = art.face!;
    const c = art.content!;
    const plate = new ArtSprite(this._kit.textures, art, L.density);
    const size = L.kind === 'd' ? 16 : L.kind === 'l' ? 14 : 15;
    const max = c.w - 8;
    let text = makeText(look.text, 0, 0, { s: size, w: 600 }, L.textResolution);
    let lines = 1;
    let line = size;

    // Too long for one line: two smaller lines rather than an ellipsis, unless even two won't hold it
    if (text.width > max && !look.sub) {
      text.destroy();
      line = Math.round((size - 2) * 1.15);
      text = makeText(look.text, 0, 0, { s: size - 2, w: 600, wrap: max, lh: 1.15 }, L.textResolution);
      lines = CanvasTextMetrics.measureText(look.text, text.style).lines.length;
      if (lines > 2) {
        text.destroy();
        text = makeText(look.text, 0, 0, { s: size, w: 600, max }, L.textResolution);
        lines = 1;
        line = size;
      }
    } else if (text.width > max) fitText(text, max);

    this._unpaint(item);
    plate.position.set(-f.x, -f.y);
    item.node.addChild(plate, text);
    if (look.sub) {
      const subSize = size - 3;
      const sub = makeText(look.sub, 0, 0, { s: subSize, c: COLORS.mist, max: c.w - 8 }, L.textResolution);
      const top = c.y - f.y + (h - size - subSize - 5) / 2;

      text.position.set(c.x - f.x, top);
      sub.position.set(c.x - f.x, top + size + 5);
      item.node.addChild(sub);
    } else text.position.set(c.x - f.x, c.y - f.y + (h - line * lines) / 2);
    item.node.pivot.set(w / 2, h);
  }

  private _unpaint(item: Item): void {
    for (const child of item.node.removeChildren()) {
      item.motion.stop(child, child.scale);
      if (child instanceof Sprite && !(child instanceof ArtSprite) && child.texture.source !== Texture.EMPTY.source) {
        child.texture.destroy(false);
      }
      child.destroy({ children: true });
    }
  }

  private _size(item: Item): { w: number; h: number } {
    const L = this._kit.layout;
    const tall = item.toast.kind === 'shared' ? 16 : 0;

    if (L.kind === 'd') return { w: 420, h: 52 + tall };
    if (L.kind === 'p') return { w: L.W - L.safe.l - L.safe.r, h: 46 + tall };

    return { w: 256, h: 46 + tall };
  }

  /**
   * Where every live toast goes, back to front. A waiting card's far edge peeks out {@link PEEK_Y} per place past the
   * front one's (its bottom on desktop, its top on a phone), and a taller one never pokes out at the near edge.
   */
  private _places(): [Item, Place][] {
    const L = this._kit.layout;
    const live = this._live();
    const queue = [...live.filter((i) => i.shown), ...live.filter((i) => !i.shown)];
    const out: [Item, Place][] = [];

    if (!queue.length) return out;
    const screen = this._screen();
    const desk = L.kind === 'd';
    const front = this._size(queue[0]).h;
    const hang = desk ? (screen?.toastHang() ?? { side: 'centre', top: L.safe.t }) : null;
    const bottom = screen?.toastBottom() ?? (L.kind === 'p' ? L.H - L.safe.b - 100 : L.H - L.safe.b - 58);
    const top = hang ? hang.top : bottom - front;
    const side = hang ? hang.side : (screen?.toastSide() ?? 'left');

    for (let k = queue.length - 1; k >= 0; k--) {
      const item = queue[k];
      const { w, h } = this._size(item);
      const scale = 1 - PEEK_SCALE * k;
      const tall = h * scale;
      const y = desk ? Math.max(top + front + PEEK_Y * k, top + tall) : Math.min(top + front, top - PEEK_Y * k + tall);
      const x = side === 'left' ? L.safe.l + w / 2 : side === 'right' ? L.W - L.safe.r - w / 2 : L.W / 2;

      out.push([item, { x, y, scale, alpha: PEEK_ALPHA[Math.min(k, 3)] }]);
    }

    return out;
  }

  /** Which way a toast comes in from and goes out to: the edge its queue hangs from, up on desktop, down on a phone. */
  private get _edge(): number {
    return this._kit.layout.kind === 'd' ? -1 : 1;
  }

  /** Moves every live toast to its place; `entering` slides in from the queue's edge. */
  private _restack(animate: boolean, entering: Item | null = null): void {
    for (const [item, at] of this._places()) {
      // Back to front, so the toast in front draws on top.
      this.container.addChild(item.node);
      if (item === entering) this._enter(item, at);
      else this._move(item, at, animate);
    }
  }

  private _move(item: Item, at: Place, animate: boolean): void {
    const node = item.node;
    const m = item.motion;

    if (node.x === at.x && node.y === at.y && node.scale.x === at.scale && node.alpha === at.alpha) return;
    m.stop(node, node.scale);
    if (!animate || m.reduced) {
      node.position.set(at.x, at.y);
      node.scale.set(at.scale);
      node.alpha = at.alpha;

      return;
    }
    m.to(node, { x: at.x, y: at.y, alpha: at.alpha, ...MOTION.slot });
    m.to(node.scale, { x: at.scale, y: at.scale, ...MOTION.slot });
  }

  private _enter(item: Item, at: Place): void {
    const node = item.node;
    const m = item.motion;

    node.position.set(at.x, at.y);
    node.scale.set(at.scale);
    if (m.reduced) {
      m.fromTo(node, { alpha: 0 }, { alpha: at.alpha, duration: 0.15 });

      return;
    }
    m.fromTo(node, { y: at.y + 30 * this._edge, alpha: 0 }, { y: at.y, alpha: at.alpha, ...MOTION.slot });
  }

  /** The icon cell punches: a crop of the toast's own cell scaled from 1.35 about its centre. */
  private _punchCell(item: Item): void {
    const plate = item.node.children[0];

    if (!(plate instanceof ArtSprite) || item.motion.reduced) return;
    void plate.loaded.then(() => {
      if (item.leaving || plate.destroyed || plate.texture === Texture.EMPTY) return;
      const f = plate.art.face!;
      const frame = new Rectangle(f.x + 2, f.y + 2, f.h * 1.05 + 6, f.h - 4);
      const cell = new Sprite(new Texture({ source: plate.texture.source, frame }));

      cell.anchor.set(0.5);
      cell.position.set(plate.x + frame.x + frame.width / 2, plate.y + frame.y + frame.height / 2);
      item.node.addChild(cell);
      item.motion.fromTo(
        cell.scale,
        { x: 1.35, y: 1.35 },
        {
          x: 1,
          y: 1,
          ...MOTION.punch,
          onComplete: () => {
            cell.texture.destroy(false);
            cell.destroy();
          },
        },
      );
    });
  }

  /** Whips a toast out toward its queue's edge; the next one waiting comes forward. */
  private _leave(item: Item): void {
    if (item.leaving) return;
    item.leaving = true;
    item.timer = null;
    item.motion.kill();
    item.motion.to(item.node, {
      y: item.node.y + 24 * this._edge,
      alpha: 0,
      ...MOTION.whip,
      onComplete: () => this._drop(item),
    });
    const next = this._live().find((i) => !i.shown);

    if (next) this._toFront(next, false);
    else this._restack(true);
  }

  private _drop(item: Item): void {
    const i = this._items.indexOf(item);

    if (i >= 0) this._items.splice(i, 1);
    this._unpaint(item);
    item.motion.destroy();
    item.node.destroy({ children: true });
  }
}
