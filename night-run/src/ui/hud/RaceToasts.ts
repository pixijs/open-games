import type { Text } from 'pixi.js';
import { CanvasTextMetrics, Container, Sprite } from 'pixi.js';

import type { IconName } from '../art/icons';
import type { ToastTone } from '../art/panels';
import { toastSvg } from '../art/panels';
import type { SvgArt } from '../art/svg';
import type { SvgTextures } from '../art/svgTexture';
import type { RacerColor } from '../art/tokens';
import { RACERS } from '../art/tokens';
import type { Toast, UiCue } from '../contract';
import { landscapePauseX } from './layout';
import type { HudScene, HudServices } from './scene';
import { atFace, faceOf } from './sprites';
import { fit, hudText, LABEL, place, placeMiddle, resize } from './text';

const HOLD = 3.2;
const STACK = 3;
const GAP = 10;
/** A message toast wraps to at most this many lines before its words shrink */
const MAX_LINES = 3;
/** Box px over and under a wrapped message's lines */
const WRAP_PAD = { desktop: 16, phone: 13 } as const;
/** Narrowest landscape toast that still fits a name and "joined the party" on one line */
const MIN_ROW_W = 240;

interface Slot {
  readonly view: Container;
  readonly plate: Sprite;
  readonly word: Text;
  readonly leave: () => void;
  art: SvgArt | null;
  scale: number;
  busy: boolean;
  /** Its plate's height, box px: taller than the layout's for a message that wraps */
  h: number;
}

interface ToastLook {
  readonly tone: ToastTone;
  readonly text: string;
  readonly color?: RacerColor;
  readonly icon?: IconName;
  readonly cue: UiCue;
  /** A message to read in full, so it wraps instead of being cut short */
  readonly wrap?: boolean;
}

function look(toast: Toast): ToastLook {
  switch (toast.kind) {
    case 'joined':
      return { tone: 'join', text: `${toast.name} joined the party`, color: RACERS[toast.car], cue: 'join' };
    case 'left':
      return { tone: 'leave', text: `${toast.name} left the race`, cue: 'leave' };
    case 'colorReassigned':
      return {
        tone: 'info',
        text: `${RACERS[toast.from].name} was taken, so you're ${RACERS[toast.to].name.toLowerCase()}`,
        color: RACERS[toast.to],
        icon: 'driver',
        cue: 'pluck',
        wrap: true,
      };
    case 'linkCopied':
      return { tone: 'info', text: 'Link copied', icon: 'copy', cue: 'copySnap' };
    default:
      return { tone: 'warn', text: toast.text, cue: 'warn', wrap: true };
  }
}

/**
 * Toasts during a race. On desktop they stack under the timing plate, up to three, newest on top, sliding in from the
 * right; on phones one compact toast shows at a time, from the top, with a "+N more" line for the queue. Each holds
 * 3.2 s, then whips out; its plate is drawn when it shows and freed when it leaves. A message (a notice, a colour
 * swap) wraps onto a taller plate, so it reads in full.
 */
export class RaceToasts extends Container {
  private readonly _slots: Slot[] = [];
  private readonly _order: number[] = [];
  private readonly _queue: Toast[] = [];
  private readonly _more: Text;
  private readonly _services: HudServices;
  private readonly _textures: SvgTextures;
  private _scene: HudScene | null = null;
  private _x = 0;
  private _y = 0;
  private _w = 380;
  private _h = 52;
  private _compact = false;

  constructor(services: HudServices, textures: SvgTextures) {
    super();
    this._services = services;
    this._textures = textures;
    for (let i = 0; i < STACK; i++) {
      const view = new Container();
      const plate = new Sprite();
      const word = hudText({ family: 'driver', weight: '600' }, 16);

      view.addChild(plate, word);
      view.visible = false;
      this.addChild(view);
      this._slots.push({ view, plate, word, leave: () => this._leave(i), art: null, scale: 1, busy: false, h: 0 });
    }
    this._more = hudText(LABEL, 12);
    this._more.alpha = 0.8;
    this._more.visible = false;
    this.addChild(this._more);
  }

  /**
   * Lays the toasts out.
   * @param scene - The layout.
   * @param plateRight - Right edge of the timing plate, for landscape.
   */
  public layout(scene: HudScene, plateRight: number): void {
    this._scene = scene;
    const { box, spec } = scene;
    const s = box.safe;

    this._compact = box.kind !== 'desktop';
    if (box.kind === 'desktop') {
      this._w = 380;
      this._h = 52;
      this._x = box.width - s.right - this._w;
      this._y = s.top + 150;
    } else if (box.kind === 'portrait') {
      this._w = 230;
      this._h = 44;
      this._x = s.left;
      this._y = s.top + 70;
    } else {
      // Beside the timing plate when the top row has room before the pause button, else under the plate
      const x = plateRight + 7;
      const room = landscapePauseX(box, spec) - 8 - x;

      this._h = 44;
      this._w = Math.min(280, room);
      this._x = x;
      this._y = s.top;
      if (room < MIN_ROW_W) {
        this._w = 280;
        this._x = plateRight - spec.plateW;
        this._y = s.top + spec.plateH + 8;
      }
    }
    this._restack(false);
    this._updateMore();
  }

  /** Whether a box (box px) meets a toast that shows, its plate art's shadow included, so name tags keep off them */
  public blocks(left: number, top: number, w: number, h: number): boolean {
    for (const index of this._order) {
      const slot = this._slots[index];
      const art = slot.art;

      if (!art || !slot.view.visible || slot.view.alpha < 0.05) continue;
      const f = faceOf(art);
      const x = this._x - f.x;
      const y = this._slotY(index) - f.y;

      if (left < x + art.width && left + w > x && top < y + art.height && top + h > y) return true;
    }

    return false;
  }

  /** Queues a toast */
  public show(toast: Toast): void {
    this._queue.push(toast);
    this._pump();
  }

  /** Drops every toast */
  public clear(): void {
    this._queue.length = 0;
    for (let i = 0; i < this._slots.length; i++) this._free(i);
    this._order.length = 0;
    this._more.visible = false;
  }

  public override destroy(): void {
    this.clear();
    super.destroy({ children: true });
  }

  private _pump(): void {
    const scene = this._scene;
    const limit = this._compact ? 1 : STACK;

    this._updateMore();
    if (!scene) return;
    while (this._queue.length && this._order.length < limit) {
      const index = this._slots.findIndex((slot) => !slot.busy);

      if (index < 0) return;
      const toast = this._queue.shift() as Toast;

      this._present(index, toast, scene);
    }
    this._updateMore();
  }

  private _present(index: number, toast: Toast, scene: HudScene): void {
    const slot = this._slots[index];
    const l = look(toast);
    const art = this._dress(slot, l);
    const scale = Math.max(1, scene.box.scale);

    slot.busy = true;
    slot.art = art;
    slot.scale = scale;
    slot.h = faceOf(art).h;
    atFace(slot.plate, art, 0, 0);
    this._order.unshift(index);
    this._services.sound.play(l.cue);
    void this._textures.load(art, scale).then((texture) => {
      if (slot.art !== art) return;
      slot.plate.texture = texture;
      this._restack(true);
      const motion = this._services.motion;
      const y = this._slotY(index);

      motion.slot(slot.view, this._x, y, this._compact ? 0 : 60, this._compact ? -30 : 0);
      motion.punch(slot.view, 1.06);
      motion.kill(slot.leave);
      motion.delay(HOLD, slot.leave);
    });
  }

  /**
   * Sets a toast's words, draws its plate and centres the words on it. A name or a short line fits one line; a message
   * wraps at its normal size, on a plate tall enough for its lines, and only shrinks when even {@link MAX_LINES} lines
   * don't hold it. Its icon cell keeps a one-line toast's size, but a taller plate leans further, so each line count is
   * measured against its own plate.
   */
  private _dress(slot: Slot, l: ToastLook): SvgArt {
    const word = slot.word;
    const size = this._compact ? 15 : 16;
    const plate = (h: number): SvgArt =>
      toastSvg(l.tone, { width: this._w, height: h, color: l.color, icon: l.icon, cell: this._h - 8 });
    const textWidth = (art: SvgArt): number => (art.content ?? faceOf(art)).w - 8;
    const left = (art: SvgArt): number => (art.content ?? faceOf(art)).x - faceOf(art).x;

    word.style.wordWrap = false;
    word.style.lineHeight = 0;
    if (!l.wrap) {
      const art = plate(this._h);

      fit(word, l.text, size, textWidth(art));
      placeMiddle(word, left(art), this._h / 2, 'left');

      return art;
    }
    const pad = this._compact ? WRAP_PAD.phone : WRAP_PAD.desktop;
    let art = plate(this._h);
    let lines = 1;

    word.text = l.text;
    word.style.wordWrap = true;
    for (const s of [size, Math.round(size * 0.85)]) {
      resize(word, s);
      word.style.lineHeight = Math.round(s * 1.2);
      for (lines = 1; lines <= MAX_LINES; lines++) {
        art = plate(lines === 1 ? this._h : lines * word.style.lineHeight + pad * 2);
        word.style.wordWrapWidth = textWidth(art);
        if (CanvasTextMetrics.measureText(l.text, word.style).lines.length <= lines) break;
      }
      if (lines <= MAX_LINES) break;
    }
    lines = Math.min(lines, MAX_LINES);
    word.anchor.set(0, 0);
    word.position.set(left(art), (faceOf(art).h - lines * word.style.lineHeight) / 2);

    return art;
  }

  private _leave(index: number): void {
    const slot = this._slots[index];

    if (!slot.busy) return;
    this._services.motion.whip(slot.view, this._compact ? 0 : 60, this._compact ? -20 : 0);
    this._services.motion.delay(0.25, () => {
      this._free(index);
      this._restack(true);
      this._pump();
    });
  }

  private _free(index: number): void {
    const slot = this._slots[index];

    this._services.motion.kill(slot.leave, slot.view, slot.view.position, slot.view.scale);
    slot.view.visible = false;
    if (slot.art) this._textures.release(slot.art, slot.scale);
    slot.art = null;
    slot.busy = false;
    const at = this._order.indexOf(index);

    if (at >= 0) this._order.splice(at, 1);
  }

  /** A toast's top: under the newer toasts above it, each as tall as its own plate */
  private _slotY(index: number): number {
    let y = this._y;

    for (const above of this._order) {
      if (above === index) break;
      y += this._slots[above].h + GAP;
    }

    return y;
  }

  private _restack(animate: boolean): void {
    const motion = this._services.motion;

    for (const index of this._order) {
      const view = this._slots[index].view;

      if (!view.visible) continue;
      const y = this._slotY(index);

      if (animate && !motion.reduced)
        motion.to(view.position, { x: this._x, y, duration: 0.32, ease: 'back.out(1.7)' });
      else view.position.set(this._x, y);
    }
  }

  /** The "+N more" line, under the toast that shows */
  private _updateMore(): void {
    const more = this._compact ? this._queue.length : 0;
    const shown = this._order.length ? this._slots[this._order[0]].h : this._h;

    this._more.visible = more > 0;
    if (more > 0) this._more.text = `+${more} more`;
    place(this._more, this._x + 6, this._y + shown + 16);
  }
}
