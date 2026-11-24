import type { Container, Text } from 'pixi.js';
import { Rectangle, Sprite, Texture } from 'pixi.js';

import { iconSvg } from '../art/icons';
import type { LogoOptions } from '../art/logo';
import { logoSvg } from '../art/logo';
import { pitBoardSvg } from '../art/panels';
import type { SvgArt } from '../art/svg';
import { COLORS, MOTION, RACERS } from '../art/tokens';
import type { NavInput, Screen } from '../contract';
import type { ArtSprite } from '../kit/ArtSprite';
import type { Button } from '../kit/Button';
import { WHITE80 } from '../kit/text';
import type { ToastHang } from '../kit/ToastStack';
import { MenuScreen } from './MenuScreen';
import type { Placed } from './ScreenView';
import { centrePivot } from './ScreenView';

type TitleData = Extract<Screen, { id: 'title' }>;

/** The pit board's button height and the space between rows, px, with a rail midway in each gap. */
const ROW_HEIGHT = 50;
const ROW_GAP = 26;

/**
 * How far the sign's rods and the board's pole run past the screen edge, px: more than the enter's 40 px slide, the
 * exit's 60 px whip and the lean and punch, so their cut ends never come into view.
 */
const OVERHANG = 72;

interface Sign {
  readonly unlit: ArtSprite;
  readonly lit: ArtSprite;
  readonly final: ArtSprite | null;
  readonly options: LogoOptions;
  readonly art: SvgArt;
}

/**
 * The title over the attract race: the NIGHT RUN sign powers up (it flickers on, its three start lamps light left to
 * right, its wet reflection fades in last, then it breathes), and the pit board holds the four ways in, picked by tap,
 * by 1 to 4, or by arrows and Enter. The driver chip opens the name sheet; the track chip, beside it, names the track
 * racing behind the title (the one Quick race races) and opens My tracks.
 */
export class TitleScreen extends MenuScreen<TitleData> {
  private _rows: Button[] = [];
  private _sign: Sign | null = null;
  private _editing = false;
  private _draft = '';
  private _sheet: Container[] = [];
  private _powered = false;
  private _edit: Button | null = null;
  private _sound: Button | null = null;
  private _chipName: Text | null = null;
  /** The name just saved: the chip's name punches in once the title is back */
  private _saved = false;
  private _closing = false;
  /** Where build left a phone's toasts room; {@link toastBottom} returns it. */
  private _toastAt: number | null = null;

  /** Opens the name sheet. */
  public editName(): void {
    this._editing = true;
    this._draft = this.data.name;
    this.rebuild();
    for (const g of this._sheet) {
      centrePivot(g);
      if (this.motion.reduced) this.motion.fromTo(g, { alpha: 0 }, { alpha: 1, duration: 0.15 });
      else {
        this.motion.fromTo(g, { alpha: 0 }, { alpha: 1, duration: 0.2 });
        this.motion.fromTo(g.scale, { x: 0.92, y: 0.92 }, { x: 1, y: 1, ...MOTION.slot });
      }
    }
    this.host.kit.sound.play('whooshUp');
  }

  /**
   * Phones: over the sign's reflection, above the brand (portrait), or on the board's chequer under the sign
   * (landscape), so a toast never hides a way in.
   */
  public override toastBottom(): number | null {
    return this._toastAt;
  }

  /** Desktop: top right under the sound button, since the middle of the top edge would clip the sign's corner. */
  public override toastHang(): ToastHang {
    return { side: 'right', top: this.S.t + 56 };
  }

  /** Landscape: the right, over the brand row, where the sign and the board leave the scene empty. */
  public override toastSide(): 'left' | 'right' {
    return 'right';
  }

  public override back(): boolean {
    if (!this._editing) return false;
    this._closeSheet(false);

    return true;
  }

  /** Keys wait while the name sheet drops away. */
  public override navigate(input: NavInput): boolean {
    if (this._closing) return true;

    return super.navigate(input);
  }

  public override key(key: string): boolean {
    if (this._editing) return false;
    const row = this._rows[Number(key) - 1];

    if (!row) return false;
    this.focus.focus(row);
    row.activate();

    return true;
  }

  protected override build(): void {
    const { k, W, H, S } = this;
    const name = this.data.name;
    const tagline = 'Race up to three friends.';

    this._rows = [];
    this._edit = null;
    this._chipName = null;
    this.begin(true);
    if (k === 'd') this.scrim('left', 0.92, 0.62);
    else if (k === 'p') {
      this.scrim('bottom', 0.95, 0.62);
      this.scrim('top', 0.85, 0.42);
    } else this.scrim('left', 0.92, 0.72);
    this.begin();
    this._toastAt = null;
    if (k === 'd') {
      this._drawSign({ size: 58 }, 64, 74);
      this.begin();
      this.text(tagline, 70 + 400 / 2, 236, { s: 19, w: 500, c: COLORS.mist, a: 'c' });
      this.begin();
      this._pitMenu(70, 272, 400, ROW_HEIGHT, ROW_GAP, 'left');

      this.begin();
      this._driverChip(70, H - S.b - 62, 300, name);
      this.begin();
      this._trackChip(386, H - S.b - 62, 300);
      this.begin();
      this._sound = this.iconBtn(this.data.sound ? 'sound' : 'mute', W - S.r - 56, S.t, 44, 'secondary', () =>
        this._toggleSound(),
      );
      const brand = this.collab(34, 'right', H - S.b);

      if (!this.host.kit.touch) {
        this.text('Press 1 to 4, or use the arrow keys and Enter', W - S.r, brand.f.y - 28, {
          s: 13,
          w: 500,
          c: WHITE80,
          a: 'r',
          glow: true,
        });
      }
    } else if (k === 'p') {
      const sign: LogoOptions = { layout: 'stack', size: 36 };
      const bw = W - S.l - S.r;
      const board = pitBoardSvg({ width: bw, rows: 4, rowHeight: ROW_HEIGHT, gap: ROW_GAP, handle: 'bottom' });
      const by = H - S.b - 8 - board.face!.h;
      const half = (bw - 10) / 2;

      this._drawSign(sign, (W - logoSvg(sign).face!.w) / 2, S.t + 26);
      this.begin();
      // Over the tagline, clear of the sign's reflection; toasts queue over the reflection's faded tail.
      this._toastAt = this.collab(22, 'centre', by - 96 - 22).f.y - 12;
      this.begin();
      this._sound = this.iconBtn(this.data.sound ? 'sound' : 'mute', W - S.r - 54, S.t - 4, 44, 'secondary', () =>
        this._toggleSound(),
      );
      this.begin();
      this.text(tagline, W / 2, by - 96, { s: 15, w: 500, c: WHITE80, a: 'c', glow: true });
      this.begin();
      this._driverChip(S.l, by - 64, half, name);
      this.begin();
      this._trackChip(S.l + half + 10, by - 64, half);
      this.begin();
      this._pitMenu(S.l, by, bw, ROW_HEIGHT, ROW_GAP, 'bottom');
    } else {
      const sign: LogoOptions = { size: 30, reflection: false };
      const board = pitBoardSvg({ width: 330, rows: 4, rowHeight: 44, gap: 12, handle: 'left' });
      const by = H - S.b - board.face!.h;

      // Sign and board stand together on the safe bottom, like the chips; a taller box shows more of the rods.
      this._drawSign(sign, S.l, Math.max(S.t, by - 20 - logoSvg(sign).face!.h));
      this.begin();
      this._pitMenu(S.l, by, 330, 44, 12, 'left');
      this.begin();
      this._driverChip(W - S.r - 270, H - S.b - 120, 270, name);
      this.begin();
      this._trackChip(W - S.r - 270, H - S.b - 56, 270);
      this.begin();
      this._toastAt = this.collab(22, 'right', H - S.b - 120 - 16).f.y - 12;
      this.begin();
      this._sound = this.iconBtn(this.data.sound ? 'sound' : 'mute', W - S.r - 54, S.t, 44, 'secondary', () =>
        this._toggleSound(),
      );
    }
    if (this._editing) this._buildSheet();
  }

  protected override entered(): void {
    this._powerUp();
  }

  /**
   * The sign, its cabinet's top-left at `x`, `y` and its rods up past the screen's top: unlit cabinet under the lit
   * one, plus the reflected version that fades in last.
   */
  private _drawSign(sign: LogoOptions, x: number, y: number): void {
    const options = { ...sign, hang: y + OVERHANG };
    const art = logoSvg(options);
    const reflect = options.reflection !== false;
    const unlit = this.put(logoSvg({ ...options, lit: false, reflection: false }), x, y).sprite;
    const lit = this.put(reflect ? logoSvg({ ...options, reflection: false }) : art, x, y).sprite;
    const final = reflect ? this.put(art, x, y).sprite : null;

    this._sign = { unlit, lit, final, options, art };
    if (this._powered) {
      unlit.visible = false;
      this._breathe();
    } else {
      lit.alpha = 0;
      if (final) final.alpha = 0;
    }
  }

  /** Flickers the sign on (lit at 60 ms, off at 140, lit at 260), lights the lamps 80 ms apart, then the reflection. */
  private _powerUp(): void {
    const sign = this._sign;

    if (!sign || this._powered) return;
    this._powered = true;
    const { lit, final } = sign;

    if (this.motion.reduced) {
      this.motion.to(lit, { alpha: 1, duration: 0.15 });
      if (final) this.motion.to(final, { alpha: 1, duration: 0.15 });

      return;
    }
    const sound = this.host.kit.sound;
    const tl = this.motion.timeline({ delay: 0.12 });

    tl.call(() => sound.play('neonBuzz'))
      .set(lit, { alpha: 1 }, 0.06)
      .set(lit, { alpha: 0 }, 0.14)
      .set(lit, { alpha: 0.6 }, 0.2)
      .set(lit, { alpha: 0 }, 0.23)
      .set(lit, { alpha: 1 }, 0.26)
      .call(() => sound.play('clack'), undefined, 0.26);
    const cabinet = lit.parent;

    // The current takes hold: the cabinet jolts as the letters catch.
    if (cabinet) tl.call(() => this.motion.punch(cabinet.scale, 1.035, 0.5), undefined, 0.26);
    const covers = this._lampCovers();

    covers.forEach((cover, i) => {
      tl.to(cover, { alpha: 0, duration: 0.05, ease: 'none' }, 0.34 + i * 0.08);
      tl.call(() => sound.play('tick', 0.7 + i * 0.15), undefined, 0.34 + i * 0.08);
    });
    if (final) tl.to(final, { alpha: 1, duration: 0.5, ease: 'sine.out' }, 0.62);
    // The board's first row catches the light as the sign settles: the one to press.
    tl.call(() => this._rows[0]?.sweep(), undefined, 0.78);
    tl.call(() => {
      for (const c of covers) {
        c.texture.destroy(false);
        c.destroy();
      }
      covers.length = 0;
      this._breathe();
    });
    this.onDispose(() => {
      for (const c of covers) c.texture.destroy(false);
    });
  }

  /** The sign breathes: the lit faces dip toward unlit and back, so it reads as live neon. */
  private _breathe(): void {
    const sign = this._sign;

    if (!sign || this.motion.reduced) return;
    const top = sign.final ?? sign.lit;

    sign.unlit.visible = true;
    this.motion.fromTo(
      top,
      { alpha: 1 },
      { alpha: 0.86, duration: MOTION.idle.duration, ease: MOTION.idle.ease, yoyo: true, repeat: -1 },
    );
    if (sign.final) sign.lit.visible = false;
  }

  /** Crops of the unlit sign over each start lamp, so the lamps can light one by one. */
  private _lampCovers(): Sprite[] {
    const sign = this._sign!;
    const src = sign.unlit.texture;

    if (src === Texture.EMPTY) return [];
    const size = sign.options.size ?? 96;
    const f = sign.unlit.art.face!;
    const band = size * 0.24;
    const depth = size * 0.1;
    const cabH = f.h - depth;
    const by = f.y + cabH - band - size * 0.06;
    const lampsW = band * 3.4;
    const hw = band * 0.55;
    const hh = band * 0.72;
    const covers: Sprite[] = [];
    const parent = sign.unlit.parent!;

    for (let i = 0; i < 3; i++) {
      const cx = f.x + f.w - size * 0.12 - lampsW + band * 0.55 + i * band * 1.1;
      const cy = by + band / 2;
      const frame = new Rectangle(cx - hw, cy - hh, hw * 2, hh * 2);
      const cover = new Sprite(new Texture({ source: src.source, frame }));

      cover.position.set(sign.unlit.x + frame.x, sign.unlit.y + frame.y);
      parent.addChild(cover);
      covers.push(cover);
    }

    return covers;
  }

  /** The pit board, its face's top-left at `x`, `y`, its pole run out past the screen edge it points at. */
  private _pitMenu(x: number, y: number, w: number, rh: number, gap: number, handle: 'left' | 'bottom'): Placed {
    const reach = (handle === 'left' ? x : this.H - y) + OVERHANG;
    const p = this.put(pitBoardSvg({ width: w, rows: 4, rowHeight: rh, gap, handle, reach }), x, y);
    const a = this.host.actions;

    this._rows = [
      this.button('Quick race', p.c.x, p.c.y, p.c.w, rh, 'primary', 'play', () => a.quickRace(), true),
      this.button('Host a party', p.c.x, p.c.y + rh + gap, p.c.w, rh, 'secondary', 'crown', () => a.host()),
      this.button('Join with a code', p.c.x, p.c.y + (rh + gap) * 2, p.c.w, rh, 'secondary', 'link', () =>
        this.host.showLocal({ id: 'join', code: '', error: null, busy: false }),
      ),
      this.button('My tracks', p.c.x, p.c.y + (rh + gap) * 3, p.c.w, rh, 'secondary', 'track', () =>
        this.data.hasTracks ? a.openTracks('library') : a.newTrack('oval'),
      ),
    ];

    return p;
  }

  /** The track chip: the track behind the title, which Quick race races; it opens My tracks. */
  private _trackChip(x: number, y: number, w: number): void {
    const h = this.k === 'p' ? 52 : 56;
    const track = this.data.track;
    const chip = this.panel(x, y, w, h, { tone: 'card', chamfer: 12 });

    chip.sprite.eventMode = 'static';
    chip.sprite.cursor = 'pointer';
    chip.sprite.on('pointertap', () => this.host.actions.openTracks('library'));
    this.put(iconSvg('track', { size: 24, color: COLORS.cyan, accent: COLORS.magenta }), x + 14, y + (h - 24) / 2);
    this.label('Track', x + 50, y + (h / 2 - 14));

    // A half-width chip on a tall phone is pressed whole: a chevron says so instead of a button.
    const narrow = w < 220;

    this.text(track.name || 'Untitled', x + 50, y + h / 2 + 1, {
      s: 18,
      w: 600,
      i: true,
      max: w - (narrow ? 76 : 112),
    });
    if (narrow) this.text('›', x + w - 14, y + h / 2 - 15, { f: 'b', s: 30, w: 800, c: COLORS.cyan, a: 'r' });
    else {
      this.iconBtn('forward', x + w - 58, y + (h - 44) / 2, 44, 'secondary', () =>
        this.host.actions.openTracks('library'),
      );
    }
  }

  private _driverChip(x: number, y: number, w: number, name: string): void {
    const h = this.k === 'p' ? 52 : 56;
    const color = RACERS[this.host.memory.car];

    this.panel(x, y, w, h, { tone: 'card', chamfer: 12 });
    this.put(iconSvg('driver', { size: 26, color: color.main, accent: COLORS.ink900 }), x + 14, y + (h - 26) / 2);
    this.label('Racing as', x + 52, y + (h / 2 - 14));
    this._chipName = this.text(name, x + 52, y + h / 2 + 1, { s: 18, w: 600, i: true, max: w - 116 });
    this._edit = this.iconBtn('edit', x + w - 58, y + (h - 44) / 2, 44, 'secondary', () => this.editName());
    if (this._saved) {
      this._saved = false;
      const t = this._chipName;

      t.anchor.y = 0.5;
      t.y += t.height / 2;
      this.motion.punch(t.scale, 1.35);
      this.motion.delay(0.05, () => {
        if (!t.destroyed) this.host.kit.sound.play('pluck', 1.25);
      });
    }
  }

  private _buildSheet(): void {
    const { k, W, H, S } = this;

    this._sheet = [this.begin()];
    this.dim(0.62);
    this.focus.clear();
    this._sheet.push(this.begin());
    const w = k === 'd' ? 460 : k === 'p' ? W - 40 : 420;
    const h = k === 'd' ? 260 : k === 'p' ? 268 : 262;
    const x = (W - w) / 2;
    const y = k === 'p' ? S.t + 80 : (H - h) / 2;
    const p = this.panel(x, y, w, h, { accent: COLORS.cyan });

    this.title('Your name', p.c.x + 24, p.c.y + 26, k === 'd' ? 36 : 30);
    this.text('Shown over your truck and in the results.', p.c.x + 24, p.c.y + (k === 'd' ? 70 : 64), {
      s: 15,
      c: COLORS.mist,
    });
    const field = this.nameField(
      p.c.x + 24,
      p.c.y + (k === 'd' ? 100 : 94),
      w - 48,
      56,
      this._draft,
      RACERS[this.host.memory.car],
      (v) => void (this._draft = v),
      () => this._closeSheet(true),
      true,
    );
    const by = p.c.y + h - 76;

    this.button('Cancel', p.c.x + 24, by, (w - 64) / 2, 52, 'secondary', null, () => this._closeSheet(false));
    this.button('Save name', p.c.x + 40 + (w - 64) / 2, by, (w - 64) / 2, 52, 'primary', null, () =>
      this._closeSheet(true),
    );
    field.focus();
  }

  /** The sheet drops away (the dim fades, the panel sinks and shrinks), then the title is back with keys on Edit. */
  private _closeSheet(save: boolean): void {
    if (this._closing) return;
    const name = this._draft.trim();
    const changed = save && !!name && name !== this.data.name;
    const sheet = this._sheet;

    this._closing = true;
    this.host.kit.sound.play(save ? 'confirm' : 'back');
    if (changed) {
      this.host.actions.setName(name);
      this.host.memory.name = name;
      this.data = { ...this.data, name };
    }
    const done = (): void => {
      if (this.destroyed) return;
      this._closing = false;
      this._editing = false;
      this._sheet = [];
      this._saved = changed;
      this.rebuild();
      if (this.host.kit.keys && this._edit) this.focus.focus(this._edit);
    };

    if (this.motion.reduced || !sheet.length) {
      done();

      return;
    }
    for (const g of sheet) g.eventMode = 'none';
    const [dim, panel] = sheet;

    this.motion.to(dim, { alpha: 0, duration: 0.18, ease: 'power2.in' });
    if (panel) {
      this.motion.to(panel, { alpha: 0, y: panel.y + 18, duration: 0.18, ease: 'power2.in' });
      this.motion.to(panel.scale, { x: 0.94, y: 0.94, duration: 0.18, ease: 'power2.in' });
    }
    this.host.kit.sound.play('whooshDown');
    this.motion.delay(0.19, done);
  }

  /** Turns the sound on or off; keys stay on the switch, which redraws with its other icon */
  private _toggleSound(): void {
    const on = !this.data.sound;
    const held = this.focus.current === this._sound;

    this.host.setSound(on);
    this.data = { ...this.data, sound: on };
    this.rebuild();
    if (held && this.host.kit.keys) this.focus.focus(this._sound);
  }
}
