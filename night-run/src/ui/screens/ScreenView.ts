import type { Text } from 'pixi.js';
import { Container, Sprite, Texture } from 'pixi.js';

import type { ButtonVariant } from '../art/buttons';
import type { IconName } from '../art/icons';
import { scrimSvg } from '../art/motifs';
import type { PanelOptions } from '../art/panels';
import { panelSvg } from '../art/panels';
import type { Box, SvgArt } from '../art/svg';
import { COLORS, MOTION } from '../art/tokens';
import type { NavInput, Screen } from '../contract';
import { ArtSprite } from '../kit/ArtSprite';
import type { Button } from '../kit/Button';
import { iconButton, textButton } from '../kit/buttons';
import { FocusGroup } from '../kit/FocusGroup';
import type { Insets, LayoutKind, UiLayout } from '../kit/layout';
import { Meter } from '../kit/Meter';
import { Motion } from '../kit/Motion';
import { SlicedArt } from '../kit/SlicedArt';
import type { ToastHang } from '../kit/ToastStack';
import type { TextSpec } from '../kit/text';
import { makeText } from '../kit/text';
import type { ScreenHost } from './ScreenHost';

/** Where a piece of art landed: its whole box, its face and its content box, in screen px. */
export interface Placed {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly f: Box;
  readonly c: Box;
}

/** A row's text and icon from {@link ScreenView.inbox}. */
export interface InboxRow {
  readonly text: Text | null;
  readonly icon: ArtSprite | null;
}

export interface InboxSpec extends TextSpec {
  readonly gap?: number;
  readonly pl?: number;
  readonly pr?: number;
  readonly dy?: number;
}

/** What {@link ScreenView.put} takes besides the art. */
export interface PutOptions {
  readonly scale?: number;
  readonly opacity?: number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Seconds an exiting item takes to fade; the next screen's enter waits about this long. */
export const EXIT_FADE = 0.14;

/** Whether two screen descriptions draw the same screen. */
function sameData(a: Screen, b: Screen): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * One screen: it builds its children from its data and the layout box, enters with the shared choreography (title,
 * panel, then items, from 40 px left, leaning, staggered, with the `slot` ease) and exits with `whip`, fading first so
 * the next screen enters onto a clear stage. A screen already showing gets `update`: the same data again does nothing,
 * new data rebuilds in place without the enter; screens with their own juice (the lobby, the join entry) override it.
 */
export abstract class ScreenView<D extends Screen = Screen> {
  public readonly root = new Container();
  public data: D;
  protected readonly host: ScreenHost;
  protected readonly focus = new FocusGroup();
  protected readonly motion = new Motion();
  private _content = new Container();
  private _target: Container = this._content;
  private _groups: Container[] = [];
  private _fades: Container[] = [];
  private _loads: Promise<void>[] = [];
  private _disposers: (() => void)[] = [];
  private _destroyed = false;
  private _leaving = false;
  /** Keys just took over and the ring went to the default: the first arrow only shows where it is */
  private _revealed = false;

  constructor(host: ScreenHost, data: D) {
    this.host = host;
    this.data = data;
    this.root.addChild(this._content);
    this.root.eventMode = 'passive';
  }

  protected get L(): UiLayout {
    return this.host.kit.layout;
  }

  protected get k(): LayoutKind {
    return this.host.kit.layout.kind;
  }

  protected get W(): number {
    return this.host.kit.layout.W;
  }

  protected get H(): number {
    return this.host.kit.layout.H;
  }

  protected get S(): Insets {
    return this.host.kit.layout.safe;
  }

  protected get destroyed(): boolean {
    return this._destroyed;
  }

  /** Builds the screen's children into the current target for the current data and layout. */
  protected abstract build(): void;

  /** Builds the first time. */
  public mount(): void {
    this.build();
  }

  /** Rebuilds for new data or a new layout: the new tree first, then the old one goes, so shared textures stay. */
  public rebuild(): void {
    if (this._destroyed) return;
    const old = this._content;
    const mark = this.focus.mark();

    this.motion.kill();
    this.focus.clear();
    this._dispose();
    this._content = new Container();
    this._target = this._content;
    this._groups = [];
    this._fades = [];
    this._loads = [];
    this.root.addChildAt(this._content, 0);
    this.build();
    old.destroy({ children: true });
    if (this.host.kit.keys && !this.focus.current) this.focus.focus(this.focus.find(mark));
  }

  /** The screen is showing and the game sent its data again: nothing happens unless something in it changed. */
  public update(data: D): void {
    if (sameData(this.data, data)) {
      this.data = data;

      return;
    }
    this.data = data;
    this.rebuild();
  }

  /** The layout changed. */
  public relayout(): void {
    this.rebuild();
  }

  /**
   * Waits for the screen's textures (briefly) and `delay` seconds (the last screen's exit), then plays the enter. A
   * screen told to leave while it waited never shows: the next one has the stage.
   */
  public async enter(delay = 0): Promise<void> {
    this.root.visible = false;
    await Promise.all([Promise.race([Promise.all(this._loads), wait(900)]), wait(delay * 1000)]);
    if (this._destroyed || this._leaving) return;
    this.root.visible = true;
    this.host.kit.sound.play('whooshUp');
    const reduced = this.motion.reduced;

    for (const g of this._fades) this.motion.fromTo(g, { alpha: 0 }, { alpha: 1, duration: reduced ? 0.15 : 0.3 });
    const n = this._groups.length;
    const step = n > 1 ? Math.min(MOTION.stagger, 0.13 / (n - 1)) : 0;

    this._groups.forEach((g, i) => {
      if (reduced) {
        this.motion.fromTo(g, { alpha: 0 }, { alpha: 1, duration: 0.15 });

        return;
      }
      centrePivot(g);
      this.motion.fromTo(
        g,
        { x: g.x - 40, alpha: 0 },
        { x: g.x, alpha: 1, duration: MOTION.slot.duration, ease: MOTION.slot.ease, delay: i * step },
      );
      this.motion.fromTo(
        g.skew,
        { x: -0.21 },
        { x: 0, duration: MOTION.slot.duration, ease: MOTION.slot.ease, delay: i * step },
      );
    });
    this.entered();
    if (this.host.kit.keys) this.focus.focus();
  }

  /**
   * On a phone, the box y a toast's bottom edge sits on: the screen keeps the band above it clear of its own content.
   * Null puts toasts where the layout puts them.
   */
  public toastBottom(): number | null {
    return null;
  }

  /**
   * On desktop, where the toasts hang: the front one is 420 px wide and 52 to 68 tall, and the queue behind it peeks
   * out up to 14 px under it. The default is the top edge's middle; a screen with its own content there names a side it
   * leaves empty, or a top under its header.
   */
  public toastHang(): ToastHang {
    return { side: 'centre', top: this.S.t };
  }

  /** In landscape, the side the toasts keep to: the left, unless the screen keeps its own content there. */
  public toastSide(): 'left' | 'right' {
    return 'left';
  }

  /** Runs once the enter starts; screens start their own moments (the sign, the podium tags) here. */
  protected entered(): void {}

  /** Plays the exit; resolves when it's done. */
  public exit(): Promise<void> {
    if (this._leaving) return Promise.resolve();
    this._leaving = true;
    this.root.eventMode = 'none';
    this.focus.blur();
    this.host.kit.sound.play('whooshDown');
    const reduced = this.motion.reduced;
    const n = this._groups.length;
    const step = n > 1 ? Math.min(MOTION.staggerOut, 0.06 / (n - 1)) : 0;

    for (const g of this._fades) this.motion.to(g, { alpha: 0, duration: reduced ? 0.15 : 0.22 });
    this._groups.forEach((g, i) => {
      const delay = (n - 1 - i) * step;

      this.motion.stop(g, g.skew);
      if (reduced) {
        this.motion.to(g, { alpha: 0, duration: 0.15 });

        return;
      }
      centrePivot(g);
      // The whip's expo ease barely moves until its end, so the fade leads it: the next screen enters onto a clear
      // stage instead of through this one.
      this.motion.to(g, { x: g.x + 60, duration: MOTION.whip.duration, ease: MOTION.whip.ease, delay });
      this.motion.to(g, { alpha: 0, duration: EXIT_FADE, ease: 'power2.out', delay });
      this.motion.to(g.skew, { x: -0.14, duration: MOTION.whip.duration, ease: MOTION.whip.ease, delay });
    });

    return wait(reduced ? 160 : 260);
  }

  /** Esc or B: returns whether the screen used it. */
  public back(): boolean {
    return false;
  }

  /** A printable key or Backspace from the keyboard (digits on the title, letters on the join entry). */
  public key(_key: string): boolean {
    return false;
  }

  public navigate(input: NavInput): boolean {
    const revealed = this._revealed;

    this._revealed = false;
    if (input === 'back') return this.back();
    if (revealed && input !== 'confirm' && this.focus.current) return true;

    return this.focus.navigate(input);
  }

  /** Keys took over (rings show, the first arrow only showing where focus is) or touch did (rings hide). */
  public inputChanged(): void {
    if (this.host.kit.keys) {
      this._revealed = !this.focus.current;
      this.focus.focus(this.focus.current);
    } else this.focus.blur();
  }

  /** A frame of the race arrived (the results read the trucks' screen positions from it). */
  public frame(_racers: readonly { id: string; screenX: number; screenY: number; tagVisible: boolean }[]): void {}

  public destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.motion.destroy();
    this.focus.clear();
    this._dispose();
    this.root.destroy({ children: true });
  }

  /** Runs `fn` when this build of the screen goes (a rebuild or destroy): DOM inputs, listeners. */
  protected onDispose(fn: () => void): void {
    this._disposers.push(fn);
  }

  private _dispose(): void {
    const list = this._disposers;

    this._disposers = [];
    for (const fn of list) fn();
  }

  /* ---------- the painter: these add to the current group ---------- */

  /** Starts a new enter item; what's drawn next goes into it. `fade` items only fade (scrims, dims). */
  protected begin(fade = false): Container {
    const g = new Container();

    this._content.addChild(g);
    (fade ? this._fades : this._groups).push(g);
    this._target = g;

    return g;
  }

  /** Draws into `parent` until the next `begin` or `into`. */
  protected into(parent: Container): void {
    this._target = parent;
  }

  protected get target(): Container {
    return this._target;
  }

  /** Waits for this texture before the enter plays. */
  protected track(p: Promise<void>): void {
    this._loads.push(p);
  }

  /** Art with its face's top-left at `x`, `y`. */
  protected put(art: SvgArt, x: number, y: number, o: PutOptions = {}): Placed & { sprite: ArtSprite } {
    const f = art.face ?? { x: 0, y: 0, w: art.width, h: art.height };
    const k = o.scale ?? 1;
    const sprite = new ArtSprite(this.host.kit.textures, art, this.L.density);
    const ox = x - f.x * k;
    const oy = y - f.y * k;

    sprite.position.set(ox, oy);
    sprite.scale.set(k);
    if (o.opacity !== undefined) sprite.alpha = o.opacity;
    this._target.addChild(sprite);
    this._loads.push(sprite.loaded);
    const c = art.content ?? f;

    return {
      sprite,
      x: ox,
      y: oy,
      w: art.width * k,
      h: art.height * k,
      f: { x, y, w: f.w * k, h: f.h * k },
      c: { x: ox + c.x * k, y: oy + c.y * k, w: c.w * k, h: c.h * k },
    };
  }

  /** Art centred on `cx`, `cy` by its anchor (or middle). */
  protected centre(art: SvgArt, cx: number, cy: number, o: PutOptions = {}): Placed & { sprite: ArtSprite } {
    const k = o.scale ?? 1;
    const a = art.anchor ?? { x: 0.5, y: 0.5 };
    const f = art.face ?? { x: 0, y: 0 };

    return this.put(art, cx - art.width * k * a.x + f.x * k, cy - art.height * k * a.y + f.y * k, o);
  }

  /** Art stretched over a box (scrims). */
  protected stretch(art: SvgArt, x: number, y: number, w: number, h: number): SlicedArt {
    const s = new SlicedArt(this.host.kit.textures, art, this.L.density, w, h);

    s.position.set(x, y);
    this._target.addChild(s);
    this._loads.push(s.loaded);

    return s;
  }

  /** A panel face `w` by `h` at `x`, `y`, as a nine-slice so it can grow. */
  protected panel(x: number, y: number, w: number, h: number, o: PanelOptions = {}): Placed & { sprite: SlicedArt } {
    const art = panelSvg({ width: w, height: h, ...o });
    const f = art.face!;
    const sprite = this.stretch(art, x - f.x, y - f.y, art.width, art.height);

    return { sprite, x: x - f.x, y: y - f.y, w: art.width, h: art.height, f: { x, y, w, h }, c: { x, y, w, h } };
  }

  protected text(str: string, x: number, y: number, st: TextSpec = {}): Text {
    const t = makeText(str, x, y, st, this.L.textResolution);

    this._target.addChild(t);

    return t;
  }

  /** Text (and an icon before it) centred vertically in `box`, aligned left, centre or right. */
  protected inbox(str: string | null, box: Box, st: InboxSpec = {}, icon: SvgArt | null = null): InboxRow {
    const gap = st.gap ?? 10;
    const size = st.s ?? 16;
    const t = str !== null ? makeText(str, 0, 0, { w: 700, ...st, a: 'l' }, this.L.textResolution) : null;
    const iconFace = icon ? (icon.face ?? { x: 0, y: 0, w: icon.width, h: icon.height }) : null;
    const iw = iconFace ? iconFace.w : 0;
    const tw = t ? t.width : 0;
    const total = iw + (iw && tw ? gap : 0) + tw;
    const inner = box.w - (st.pl ?? 0) - (st.pr ?? 0);
    const a = st.a ?? 'c';
    const x0 = box.x + (st.pl ?? 0) + (a === 'l' ? 0 : a === 'r' ? inner - total : (inner - total) / 2);
    let sprite: ArtSprite | null = null;

    if (icon && iconFace) {
      sprite = new ArtSprite(this.host.kit.textures, icon, this.L.density);
      sprite.position.set(x0 - iconFace.x, box.y + (box.h - iconFace.h) / 2 - iconFace.y);
      this._target.addChild(sprite);
      this._loads.push(sprite.loaded);
    }
    if (t) {
      t.position.set(x0 + iw + (iw ? gap : 0), box.y + (box.h - size) / 2 + (st.dy ?? 0));
      this._target.addChild(t);
    }

    return { text: t, icon: sprite };
  }

  protected label(str: string, x: number, y: number, o: TextSpec = {}): Text {
    return this.text(str, x, y, { f: 'd', s: this.k === 'd' ? 13 : 12, w: 600, c: COLORS.mist, ls: 0.4, ...o });
  }

  protected title(str: string, x: number, y: number, s = this.k === 'd' ? 44 : 34): Text {
    return this.text(str, x, y, { f: 'b', s, w: 900 });
  }

  protected body(str: string, x: number, y: number, wrap: number, o: TextSpec = {}): Text {
    return this.text(str, x, y, { s: this.k === 'd' ? 16 : 15, c: COLORS.mist, wrap, lh: 1.35, ...o });
  }

  /** A text button with its face's top-left at `x`, `y`; added to the focus group. */
  protected button(
    label: string,
    x: number,
    y: number,
    w: number,
    h: number,
    variant: ButtonVariant,
    icon: IconName | null,
    onPress: () => void,
    isDefault = false,
  ): Button {
    const b = textButton(this.host.kit, label, w, h, variant, icon, onPress).placeFace(x, y);

    this._target.addChild(b);
    this._loads.push(b.loaded);
    this.focus.add(b, isDefault);

    return b;
  }

  protected iconBtn(
    icon: IconName,
    x: number,
    y: number,
    h: number,
    variant: ButtonVariant,
    onPress: () => void,
  ): Button {
    const b = iconButton(this.host.kit, icon, h, variant, onPress).placeFace(x, y);

    this._target.addChild(b);
    this._loads.push(b.loaded);
    this.focus.add(b);

    return b;
  }

  /** Adds a button made elsewhere (keys, swatches) to the target and the focus group. */
  protected add(b: Button, isDefault = false): Button {
    this._target.addChild(b);
    this._loads.push(b.loaded);
    this.focus.add(b, isDefault);

    return b;
  }

  protected meter(x: number, y: number, w: number, h: number, frac: number, color: string): Meter {
    const m = new Meter(this.host.kit, w, h, color, frac);

    m.position.set(x, y);
    this._target.addChild(m);
    this._loads.push(m.loaded);

    return m;
  }

  /** Ink over the whole box. */
  protected dim(op = 0.55): Sprite {
    const s = new Sprite(Texture.WHITE);

    s.tint = 0x060920;
    s.alpha = op;
    s.width = this.W;
    s.height = this.H;
    s.eventMode = 'static';
    this._target.addChild(s);

    return s;
  }

  protected scrim(from: 'left' | 'right' | 'top' | 'bottom' | 'center', strength: number, reach: number): SlicedArt {
    return this.stretch(scrimSvg(from, strength, reach), 0, 0, this.W, this.H);
  }
}

/**
 * Moves a container's pivot to the middle of what it holds without moving what it holds, so it leans and scales about
 * its centre.
 */
export function centrePivot(g: Container): void {
  const b = g.getLocalBounds();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;

  g.position.set(g.x + (cx - g.pivot.x), g.y + (cy - g.pivot.y));
  g.pivot.set(cx, cy);
}
