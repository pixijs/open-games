import type { Text } from 'pixi.js';
import { Container } from 'pixi.js';

import { iconSvg } from '../art/icons';
import { nameTagSvg, resultRowSvg } from '../art/panels';
import { leanShift } from '../art/svg';
import { COLORS, MOTION, RACERS } from '../art/tokens';
import type { ResultRow, Screen } from '../contract';
import { ArtSprite } from '../kit/ArtSprite';
import type { Meter } from '../kit/Meter';
import { fitText, makeText } from '../kit/text';
import type { ToastHang } from '../kit/ToastStack';
import { MenuScreen } from './MenuScreen';

type ResultsData = Extract<Screen, { id: 'results' }>;

interface Tag {
  readonly id: string;
  readonly place: number;
  readonly node: Container;
  readonly drop: Container;
  seen: boolean;
  onScreen: boolean;
  /** Where its truck is on screen, box px */
  truckX: number;
  truckY: number;
}

/** The box a tag's pointer tip may sit in, clear of the table, the actions and the screen's edges */
interface TagArea {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const LOBBY_WINDOW_MS = 20000;
/** The podium camera has settled once no truck moves more than this many box px a frame for {@link SETTLE_MS} */
const SETTLE_PX = 1.5;
const SETTLE_MS = 180;
/** Tags drop by this long after the screen enters even if the camera is still moving */
const SETTLE_CAP_MS = 2200;
const TAG_H = 30;
/** A tag's height from its plate's top to its pointer's tip, with a gap: how far apart two stacked tags sit */
const TAG_STEP = Math.ceil(TAG_H * 1.32) + 6;
/**
 * Where the results column starts across a landscape phone, as a share of its width: the podium shot frames the trucks
 * round 29 % across (StageCameras' PODIUM_WIDE), so the left half is theirs.
 */
const LANDSCAPE_COLUMN = 0.52;
/** The landscape heading's height (title and subline), over the scene top left. */
const LANDSCAPE_HEAD = 60;

/** 2:01.40 */
export function formatTime(ms: number): string {
  const cs = Math.round(ms / 10);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);

  return `${m}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** +0.84, or +1:02.10 past a minute */
export function formatGap(ms: number): string {
  return ms < 60000 ? `+${(ms / 1000).toFixed(2)}` : `+${formatTime(ms)}`;
}

/**
 * The results over the podium camera: once the camera settles, metal place tags drop onto the top three trucks (3rd,
 * 2nd, 1st, 0.15 s apart, riding the trucks' screen positions from the HUD frames, kept inside the safe area and clear
 * of the table and the actions), the table rows slot in once the winner's tag lands, with the winner's confetti and
 * the fanfare when someone took the flag. A time projected for a racer still running as the race closed reads `~0:26.10`
 * and `proj.`, without a trophy. Host: Back to lobby; guest: waiting for the host; both see the Lobby in 14
 * meter. Solo: Race again and Back to title.
 */
export class ResultsScreen extends MenuScreen<ResultsData> {
  private _tags: Tag[] = [];
  private _rowItems: Container[] = [];
  private _meter: Meter | null = null;
  private _count: Text | null = null;
  private _shownAt = 0;
  private _landed = false;
  /** performance.now() the screen entered; 0 until it does, and again once the tags drop */
  private _waitFrom = 0;
  private _stillSince = 0;
  private _tagW = 104;
  private readonly _area: TagArea = { x0: 0, x1: 0, y0: 0, y1: 0 };

  protected override build(): void {
    const { k, W, H, S } = this;
    const data = this.data;
    const solo = data.role === 'solo';
    const best = data.rows.filter((r) => r.bestLap > 0).sort((a, b) => a.bestLap - b.bestLap)[0];
    const laps = this.host.memory.laps;
    const lapsCopy = `${laps} lap${laps === 1 ? '' : 's'}`;
    const sub = `${solo ? `Quick race, ${lapsCopy}` : lapsCopy}.${best ? ` Best lap: ${best.name}, ${formatTime(best.bestLap)}` : ''}`;

    this._tags = [];
    this._rowItems = [];
    this._shownAt ||= performance.now();
    this.begin(true);
    if (k === 'd') {
      this.scrim('top', 0.88, 0.62);
      this.scrim('right', 0.55, 0.5);
    } else if (k === 'p') {
      this.scrim('top', 0.92, 0.55);
      this.scrim('bottom', 0.92, 0.32);
    } else {
      this.scrim('right', 0.92, 0.6);
      this.scrim('top', 0.7, 0.4);
    }
    const tagLayer = new Container();

    this.target.addChild(tagLayer);
    this.begin();
    this._tagW = k === 'd' ? 132 : 104;
    const tagHalf = this._tagW / 2 + 8;
    const tagTall = TAG_H * 1.32 + 8;

    if (k === 'd') {
      const x = W - 540;

      this.title('Race results', x, S.t + 8, 44);
      this.text(sub, x + 2, S.t + 58, { s: 15, c: COLORS.mist, max: 500 });
      this._table(x, S.t + 90, 500, 54, 8, 19);
      this.begin();
      this._actions(x, H - S.b, 500, 52, 14, 0.58);
      this._setArea(S.l + tagHalf, x - tagHalf - 12, S.t + tagTall, H - S.b);
    } else if (k === 'p') {
      const w = W - S.l - S.r;

      this.title('Race results', S.l, S.t + 2, 34);
      this.text(sub, S.l, S.t + 44, { s: 14, c: COLORS.mist, max: w });
      const table = this._table(S.l, S.t + 72, w, 50, 6, 17);

      this.begin();
      const top = this._actions(S.l, H - S.b, w, 50, 10, null);

      this._setArea(S.l + tagHalf, W - S.r - tagHalf, table + 6 + tagTall, top - 8);
    } else {
      // The heading takes the sky top left, so the column on the right holds the table and the actions at full size.
      // The actions take the race menu's landscape button height and split near even: in a column this narrow the two
      // labels in a row are about as long, and desktop's 0.58 leaves Leave party or Back to title no padding at 740 px.
      const x = Math.round(W * LANDSCAPE_COLUMN);

      this.title('Race results', S.l, S.t + 2, 28);
      this.text(sub, S.l, S.t + 40, { s: 14, c: COLORS.mist, max: x - S.l - 24 });
      this._table(x, S.t, W - S.r - x, 46, 6, 16);
      this.begin();
      this._actions(x, H - S.b, W - S.r - x, 44, 10, 0.52);
      this._setArea(S.l + tagHalf, x - tagHalf - 10, (this.toastBottom() ?? 0) + tagTall, H - S.b);
    }
    this._buildTags(tagLayer);
    if (this._waitFrom) this._armDropCap();
    if (!solo) this.motion.tick(() => this._tickLobby());
    if (this._landed) for (const r of this._rowItems) r.alpha = 1;
  }

  protected override entered(): void {
    this._waitFrom = performance.now();
    this._stillSince = this._waitFrom;
    this._armDropCap();
  }

  /** Drops the tags at the cap even if no race frames arrive to say the camera settled. */
  private _armDropCap(): void {
    const left = Math.max(0, this._waitFrom + SETTLE_CAP_MS - performance.now());

    this.motion.delay(left / 1000, () => this._settled());
  }

  private _settled(): void {
    if (!this._waitFrom) return;
    this._waitFrom = 0;
    this._dropTags();
  }

  /** Phones: just under the table (portrait), or under the heading over the scene (landscape), clear of the actions. */
  public override toastBottom(): number | null {
    const { k, S } = this;

    return k === 'p' ? S.t + 72 + 4 * 56 + 52 : k === 'l' ? S.t + LANDSCAPE_HEAD + 56 : null;
  }

  /** Desktop: over the podium's sky top left, since the heading and the table take the top right. */
  public override toastHang(): ToastHang {
    return { side: 'left', top: this.S.t };
  }

  public override back(): boolean {
    if (this.data.role === 'solo') this.host.actions.leave();
    else this._leave();

    return true;
  }

  /**
   * Each frame: the tags ride their trucks, kept inside their area. Until they drop, this watches the trucks on screen
   * and drops them once the podium camera has settled.
   */
  public override frame(
    racers: readonly { id: string; screenX: number; screenY: number; tagVisible: boolean }[],
  ): void {
    const scale = this.L.scale;
    const now = performance.now();
    let moving = false;

    for (const tag of this._tags) {
      for (const r of racers) {
        if (r.id !== tag.id) continue;
        const x = r.screenX / scale;
        const y = r.screenY / scale;

        if (!tag.seen || Math.abs(x - tag.truckX) + Math.abs(y - tag.truckY) > SETTLE_PX) moving = true;
        tag.truckX = x;
        tag.truckY = y;
        tag.seen = true;
        tag.onScreen = r.tagVisible;
      }
    }
    this._placeTags();
    if (!this._waitFrom) return;
    if (moving) this._stillSince = now;
    if (now - this._stillSince >= SETTLE_MS) this._settled();
  }

  private _setArea(x0: number, x1: number, y0: number, y1: number): void {
    const a = this._area;

    a.x0 = x0;
    a.x1 = Math.max(x0, x1);
    a.y0 = y0;
    a.y1 = Math.max(y0, y1);
  }

  /**
   * Puts each tag over its truck, inside the area. A tag that would overlap one already placed slides sideways off it,
   * toward its own truck's side, so both pointers stay over their trucks; where the area has no room for that, it
   * stacks a whole tag above (or below) the other.
   */
  private _placeTags(): void {
    const a = this._area;
    const w = this._tagW + 6;
    const clampX = (x: number): number => Math.min(a.x1, Math.max(a.x0, x));

    for (let i = 0; i < this._tags.length; i++) {
      const tag = this._tags[i];
      const node = tag.node;
      let x = clampX(tag.truckX);
      let y = Math.min(a.y1, Math.max(a.y0, tag.truckY));

      for (let j = 0; j < i; j++) {
        const other = this._tags[j];
        const ox = other.node.x;
        const oy = other.node.y;

        if (Math.abs(ox - x) >= w || Math.abs(oy - y) >= TAG_STEP) continue;
        const side = clampX(ox + (tag.truckX < other.truckX ? -w : w));

        if (Math.abs(side - ox) >= w) x = side;
        else y = oy - TAG_STEP >= a.y0 ? oy - TAG_STEP : oy + TAG_STEP;
      }
      node.visible = tag.seen && tag.onScreen;
      node.position.set(x, y);
    }
  }

  /** The rows from `y`; returns their bottom edge. */
  private _table(x: number, y: number, w: number, h: number, gap: number, s: number): number {
    const d = this.k === 'd';
    const rows = new Container();

    this.target.addChild(rows);
    const prev = this.target;

    this.data.rows.forEach((r: ResultRow, i) => {
      const item = new Container();

      rows.addChild(item);
      this.into(item);
      const dnf = r.time === 0;
      const p = this.put(
        resultRowSvg({ place: r.place, color: RACERS[r.car], you: r.isYou, dnf, width: w, height: h }),
        x,
        y + i * (h + gap),
      );
      const projected = !dnf && r.projected === true;
      const time = this.text(
        dnf ? 'DNF' : `${projected ? '~' : ''}${formatTime(r.time)}`,
        p.c.x + p.c.w - (d ? 110 : 84),
        p.c.y + h * 0.26,
        {
          f: 'b',
          s: s * 1.25,
          w: 800,
          a: 'r',
          c: dnf || projected ? COLORS.mist : COLORS.white,
        },
      );

      this.text(r.name, p.c.x, p.c.y + h * 0.3, {
        s,
        w: 600,
        i: true,
        c: r.isYou ? COLORS.cyan : dnf ? COLORS.mist : COLORS.white,
        max: time.x - time.width - 12 - p.c.x,
      });
      if (projected) {
        this.text('proj.', p.c.x + p.c.w, p.c.y + h * 0.3, { f: 'b', s: s * 1.05, w: 700, a: 'r', c: COLORS.mist });
      } else if (r.place === 1 && !dnf) {
        this.put(
          iconSvg('trophy', { size: s * 1.2, metal: 'gold' }),
          p.c.x + p.c.w - s * 1.3,
          p.c.y + (h - s * 1.2) / 2 - 2,
        );
      } else if (!dnf) {
        this.text(formatGap(r.gap), p.c.x + p.c.w, p.c.y + h * 0.3, {
          f: 'b',
          s: s * 1.05,
          w: 700,
          a: 'r',
          c: COLORS.mist,
        });
      }
      item.alpha = 0;
      this._rowItems.push(item);
    });
    this.into(prev);

    return y + this.data.rows.length * (h + gap) - gap;
  }

  /**
   * The actions, built up from `bottom` the same way for every role: the lead and Back to title or Leave party, the
   * track's own actions over them, and the Lobby in N meter on top (none solo). `split` pairs them two to a row, the
   * lead's column taking that share of the width, so each track action sits over the lead or the back action at its
   * size; null stacks them full width, the lead taller.
   * @returns The block's top edge.
   */
  private _actions(x: number, bottom: number, w: number, h: number, gap: number, split: number | null): number {
    const { role, editable, canSaveTrack } = this.data;
    const d = this.k === 'd';
    const lw = Math.round((w - gap) * (split ?? 0.58));
    let y = bottom - h;

    if (split === null) {
      y -= gap + h + 12;
      this._lead(x, y, w, h + 12);
      this._back(x, bottom - h, w, h);
    } else {
      this._lead(x, y, lw, h);
      this._back(x + lw + gap, y, w - lw - gap, h);
    }
    if (editable || canSaveTrack) {
      y -= gap + h;
      this._trackAction(x, y, w, h, lw, gap);
    }
    if (role === 'solo') return y;
    const meterY = y - gap - 12;
    const labelW = d ? 92 : 78;

    this._count = this.middled(this.text('Lobby in 20', x, meterY - 4, { f: 'b', s: d ? 18 : 15, w: 800 }));
    this._meter = this.meter(x + labelW, meterY, w - labelW, 8, 1, COLORS.cyan);

    return meterY - 8;
  }

  /** Back to title solo; Leave party in a party. */
  private _back(x: number, y: number, w: number, h: number): void {
    if (this.data.role === 'solo')
      this.button('Back to title', x, y, w, h, 'secondary', 'back', () => this.host.actions.leave());
    else this.button('Leave party', x, y, w, h, 'secondary', 'exit', () => this._leave());
  }

  /**
   * Edit track and Share after a race from the editor or the library; Save track for a guest on a track they haven't
   * got. Edit track with Share beside it takes the lead's column `lw` and Share the rest of `w`, so the pair lines up
   * with the row under it; a lone action spans all of `w` rather than leave half its row empty.
   */
  private _trackAction(x: number, y: number, w: number, h: number, lw: number, gap: number): void {
    const a = this.host.actions;

    if (this.data.editable) {
      const id = this.data.trackId ?? '';
      const share = a.shareTrack !== undefined;

      this.button('Edit track', x, y, share ? lw : w, h, 'primary', 'edit', () => a.editTrack(id));
      if (share) this.button('Share', x + lw + gap, y, w - lw - gap, h, 'secondary', 'share', () => this._share(id));
    } else if (this.data.canSaveTrack) {
      this.button('Save track', x, y, w, h, 'secondary', 'plus', () => {
        if (a.saveSharedTrack()) this.host.toast({ kind: 'notice', text: 'Saved to My tracks.' });
      });
    }
  }

  /** The track's link: the share sheet on a phone, else copied. */
  private _share(id: string): void {
    this.host.actions
      .shareTrack?.(id)
      .then((how) =>
        this.host.toast(
          how === 'shared' ? { kind: 'shared' } : { kind: 'notice', text: 'Track link copied. Paste it to a friend.' },
        ),
      )
      .catch(() => this.host.toast({ kind: 'notice', text: "Couldn't copy the link." }));
  }

  private _lead(x: number, y: number, w: number, h: number): void {
    const { role, hostName } = this.data;

    if (role === 'solo') this.button('Race again', x, y, w, h, 'go', 'rematch', () => this._rematch(), true);
    else if (role === 'host') this.button('Back to lobby', x, y, w, h, 'go', 'rematch', () => this._rematch(), true);
    else {
      const wait = this.button(`Waiting for ${hostName}`, x, y, w, h, 'secondary', null, () => undefined);
      const label = wait.labelText;

      // A host name runs to 16 letters, past a half-row. Fitted a quarter of the height clear of the slanted ends,
      // before setDisabled lays the label out again.
      if (label) fitText(label, w - leanShift(h, 12) - h / 2);
      wait.setDisabled(true);
    }
  }

  private _buildTags(layer: Container): void {
    const w = this.k === 'd' ? 132 : 104;
    const kit = this.host.kit;

    for (const r of this.data.rows) {
      if (r.place > 3 || r.time === 0) continue;
      const art = nameTagSvg(RACERS[r.car], { width: w, height: 30, podium: r.place as 1 | 2 | 3 });
      const node = new Container();
      const drop = new Container();
      const sprite = new ArtSprite(kit.textures, art, this.L.density);
      const a = art.anchor!;
      const c = art.content!;

      sprite.position.set(-art.width * a.x, -art.height * a.y);
      const name = makeText(
        r.name,
        sprite.x + c.x + 2,
        sprite.y + c.y + (c.h - 15) / 2,
        { s: 15, w: 600, i: true, max: c.w - 6 },
        this.L.textResolution,
      );

      drop.addChild(sprite, name);
      drop.alpha = this._landed ? 1 : 0;
      node.addChild(drop);
      node.visible = false;
      layer.addChild(node);
      this.track(sprite.loaded);
      this._tags.push({ id: r.id, place: r.place, node, drop, seen: false, onScreen: false, truckX: 0, truckY: 0 });
    }
    this._tags.sort((p, q) => q.place - p.place);
  }

  /**
   * 3rd, 2nd, then 1st fall onto their trucks 0.15 s apart, gathering speed, and land with a clack and a squash that
   * springs back; the winner falls from higher and lands with the fanfare, its confetti and the table's rows.
   */
  private _dropTags(): void {
    const m = this.motion;
    const kit = this.host.kit;
    const start = 0.05;
    const fall = 0.26;

    this._tags.forEach((tag, i) => {
      if (m.reduced) {
        m.fromTo(tag.drop, { alpha: 0 }, { alpha: 1, duration: 0.15, delay: start });

        return;
      }
      const first = tag.place === 1;

      m.fromTo(tag.drop, { alpha: 0 }, { alpha: 1, duration: 0.1, delay: start + i * 0.15 });
      m.timeline({ delay: start + i * 0.15 })
        .fromTo(tag.drop, { y: first ? -110 : -70 }, { y: 0, duration: fall, ease: 'power3.in' })
        .call(() => {
          if (!first) kit.sound.play('clack');
        })
        .fromTo(
          tag.drop.scale,
          { x: first ? 1.28 : 1.18, y: first ? 0.7 : 0.78 },
          { x: 1, y: 1, duration: 0.6, ease: 'elastic.out(1, 0.4)' },
        );
    });
    const winner = this._tags.find((t) => t.place === 1);
    const land = start + Math.max(0, this._tags.length - 1) * 0.15 + (m.reduced ? 0.15 : fall);
    const someoneFinished = this.data.rows.some((r) => r.time > 0 && !r.projected);

    m.delay(land, () => {
      this._landed = true;
      kit.sound.play(someoneFinished ? 'fanfare' : 'clack');
      if (someoneFinished && winner?.seen && winner.node.visible) {
        const row = this.data.rows.find((r) => r.id === winner.id);
        const at = this.host.fx.toLocal(winner.node.getGlobalPosition());

        if (row) this.host.confetti(at.x, at.y - 40, RACERS[row.car].main, 24, 1.3);
      }
      this._rowItems.forEach((item, i) => {
        if (m.reduced) {
          m.to(item, { alpha: 1, duration: 0.15 });

          return;
        }
        m.fromTo(item, { x: 40, alpha: 0 }, { x: 0, alpha: 1, ...MOTION.slot, delay: i * MOTION.stagger });
      });
    });
  }

  private _tickLobby(): void {
    const at = this.data.lobbyAt;

    if (!at || !this._count) return;
    const left = Math.max(0, at - performance.now());
    const secs = Math.ceil(left / 1000);
    const label = `Lobby in ${secs}`;

    this._meter?.set(left / LOBBY_WINDOW_MS);
    if (this._count.text === label) return;
    this._count.text = label;
    if (secs > 0 && secs < 5) {
      this.motion.punch(this._count.scale, 1.3, 0.4);
      this.host.kit.sound.play('tick');
    }
  }

  /** Again: an engine blip as the party heads back. */
  private _rematch(): void {
    this.host.kit.sound.play('revBlip');
    this.host.actions.rematch();
  }

  private _leave(): void {
    const lobby = this.host.memory.lobby;

    this.host.showLocal({
      id: 'leaveConfirm',
      role: this.data.role,
      hostName: this.data.hostName,
      others: (lobby?.seats ?? []).filter((s) => s.kind === 'player' && !s.isYou).map((s) => s.name),
    });
  }
}
