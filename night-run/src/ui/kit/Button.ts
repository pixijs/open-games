import type { DestroyOptions, FederatedPointerEvent, Text } from 'pixi.js';
import { Container, Graphics, Rectangle } from 'pixi.js';

import type { ButtonState } from '../art/buttons';
import { glintSvg } from '../art/motifs';
import type { Box, Pt, SvgArt } from '../art/svg';
import { inset, shift } from '../art/svg';
import { COLORS, MOTION } from '../art/tokens';
import { ArtSprite } from './ArtSprite';
import { FocusRing } from './FocusRing';
import type { Focusable, UiKit } from './kit';
import { Motion } from './Motion';
import type { TextSpec } from './text';
import { fitText, makeText } from './text';

/** How a pressable thing looks and what it does. */
export interface ButtonSpec {
  /** Face art per state; `focus` is drawn as `hover` with the crawling ring on top */
  readonly art: (state: ButtonState) => SvgArt;
  /** The face outline at rest in art px: the glint's mask and the focus ring follow it */
  readonly outline: readonly Pt[];
  readonly label?: string;
  /** What the button is called when it has no label (an icon, a colour): its pixi `label`, for finding it */
  readonly name?: string;
  /** Label style; `c` is the enabled colour */
  readonly text?: TextSpec;
  /** Icon art before the label (or alone), per enabled state */
  readonly icon?: (enabled: boolean) => SvgArt;
  readonly onPress?: () => void;
  /** Sweep the glint across the face on hover (buttons yes, keys no) */
  readonly glint?: boolean;
  /** How far the face lifts on hover, for the ring (2 for buttons, 3 for swatches) */
  readonly lift?: number;
  /** Gap from the face to the focus ring */
  readonly ring?: number;
}

const MIN_HIT = 48;
/** The room a label keeps at each end of the face, as a share of its height */
const LABEL_INSET = 0.08;

/**
 * Every pressable thing: buttons, icon buttons, keys and swatches. State changes are texture swaps between preloaded
 * art: hover lifts the face 2 px and sweeps the glint, press sinks it into its return (the label drops with
 * `content`, the whole thing scales to 0.98, release slots back), focus from keys shows a dashed ring that crawls 8 px
 * a second, disabled greys it and ignores input. The hit area is at least 48 px whatever the art's size.
 */
export class Button extends Container implements Focusable {
  public readonly face: ArtSprite;
  /** The face box in this container's px */
  public readonly faceBox: Box;
  private readonly _kit: UiKit;
  private readonly _spec: ButtonSpec;
  private readonly _motion = new Motion();
  private readonly _held = new Map<ButtonState, SvgArt>();
  private readonly _label: Text | null = null;
  private readonly _icon: ArtSprite | null = null;
  private _iconArt: SvgArt | null = null;
  private _glint: ArtSprite | null = null;
  private _mask: Graphics | null = null;
  private _ring: FocusRing | null = null;
  private _hovered = false;
  private _pressed = false;
  private _focused = false;
  private _disabled = false;
  private _state: ButtonState = 'idle';
  private _labelTop = 0;

  constructor(kit: UiKit, spec: ButtonSpec) {
    super();
    this._kit = kit;
    this._spec = spec;
    const idle = spec.art('idle');
    const f = idle.face ?? { x: 0, y: 0, w: idle.width, h: idle.height };

    this.faceBox = f;
    this.face = new ArtSprite(kit.textures, idle, kit.layout.density);
    this.addChild(this.face);
    this._hold('idle', idle);
    this._hold('hover', spec.art('hover'));
    this._hold('press', spec.art('press'));
    if (spec.icon) {
      this._iconArt = spec.icon(true);
      this._icon = new ArtSprite(kit.textures, this._iconArt, kit.layout.density);
      this.addChild(this._icon);
    }
    if (spec.label !== undefined) {
      this._label = makeText(spec.label, 0, 0, spec.text ?? {}, kit.layout.textResolution);
      this.addChild(this._label);
      this._fitLabel(this._label, idle);
    }
    this._layoutContent(idle);
    this.pivot.set(f.x + f.w / 2, f.y + f.h / 2);
    const hw = Math.max(MIN_HIT, f.w) / 2;
    const hh = Math.max(MIN_HIT, f.h) / 2;

    this.hitArea = new Rectangle(f.x + f.w / 2 - hw, f.y + f.h / 2 - hh, hw * 2, hh * 2);
    this.label = spec.label ?? spec.name ?? '';
    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.on('pointerover', this._over);
    this.on('pointerout', this._out);
    this.on('pointerdown', this._down);
    this.on('pointerup', this._up);
    this.on('pointerupoutside', this._up);
    this.on('pointertap', this._tap);
  }

  public get node(): Container {
    return this;
  }

  public get focusable(): boolean {
    if (this._disabled || this.destroyed || !this.visible) return false;
    for (let n = this.parent; n; n = n.parent) if (!n.visible) return false;

    return true;
  }

  public get disabled(): boolean {
    return this._disabled;
  }

  public get labelText(): Text | null {
    return this._label;
  }

  /** Every texture this button shows has loaded */
  public get loaded(): Promise<void> {
    return Promise.all([this.face.loaded, this._icon?.loaded]).then(() => undefined);
  }

  /** Puts the face's top-left at `x`, `y` in the parent. */
  public placeFace(x: number, y: number): this {
    this.position.set(x + this.faceBox.w / 2, y + this.faceBox.h / 2);

    return this;
  }

  public setDisabled(disabled: boolean): void {
    if (this._disabled === disabled) return;
    this._disabled = disabled;
    if (disabled) {
      this._hold('disabled', this._spec.art('disabled'));
      this._pressed = false;
    }
    this.cursor = disabled ? 'default' : 'pointer';
    if (this._spec.icon) this._setIcon(this._spec.icon(!disabled));
    if (this._label) this._label.style.fill = disabled ? COLORS.mist : (this._spec.text?.c ?? COLORS.white);
    this._apply();
  }

  /** Changes the label in place (and refits the row). */
  public setLabel(text: string): void {
    if (!this._label || this._label.text === text) return;
    this._label.style.fontSize = this._spec.text?.s ?? 16;
    this._label.text = text;
    this._fitLabel(this._label, this.face.art);
    this._layoutContent(this.face.art);
  }

  /** Re-reads the art for every state (a swatch that became selected or taken). */
  public refresh(): void {
    for (const state of this._held.keys()) this._hold(state, this._spec.art(state));
    this._apply();
  }

  /** Forces the hover look. */
  public setHovered(on: boolean): void {
    this._hovered = on;
    this._apply();
  }

  public setFocused(on: boolean): void {
    if (this._focused === on) return;
    this._focused = on;
    if (on) this._kit.sound.play('tick', 1.122);
    this._apply();
  }

  /** Enter, Space or the A button: the same sink and spring back as a press, then the action. */
  public activate(): void {
    if (this._disabled) return;
    this._down();
    this._motion.delay(0.09, () => {
      this._up();
      this._spec.onPress?.();
    });
  }

  /** Shows a press without pressing: a letter typed on the keyboard sinks its keypad key. */
  public pulse(): void {
    if (this._disabled) return;
    this._sink();
    this._motion.delay(0.09, this._up);
  }

  /** Sweeps the glint across the face once (hover, a copy, a record). */
  public sweep(): void {
    if (this._motion.reduced) return;
    const f = this.faceBox;

    if (!this._glint) {
      this._glint = new ArtSprite(this._kit.textures, glintSvg(f.h + 8), this._kit.layout.density);
      this._glint.blendMode = 'add';
      this._mask = new Graphics();
      this._glint.mask = this._mask;
      this.addChildAt(this._mask, 1);
      this.addChildAt(this._glint, 2);
    }
    const lift = this._state === 'hover' || this._state === 'focus' ? (this._spec.lift ?? 2) : 0;

    this._mask!.clear()
      .poly(flat(shift([...this._spec.outline], 0, -lift)))
      .fill(0xffffff);
    const g = this._glint;

    g.visible = true;
    g.y = f.y - 4 - lift;
    this._motion.stop(g);
    this._motion.fromTo(
      g,
      { x: f.x - g.width },
      {
        x: f.x + f.w,
        duration: MOTION.sweep.duration,
        ease: MOTION.sweep.ease,
        onComplete: () => void (g.visible = false),
      },
    );
  }

  public override destroy(options?: DestroyOptions): void {
    if (this.destroyed) return;
    this._motion.destroy();
    for (const art of this._held.values()) this._kit.textures.release(art, this._kit.layout.density);
    this._held.clear();
    this.removeAllListeners();
    super.destroy({ children: true, ...(typeof options === 'object' ? options : {}) });
  }

  private _hold(state: ButtonState, art: SvgArt): void {
    const old = this._held.get(state);

    if (old?.svg === art.svg) return;
    void this._kit.textures.load(art, this._kit.layout.density).catch(() => undefined);
    this._held.set(state, art);
    if (old) this._kit.textures.release(old, this._kit.layout.density);
  }

  private _setIcon(art: SvgArt): void {
    if (!this._icon || this._iconArt?.svg === art.svg) return;
    this._iconArt = art;
    this._icon.setArt(art);
  }

  private _apply(): void {
    if (this.destroyed) return;
    const ringOn = this._focused && this._kit.keys && !this._disabled;
    const state: ButtonState = this._disabled
      ? 'disabled'
      : this._pressed
        ? 'press'
        : this._hovered || ringOn
          ? 'hover'
          : 'idle';
    const changed = state !== this._state;

    this._state = ringOn && state === 'hover' ? 'focus' : state;
    const art = this._held.get(state) ?? this._spec.art(state);

    this.face.setArt(art);
    if (changed) this._layoutContent(art);
    this._showRing(ringOn && state !== 'press');
  }

  /**
   * Fits the label beside its icon on the face, keeping {@link LABEL_INSET} of the face's height clear at the ends: a
   * label too long for the button (a long name in it) shrinks, then cuts with an ellipsis, instead of running off it.
   */
  private _fitLabel(label: Text, art: SvgArt): void {
    const c = art.content ?? art.face ?? { x: 0, y: 0, w: art.width, h: art.height };
    const iconW = this._iconArt?.face?.w ?? 0;

    fitText(label, c.w - (iconW ? iconW + 8 : 0) - c.h * LABEL_INSET * 2);
  }

  private _layoutContent(art: SvgArt): void {
    const c = art.content ?? art.face ?? { x: 0, y: 0, w: art.width, h: art.height };
    const s = this._spec.text?.s ?? 16;
    const iconFace = this._iconArt?.face;
    const iconW = iconFace ? iconFace.w : 0;
    const gap = iconW && this._label?.text ? 8 : 0;
    const textW = this._label?.text ? this._label.width : 0;
    const x0 = c.x + (c.w - iconW - gap - textW) / 2;

    if (this._icon && iconFace) this._icon.position.set(x0 - iconFace.x, c.y + (c.h - iconFace.h) / 2 - iconFace.y);
    if (this._label) {
      const top = c.y + (c.h - s) / 2;

      if (this._labelTop && !this._motion.reduced && this._state !== 'press' && top < this._labelTop) {
        this._label.position.set(x0 + iconW + gap, this._labelTop);
        this._motion.stop(this._label.position);
        this._motion.to(this._label.position, { y: top, duration: MOTION.snap.duration, ease: MOTION.snap.ease });
      } else {
        this._motion.stop(this._label.position);
        this._label.position.set(x0 + iconW + gap, top);
      }
      this._labelTop = top;
    }
  }

  private _showRing(on: boolean): void {
    if (!on) {
      this._ring?.hide();

      return;
    }
    if (!this._ring) {
      this._ring = new FocusRing();
      this.addChild(this._ring);
    }
    if (this._ring.visible) return;
    this._ring.show(inset(shift([...this._spec.outline], 0, -(this._spec.lift ?? 2)), -(this._spec.ring ?? 5)));
  }

  private readonly _over = (e: FederatedPointerEvent): void => {
    if (this._disabled || e.pointerType === 'touch') return;
    this._hovered = true;
    this._kit.sound.play('tick');
    this._apply();
    if (this._spec.glint !== false) this.sweep();
  };

  private readonly _out = (): void => {
    this._hovered = false;
    this._apply();
  };

  private _sink(): void {
    this._pressed = true;
    this._apply();
    this._motion.stop(this.scale);
    this._motion.to(this.scale, { x: 0.98, y: 0.98, duration: MOTION.press.duration, ease: MOTION.press.ease });
  }

  private readonly _down = (): void => {
    if (this._disabled) return;
    this._kit.sound.play('thock');
    this._sink();
  };

  private readonly _up = (): void => {
    if (!this._pressed) return;
    this._pressed = false;
    this._apply();
    this._motion.stop(this.scale);
    this._motion.to(this.scale, { x: 1, y: 1, duration: MOTION.slot.duration, ease: MOTION.slot.ease });
  };

  private readonly _tap = (): void => {
    if (this._disabled) return;
    this._spec.onPress?.();
  };
}

function flat(pts: readonly Pt[]): number[] {
  const out: number[] = [];

  for (const p of pts) out.push(p.x, p.y);

  return out;
}
