import type { Text } from 'pixi.js';
import { Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';

import { iconSvg } from '../art/icons';
import type { SlotState } from '../art/panels';
import { panelSvg, readyStampSvg, slotCardSvg } from '../art/panels';
import type { SvgArt } from '../art/svg';
import { leanShift } from '../art/svg';
import { COLORS, MOTION, RACERS } from '../art/tokens';
import type { Role, SeatView } from '../contract';
import { ArtSprite } from '../kit/ArtSprite';
import type { Button } from '../kit/Button';
import { iconButton, textButton } from '../kit/buttons';
import type { FocusGroup } from '../kit/FocusGroup';
import type { UiKit } from '../kit/kit';
import type { LayoutKind } from '../kit/layout';
import { Motion } from '../kit/Motion';
import { SlicedArt } from '../kit/SlicedArt';
import { makeText } from '../kit/text';

/** What a seat card needs from its lobby. */
export interface SeatEnv {
  readonly kit: UiKit;
  readonly focus: FocusGroup;
  readonly kind: LayoutKind;
  readonly role: Exclude<Role, 'solo'>;
  readonly w: number;
  readonly h: number;
  /** 1 to 4, painted in the bay */
  readonly bay: number;
  onEdit(): void;
  onKick(id: string): void;
  onKickConfirm(id: string): void;
  onKickCancel(): void;
  onRemoveBot(id: string): void;
  onAddBot(): void;
}

function cardState(seat: SeatView): SlotState {
  if (seat.kind === 'open') return 'empty';
  if (seat.kind === 'joining') return 'joining';
  if (seat.kind === 'bot') return 'bot';

  return seat.ready ? 'ready' : 'player';
}

/**
 * One lobby seat, drawn as a garage bay, that animates how it changes: a player joining rolls the card open with a
 * white flash and the truck's bay sliding in; ready drops the stamp from 1.8x, draws the green tape on clockwise and
 * jolts the card; a player leaving drops a white shutter over the bay; a dropped guest's seat goes to half strength
 * with the offline icon while it's held. Its origin is the card face's top-left.
 */
export class SeatCard {
  public readonly node = new Container();
  private readonly _env: SeatEnv;
  private readonly _motion = new Motion();
  private readonly _layer = new Container();
  private _card: ArtSprite | null = null;
  private _seat: SeatView | null = null;
  private _kicking = false;
  private _buttons: Button[] = [];
  /** Frames cut from the card's texture for a moment; freed with the moment's sprites */
  private _crops: Texture[] = [];

  constructor(env: SeatEnv) {
    this._env = env;
    this.node.addChild(this._layer);
    this.node.pivot.set(env.w / 2, env.h / 2);
  }

  /** Every texture the card shows has loaded. */
  public get loaded(): Promise<void> {
    return this._card?.loaded ?? Promise.resolve();
  }

  /** Puts the face's top-left at `x`, `y`. */
  public place(x: number, y: number): void {
    this.node.position.set(x + this._env.w / 2, y + this._env.h / 2);
  }

  /** Shows `seat`; a change from what showed plays its moment. */
  public set(seat: SeatView, kicking: boolean): void {
    const prev = this._seat;
    const wasKicking = this._kicking;

    this._seat = seat;
    this._kicking = kicking;
    if (prev && sameLook(prev, seat) && wasKicking === kicking) return;
    const oldCard = this._card;
    const before = prev ? cardState(prev) : null;
    const after = cardState(seat);

    if (oldCard) this._layer.removeChild(oldCard);
    this._render();
    if (!prev) {
      oldCard?.destroy();

      return;
    }
    const joined =
      (before === 'empty' || before === 'joining') && (after === 'player' || after === 'ready' || after === 'bot');
    const left = before !== 'empty' && after === 'empty';

    if (joined) this._joinMoment();
    else if (left) this._leaveMoment();
    else if (before === 'player' && after === 'ready') this._readyMoment(oldCard);
    else if (before === 'empty' && after === 'joining') this._motion.shake(this.node, 3, 0.2, 1);
    else if (prev.car !== seat.car && oldCard && !oldCard.destroyed) {
      this._crossfade(oldCard);

      return;
    }
    if (oldCard && !oldCard.destroyed && oldCard.parent === null) oldCard.destroy();
  }

  public destroy(): void {
    this._motion.destroy();
    for (const b of this._buttons) this._env.focus.remove(b);
    this._buttons = [];
    this._freeCrops();
    this.node.destroy({ children: true });
  }

  /** Empties the card's layer: every moment still playing on what's there stops before it goes. */
  private _clearLayer(): void {
    for (const child of this._layer.removeChildren()) {
      this._motion.stop(child, child.scale, child.position);
      child.destroy({ children: true });
    }
    this._freeCrops();
  }

  private _freeCrops(): void {
    for (const t of this._crops) t.destroy(false);
    this._crops = [];
  }

  private _render(): void {
    const env = this._env;
    const seat = this._seat!;
    const { w, h, kit } = env;
    const state = cardState(seat);
    const host = env.role === 'host';
    const art = slotCardSvg({
      width: w,
      height: h,
      color: seat.kind === 'open' ? undefined : RACERS[seat.car],
      state,
      you: seat.isYou,
      host: seat.isHost,
      bay: env.bay,
    });

    const focused = this._buttons.findIndex((b) => b === env.focus.current);

    for (const b of this._buttons) env.focus.remove(b);
    this._buttons = [];
    this._clearLayer();
    const card = new ArtSprite(kit.textures, art, kit.layout.density);
    const f = art.face!;
    const c = art.content!;

    card.position.set(-f.x, -f.y);
    this._card = card;
    this._layer.addChild(card);
    this._layer.alpha = seat.kind === 'player' && !seat.connected ? 0.5 : 1;
    if (seat.isYou) {
      card.label = 'your card';
      card.eventMode = 'static';
      card.cursor = 'pointer';
      card.on('pointertap', () => env.onEdit());
    }
    const bh = Math.min(44, h - 16);
    const stamp = state === 'ready' ? h * 0.62 + 12 : 0;
    const bx = w - bh - leanShift(bh, 12) - 14 - stamp;
    const by = (h - bh) / 2 - 2;
    let right = w - stamp - 14;
    const extra = (b: Button, x: number): void => {
      b.placeFace(x, by);
      this._layer.addChild(b);
      env.focus.add(b);
      this._buttons.push(b);
      right = Math.min(right, x);
    };

    if (host && seat.kind === 'bot') {
      extra(
        iconButton(kit, 'minus', bh, 'secondary', () => env.onRemoveBot(seat.id)),
        bx,
      );
    } else if (host && seat.kind === 'player' && !seat.isYou && !this._kicking) {
      extra(
        iconButton(kit, 'close', bh, 'secondary', () => env.onKick(seat.id)),
        bx,
      );
    } else if (!host && seat.isYou && env.role === 'guest') {
      extra(
        iconButton(kit, 'edit', bh, 'primary', () => env.onEdit()),
        bx,
      );
    } else if (host && seat.kind === 'open') {
      const aw = env.kind === 'p' ? 108 : env.kind === 'l' ? 112 : 132;

      extra(
        textButton(kit, 'Add bot', aw, bh, 'secondary', 'bot', () => env.onAddBot()),
        w - aw - 14,
      );
    }
    const nameSize = Math.round(h * 0.27);
    const cx = c.x - f.x;
    const max = Math.min(c.w, right - 8 - cx);
    const name = makeText(
      seat.kind === 'open' ? 'Open seat' : seat.kind === 'joining' ? 'Joining…' : seat.name,
      cx,
      h * 0.2,
      { s: nameSize, w: 600, i: true, c: seat.kind === 'open' ? COLORS.mist : COLORS.white, max },
      kit.layout.textResolution,
    );
    const sub = makeText(
      this._sub(seat),
      cx,
      h * 0.2 + nameSize + 6,
      { s: Math.max(12, Math.round(nameSize * 0.68)), w: 500, c: COLORS.mist, max },
      kit.layout.textResolution,
    );

    this._layer.addChild(name, sub);
    if (seat.kind === 'player' && !seat.connected) {
      const s = Math.round(h * 0.42);
      const icon = new ArtSprite(
        kit.textures,
        iconSvg('offline', { size: s, color: COLORS.white, accent: COLORS.amber }),
        kit.layout.density,
      );

      icon.position.set(w - s - 18 - icon.art.face!.x, (h - s) / 2 - icon.art.face!.y);
      this._layer.addChild(icon);
    }
    if (this._kicking) this._drawKick(seat, [name, sub]);
    // Keys were on this card (Add bot, say): they stay on it, on whatever control it has now.
    if (focused >= 0 && kit.keys) env.focus.focus(this._buttons[Math.min(focused, this._buttons.length - 1)] ?? null);
  }

  private _sub(seat: SeatView): string {
    const host = this._env.role === 'host';

    if (seat.kind === 'open')
      return host && this._env.kind === 'd' ? 'Share the code, or add a bot' : 'Free for a friend';
    if (seat.kind === 'joining') return 'Connecting to the party';
    if (seat.kind === 'bot') return 'Bot, driven by the host';
    if (!seat.connected) return 'Reconnecting. Seat held';
    if (seat.isHost) return seat.isYou ? 'Host. You start the race' : 'Host';
    if (seat.isYou && this._env.role === 'guest') {
      if (seat.ready) return "You're ready";

      return this._env.kind === 'd' ? 'Tap your card to change truck' : 'Tap to change truck';
    }

    return seat.ready ? 'Ready' : 'Not ready yet';
  }

  /** The inline remove confirm over the card's name area; the name and its line under it hide while it shows. */
  private _drawKick(seat: SeatView, covered: readonly Text[]): void {
    const env = this._env;
    const { w, h, kit } = env;
    const d = env.kind === 'd';
    const cw = d ? w - h * 1.55 - 30 : w - 12;
    const x0 = w - cw - 6;
    const bh = Math.min(44, h - 16);
    const by = (h - bh) / 2 - 2;
    const bw = d ? 96 : 78;
    const art = panelSvg({ width: cw, height: h - 12, tone: 'card', chamfer: 8 });
    const plate = new SlicedArt(kit.textures, art, kit.layout.density);
    const group = new Container();

    plate.position.set(x0 - art.face!.x, 6 - art.face!.y);
    group.addChild(plate);
    group.addChild(
      makeText(
        `Remove ${seat.name}?`,
        x0 + 12,
        h / 2 - 9,
        { s: d ? 17 : 15, w: 600, i: true, max: cw - bw * 2 - 40 },
        kit.layout.textResolution,
      ),
    );
    const remove = textButton(kit, 'Remove', bw, bh, 'danger', null, () => env.onKickConfirm(seat.id)).placeFace(
      x0 + cw - bw * 2 - 18,
      by,
    );
    const keep = textButton(kit, 'Keep', bw, bh, 'secondary', null, () => env.onKickCancel()).placeFace(
      x0 + cw - bw - 8,
      by,
    );

    group.addChild(remove, keep);
    this._layer.addChild(group);
    env.focus.add(remove, true);
    env.focus.add(keep);
    this._buttons.push(remove, keep);
    for (const t of covered) t.visible = false;
    if (!this._motion.reduced) {
      group.pivot.set(w, h / 2);
      group.position.set(w, h / 2);
      this._motion.fromTo(group, { alpha: 0 }, { alpha: 1, duration: 0.15 });
      this._motion.fromTo(group.scale, { x: 0.6 }, { x: 1, ...MOTION.slot });
    }
  }

  /** Someone took the seat: the card rolls open, flashes white, and the bay slides in from the left. */
  private _joinMoment(): void {
    const { kit, w, h } = this._env;
    const m = this._motion;

    kit.sound.play('join');
    if (m.reduced) return;
    m.fromTo(this.node.scale, { y: 0 }, { y: 1, ...MOTION.slot });
    this._flashOver(0, 0, w, h, 0.6, 0.3);
    const card = this._card!;

    void card.loaded.then(() => {
      if (card.destroyed || card.texture === Texture.EMPTY) return;
      const f = card.art.face!;
      const bw = h * 1.55;
      const frame = new Rectangle(f.x + 6, f.y + 6, bw, h - 12);
      const cover = new Sprite(Texture.WHITE);
      const crop = new Texture({ source: card.texture.source, frame });
      const bay = new Sprite(crop);
      const mask = new Graphics().rect(6, 6, bw, h - 12).fill(0xffffff);

      this._crops.push(crop);

      cover.tint = 0x060920;
      cover.position.set(6, 6);
      cover.width = bw;
      cover.height = h - 12;
      bay.position.set(6 - bw, 6);
      bay.mask = mask;
      this._layer.addChild(cover, bay, mask);
      m.to(bay, {
        x: 6,
        duration: 0.45,
        ease: 'back.out(1.4)',
        delay: 0.08,
        onComplete: () => {
          for (const n of [cover, bay, mask]) n.destroy();
          this._crops = this._crops.filter((t) => t !== crop);
          crop.destroy(false);
        },
      });
    });
  }

  /** The seat emptied: a white shutter drops over the bay. */
  private _leaveMoment(): void {
    const { kit, h } = this._env;
    const m = this._motion;

    kit.sound.play('leave');
    if (m.reduced) return;
    const shutter = new Sprite(Texture.WHITE);

    shutter.position.set(6, 6);
    shutter.width = h * 1.55;
    shutter.height = h - 12;
    this._layer.addChild(shutter);
    m.timeline({ onComplete: () => shutter.destroy() })
      .fromTo(shutter.scale, { y: 0 }, { y: shutter.scale.y, duration: 0.25, ease: 'power2.in' })
      .to(shutter, { alpha: 0, duration: 0.2 });
  }

  /** Ready: the stamp drops from 1.8x and punches in, the green tape draws on clockwise, the card jolts. */
  private _readyMoment(old: ArtSprite | null): void {
    const { kit, w, h } = this._env;
    const m = this._motion;

    kit.sound.play('clack');
    m.delay(0.12, () => kit.sound.play('confirm'));
    if (m.reduced || !old || old.destroyed) {
      old?.destroy();

      return;
    }
    const card = this._card!;

    this._layer.addChildAt(old, 0);
    const mask = new Graphics();
    // A sweep of 0 is a polygon with no area: its empty mask draw is a GL error, so the tape starts a sliver in.
    const sweep = { a: 0.03 };
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.hypot(w, h);

    card.mask = mask;
    this._layer.addChild(mask);
    const draw = (): void => {
      if (mask.destroyed) return;
      mask.clear().moveTo(cx, cy);
      const start = -Math.PI * 0.75;
      const steps = 24;

      for (let i = 0; i <= steps; i++) {
        const a = start + (sweep.a * Math.PI * 2 * i) / steps;

        mask.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      mask.closePath().fill(0xffffff);
    };

    draw();
    m.to(sweep, {
      a: 1,
      duration: 0.25,
      ease: 'none',
      onUpdate: draw,
      onComplete: () => {
        if (!card.destroyed) card.mask = null;
        mask.destroy();
        old.destroy();
      },
    });
    const size = h * 0.62;
    const stampArt: SvgArt = readyStampSvg(size, true);
    const stamp = new ArtSprite(kit.textures, stampArt, kit.layout.density * 1.8);

    stamp.anchor.set(0.5);
    stamp.position.set(w - size / 2 - 12, h / 2);
    this._layer.addChild(stamp);
    m.fromTo(stamp, { alpha: 0 }, { alpha: 1, duration: 0.08 });
    m.fromTo(stamp.scale, { x: 1.8, y: 1.8 }, { x: 1, y: 1, ...MOTION.punch, onComplete: () => stamp.destroy() });
    m.delay(0.1, () => m.shake(this.node, 2, 0.12, 2));
  }

  /** A new colour: the old card fades out over the new one. */
  private _crossfade(old: ArtSprite): void {
    this._layer.addChildAt(old, this._layer.getChildIndex(this._card!) + 1);
    this._env.kit.sound.play('pluck');
    this._motion.to(old, { alpha: 0, duration: 0.3, onComplete: () => old.destroy() });
  }

  private _flashOver(x: number, y: number, w: number, h: number, alpha: number, duration: number): void {
    const flash = new Sprite(Texture.WHITE);

    flash.position.set(x, y);
    flash.width = w;
    flash.height = h;
    flash.alpha = alpha;
    this._layer.addChild(flash);
    this._motion.to(flash, { alpha: 0, duration, ease: 'power2.out', onComplete: () => flash.destroy() });
  }
}

/** Whether two seat views draw the same card. */
function sameLook(a: SeatView, b: SeatView): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.name === b.name &&
    a.car === b.car &&
    a.ready === b.ready &&
    a.isHost === b.isHost &&
    a.isYou === b.isYou &&
    a.connected === b.connected
  );
}
