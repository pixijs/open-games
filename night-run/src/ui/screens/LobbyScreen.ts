import type { Text } from 'pixi.js';
import { Container, Graphics } from 'pixi.js';

import { iconSvg } from '../art/icons';
import { glintSvg } from '../art/motifs';
import { planSvg } from '../art/trackArt';
import { leanShift } from '../art/svg';
import { COLORS, MOTION } from '../art/tokens';
import type { Screen } from '../contract';
import { ArtSprite } from '../kit/ArtSprite';
import { Button } from '../kit/Button';
import type { Meter } from '../kit/Meter';
import { WHITE80 } from '../kit/text';
import { listNames } from './LeaveScreen';
import type { CodePlateView } from './MenuScreen';
import { cardFacts, COLLAB_SIZE, MenuScreen, planPoints } from './MenuScreen';
import type { LobbyData } from './ScreenHost';
import { SeatCard } from './SeatCard';

const ARM_MS = 3000;
const COPIED_MS = 2500;
/** How long a redrawn control waits for its new art before it swaps in anyway */
const SWAP_WAIT_MS = 400;
/** Width of the seat column on desktop; the start row under it fills it */
const DESK_SEATS_W = 560;
/** Desktop: how tall the foot's buttons are (Start race, Ready, Leave party), as tall as every screen's main action */
const DESK_FOOT_H = 60;
/** Landscape: the left column's width, wide enough for the track row's name beside its Change */
const LAND_COL_W = 270;
/** Landscape: the gutter between the left column and the seats */
const LAND_GUTTER = 32;
/** Landscape: how tall the foot's button is (Start race, Ready, Leave party); the track row beside it matches */
const LAND_FOOT_H = 54;
/** Landscape: the band between the host's seats and Start, for the status line and Start anyway's meter */
const LAND_STATUS_BAND = 44;

/** A phone toast's height, so its slot can centre it */
const TOAST_H = 46;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every button under `node`. */
function buttonsIn(node: Container): Button[] {
  const out: Button[] = [];
  const visit = (n: Container): void => {
    if (n instanceof Button) out.push(n);
    else for (const child of n.children) visit(child);
  };

  visit(node);

  return out;
}

/**
 * The lobby for the host, a guest and a spectator: the party's plate, the four garage bays and the start. Updates
 * arrive in place, so each bay plays its own moment (a join, ready, a leave, a drop) and the plate, laps and start
 * change without the screen re-entering. The host gets Copy invite link, laps, Add bot, Remove (asks inline) and Start;
 * Start with someone not ready arms Start anyway for 3 s.
 */
export class LobbyScreen extends MenuScreen<LobbyData> {
  private _cards: SeatCard[] = [];
  private _kickId: string | null = null;
  private _armedUntil = 0;
  /** performance.now() time the copied look reverts; 0 when it isn't showing */
  private _copiedUntil = 0;
  /** What the last invite did: the share sheet sent it, or the link went to the clipboard */
  private _sent: 'shared' | 'copied' = 'copied';
  private _plate: CodePlateView | null = null;
  private _laps: Text | null = null;
  private _share: Container | null = null;
  private _foot: Container | null = null;
  private _footButtons: Button[] = [];
  private _armMeter: Meter | null = null;
  private _status: Text | null = null;
  private _start: Button | null = null;
  /** The track card's button (Change, or Save), swept when the track changes. */
  private _trackButton: Button | null = null;
  /** Where the seat list ends, for the status line centred under it. */
  private _seatsBottom = 0;
  /**
   * Phones: the middle of the band the layout leaves free, between the seats and the button under them (portrait) or
   * between the left column's pieces and the track row (landscape). The brand or the status line and the toasts
   * centre on it.
   */
  private _bandMid = 0;

  private get _copied(): boolean {
    return this._copiedUntil > performance.now();
  }

  public override update(data: Screen & { id: 'lobby' }): void {
    const prev = this.data;

    this.data = data;
    if (
      prev.role !== data.role ||
      prev.code !== data.code ||
      prev.seats.length !== data.seats.length ||
      prev.spectators > 0 !== data.spectators > 0
    ) {
      this.rebuild();

      return;
    }
    if (
      prev.track.code !== data.track.code ||
      prev.track.name !== data.track.name ||
      prev.trackSaved !== data.trackSaved
    ) {
      const changed = prev.track.code !== data.track.code;

      this.rebuild();
      if (changed) {
        this.host.kit.sound.play('pluck');
        this._trackButton?.sweep();
      }

      return;
    }
    if (this._kickId && !data.seats.some((s) => s.id === this._kickId && s.kind === 'player')) this._kickId = null;
    this._setSeats();
    if (prev.laps !== data.laps && this._laps) {
      this._laps.text = String(data.laps);
      this.motion.punch(this._laps.scale, 1.4);
      this.host.kit.sound.play('tick');
    }
    if (this._waitKey(prev) !== this._waitKey(data)) {
      const allReady = data.role === 'host' && prev.waitingFor.length > 0 && data.waitingFor.length === 0;

      if (!data.waitingFor.length) this._armedUntil = 0;
      void this._drawFoot().then(() => {
        if (allReady) this._allReady();
      });
    }
  }

  protected override build(): void {
    const { k, W, H, S } = this;
    const { role, laps, hostName } = this.data;
    const lapsText = laps === 1 ? '1 lap' : `${laps} laps`;
    const host = role === 'host';
    const spectator = role === 'spectator';
    const headTitle = host ? 'Your party' : `${hostName}'s party`;
    const back = (): void => void this.back();

    this._cards = [];
    this._plate = null;
    this._laps = null;
    this._footButtons = [];
    this._start = null;
    this._trackButton = null;
    if (role !== 'host') this._kickId = null;
    if (this._copied) this._armCopiedReset();
    else this._copiedUntil = 0;
    this.begin(true);
    if (k === 'd') this.scrim('left', 0.94, 0.75);
    else if (k === 'p') {
      this.scrim('top', 0.9, 0.9);
      this.scrim('top', 0.95, 0.3);
      this.dim(0.35);
    } else this.scrim('left', 0.94, 0.9);
    this.begin();
    this.header(headTitle, back);
    if (k === 'd') {
      // The columns are drawn for a 720 tall box; a taller one centres them under the header.
      const top = S.t + 96 + Math.max(0, Math.round((H - 720) / 2));
      const sx = 456;

      this.begin();
      this.label('Party code', S.l, top);
      this._plate = this._codePlate(S.l, top + 22, 330, 112);
      this.begin();
      if (host) {
        this._share = new Container();
        this._share.position.set(S.l, top + 164);
        this.target.addChild(this._share);
        this._drawShare();
        this.body('Friends open the link, or type the code under Join.', S.l, top + 234, 330, { s: 14 });
        this.begin();
        this.label('Laps', S.l, top + 286);
        this._laps = this._lapsStepper(S.l, top + 308, 46);
        this.begin();
        this._trackCard(S.l, top + 372, 330, 116);
      } else {
        // Who starts the race is the line under Ready, so the column only says the laps.
        this.body(spectator ? `Watching. ${lapsText}.` : `${lapsText}.`, S.l, top + 164, 330);
        this.begin();
        this._trackCard(S.l, top + 212, 330, 116);
      }
      this.begin();
      this.collab(COLLAB_SIZE.d, 'left', H - S.b);
      if (spectator) {
        this.begin();
        this._watching(sx, top - 12, DESK_SEATS_W, 74);
        this._seatList(sx, top + 82, DESK_SEATS_W, 80, 12);
        this._footAt(sx, top + 82 + 4 * 92 + 16);
      } else {
        this._seatList(sx, top, DESK_SEATS_W, 88, 14);
        this._footAt(sx, top + 4 * 102 + 18);
      }
    } else if (k === 'p') {
      const bw = W - S.l - S.r;
      let y = S.t + 62;

      this.begin();
      if (host) {
        this._plateAndShare(S.l, y, bw, 84);
        y += 104;
        this.begin();
        this.label('Laps', S.l, y + 14);
        this._laps = this._lapsStepper(S.l + 48, y, 44);
        y += 62;
      } else if (spectator) {
        this._watching(S.l, y, bw, 100);
        y += 120;
      } else {
        this._plate = this._codePlate(S.l, y, bw, 84);
        y += 104;
        this.body(`${lapsText}. ${hostName} starts the race when everyone is ready.`, S.l, y, bw, { s: 14 });
        y += 52;
      }
      this.begin();
      this._trackRow(S.l, y, bw, 54);
      y += 70;
      this._seatList(S.l, y, bw, 64, 8);
      this._footAt(S.l, H - S.b - 64);
      this._bandMid = (this._seatsBottom + H - S.b - 64) / 2;
      // The host's band holds the status line; everyone else's has the brand.
      if (!host) {
        this.begin();
        this.collab(COLLAB_SIZE.p, 'centre', Math.round(this._bandMid + COLLAB_SIZE.p / 2));
      }
    } else {
      // The left column stacks down from the title with 12 px between its pieces; the track row sits at its foot,
      // level with the button under the seats, and the brand in the band between.
      const cw = LAND_COL_W;
      const foot = H - S.b - LAND_FOOT_H;
      const seats = this._landSeats();
      let y = S.t + 56;
      let bottom: number;

      this.begin();
      if (spectator) {
        this._watching(S.l, y, cw, 102);
        bottom = y + 102;
      } else if (host) {
        this._plateAndShare(S.l, y, cw, 72);
        // Past the plate and the 6 px return under it.
        y += 72 + 6 + 12;
        this.begin();
        this.label('Laps', S.l, y + 16);
        this._laps = this._lapsStepper(S.l + 44, y, 44);
        bottom = y + 44;
      } else {
        this._plate = this._codePlate(S.l, y, cw, 72);
        y += 72 + 6 + 12;
        const body = this.body(`${lapsText}. ${hostName} starts the race when everyone is ready.`, S.l, y, cw, {
          s: 13,
        });

        bottom = y + body.height;
      }
      this._bandMid = (bottom + foot) / 2;
      this.begin();
      // Centred in the column, so a toast over the band covers it whole.
      this.collab(COLLAB_SIZE.l, 'centre', Math.round(this._bandMid + COLLAB_SIZE.l / 2), S.l, cw);
      this._trackRow(S.l, foot, cw, LAND_FOOT_H);
      this._seatList(seats.x, seats.y, seats.w, seats.h, seats.gap);
      this._footAt(seats.x, foot);
    }
  }

  /** On a phone: the code plate, and the copy-invite icon at the row's end, level with it. */
  private _plateAndShare(x: number, y: number, w: number, h: number): void {
    this._plate = this._codePlate(x, y, w - 72, h);
    this._share = new Container();
    this._share.position.set(x + w - 50 - leanShift(50, 12) + 2, y + (h - 50) / 2 - 1);
    this.target.addChild(this._share);
    this._drawShare();
  }

  /**
   * Landscape: the seats beside the left column, as tall as fits (to 64) down to the foot, so the list fills the
   * height instead of leaving a gap under it. The host keeps a band over Start for the status line; everyone else
   * keeps a plain 18 px gap.
   */
  private _landSeats(): { x: number; y: number; w: number; h: number; gap: number } {
    const { W, H, S } = this;
    const x = S.l + LAND_COL_W + LAND_GUTTER;
    const y = S.t + 6;
    const gap = 6;
    const band = this.data.role === 'host' ? LAND_STATUS_BAND : 18;
    const h = Math.min(64, Math.floor((H - S.b - LAND_FOOT_H - band - y - 3 * gap) / 4));

    return { x, y, w: W - S.r - x, h, gap };
  }

  /**
   * Phones: centred on the free band (over the brand or the status line), so a toast and the ones peeking behind it
   * never hide a seat, the laps, or the track's Change or Save.
   */
  public override toastBottom(): number | null {
    return this.k === 'd' ? null : Math.round(this._bandMid + TOAST_H / 2);
  }

  public override back(): boolean {
    if (this._kickId) {
      this._kickId = null;
      this.host.kit.sound.play('back');
      this._setSeats();
      void this._drawFoot();

      return true;
    }
    const { role, hostName, seats } = this.data;

    this.host.kit.sound.play('back');
    this.host.showLocal({
      id: 'leaveConfirm',
      role,
      hostName,
      others: seats.filter((s) => s.kind === 'player' && !s.isYou).map((s) => s.name),
    });

    return true;
  }

  public override destroy(): void {
    for (const c of this._cards) c.destroy();
    this._cards = [];
    super.destroy();
  }

  public override rebuild(): void {
    for (const c of this._cards) c.destroy();
    this._cards = [];
    super.rebuild();
  }

  /** The party's track as a card: its plan, name, who drew it and its length; Change for the host, Save for a guest. */
  private _trackCard(x: number, y: number, w: number, h: number): void {
    const t = this.data.track;
    const p = this.panel(x, y, w, h, { tone: 'card', chamfer: 12 });
    const tw = Math.round(h * 1.1);

    this.put(planSvg(planPoints(t, this.k === 'p'), t.ready, tw - 8, h - 12), p.c.x + 6, p.c.y + 6);
    this.label('Track', p.c.x + tw + 8, p.c.y + 10);
    this.text(t.name || 'Untitled', p.c.x + tw + 8, p.c.y + 30, { f: 'b', s: 22, w: 900, max: w - tw - 20 });

    const by = t.builtIn ? 'The original circuit' : t.author ? `by ${t.author}` : cardFacts(t);

    this.text(by, p.c.x + tw + 8, p.c.y + 56, { s: 13, c: COLORS.mist, max: w - tw - 20 });
    this._trackAction(p.c.x + w - 128, p.c.y + h - 42, 118, 34);
  }

  /**
   * On a phone: one row, the plan, the track's name and Change or Save at its end. The button sits `pad` in from the
   * row's top, right and bottom (its return counted), and the name takes what's left, shrinking and then cutting.
   */
  private _trackRow(x: number, y: number, w: number, h: number): void {
    const t = this.data.track;
    const p = this.panel(x, y, w, h, { tone: 'card', chamfer: 10 });
    const pad = 6;
    const bw = 112;
    // A button's return hangs a tenth of its height under its face.
    const bh = Math.round((h - pad * 2) / 1.1);
    const bx = p.c.x + w - pad - bw;
    const pw = h - pad;
    const nx = p.c.x + pad + pw + 10;

    this.put(planSvg(planPoints(t, this.k === 'p'), t.ready, pw, h - pad * 2), p.c.x + pad, p.c.y + pad);
    this.text(t.name || 'Untitled', nx, p.c.y + h / 2 - 9, { f: 'b', s: 18, w: 900, max: bx - 12 - nx });
    this._trackAction(bx, p.c.y + pad, bw, bh);
  }

  private _trackAction(x: number, y: number, w: number, h: number): void {
    const a = this.host.actions;

    if (this.data.canChangeTrack) {
      this._trackButton = this.button('Change', x, y, w, h, 'secondary', 'track', () => a.openTracks('pick'));
    } else if (this.data.track.builtIn) {
      return;
    } else if (!this.data.trackSaved) {
      this._trackButton = this.button('Save', x, y, w, h, 'secondary', 'plus', () => {
        if (a.saveSharedTrack()) this.host.toast({ kind: 'notice', text: 'Saved to My tracks.' });
      });
    } else {
      this.inbox(
        'Saved',
        { x, y, w, h },
        { s: 14, w: 700, c: COLORS.go },
        iconSvg('check', { size: 16, color: COLORS.go }),
      );
    }
  }

  /** The code plate; the host taps it to copy the invite. */
  private _codePlate(x: number, y: number, w: number, h: number): CodePlateView {
    const p = this.codePlate(x, y, w, h, this._copied ? 'copied' : 'idle', this.data.code);

    if (this.data.role === 'host') {
      p.sprite.eventMode = 'static';
      p.sprite.cursor = 'pointer';
      p.sprite.on('pointertap', () => this.copyInvite());
    }

    return p;
  }

  /** Opens the inline Remove confirm on a seat. */
  public askKick(id: string): void {
    this._kickId = id;
    this.host.kit.sound.play('arm');
    this._setSeats();
    void this._drawFoot();
  }

  private _waitKey(d: LobbyData): string {
    return `${d.waitingFor.join(',')}|${d.seats.find((s) => s.isYou)?.ready ?? ''}`;
  }

  private _lapsStepper(x: number, y: number, h: number): Text {
    const a = this.host.actions;
    return this.stepper(
      x,
      y,
      this.data.laps,
      h,
      () => a.setLaps(Math.max(1, this.data.laps - 1)),
      () => a.setLaps(Math.min(9, this.data.laps + 1)),
    ).value;
  }

  private _watching(x: number, y: number, w: number, h: number): void {
    const { k } = this;
    const st = this.panel(x, y, w, h, { tone: 'card', accent: COLORS.cyan, chamfer: 12 });
    const more = this.data.spectators > 1 ? ` ${this.data.spectators - 1} more watching.` : '';

    if (k === 'd') {
      this.put(iconSvg('eye', { size: 30, accent: COLORS.cyan }), st.c.x + 18, st.c.y + 22);
      this.text("You're watching", st.c.x + 62, st.c.y + 15, { f: 'b', s: 26, w: 900 });
      this.text(`All 4 seats are taken. You race when a seat opens.${more}`, st.c.x + 62, st.c.y + 46, {
        s: 14,
        c: COLORS.mist,
        max: 480,
      });
    } else if (k === 'p') {
      this.put(iconSvg('eye', { size: 28, accent: COLORS.cyan }), st.c.x + 14, st.c.y + 20);
      this.text("You're watching", st.c.x + 54, st.c.y + 18, { f: 'b', s: 24, w: 900 });
      this.body(`All 4 seats are taken. You race when a seat opens.${more}`, st.c.x + 54, st.c.y + 50, w - 70, {
        s: 14,
      });
    } else {
      this.put(iconSvg('eye', { size: 26, accent: COLORS.cyan }), st.c.x + 14, st.c.y + 18);
      this.text("You're watching", st.c.x + 50, st.c.y + 20, { f: 'b', s: 22, w: 900 });
      this.body(`All 4 seats are taken. You race when a seat opens.${more}`, st.c.x + 14, st.c.y + 56, w - 28, {
        s: 13,
      });
    }
  }

  private _seatList(x: number, y: number, w: number, h: number, gap: number): void {
    const a = this.host.actions;

    this._seatsBottom = y + this.data.seats.length * (h + gap) - gap;

    this.data.seats.forEach((seat, i) => {
      const group = this.begin();
      const card = new SeatCard({
        kit: this.host.kit,
        focus: this.focus,
        kind: this.k,
        role: this.data.role,
        w,
        h,
        bay: i + 1,
        onEdit: () => {
          this.host.kit.sound.play('confirm');
          this.host.openSelect();
        },
        onKick: (id) => this.askKick(id),
        onKickConfirm: (id) => {
          this._kickId = null;
          a.kick(id);
          void this._drawFoot();
        },
        onKickCancel: () => void this.back(),
        onRemoveBot: (id) => a.removeBot(id),
        onAddBot: () => a.addBot(),
      });

      card.place(x, y + i * (h + gap));
      card.set(seat, seat.id === this._kickId);
      group.addChild(card.node);
      this.track(card.loaded);
      this._cards.push(card);
    });
  }

  private _setSeats(): void {
    this.data.seats.forEach((seat, i) => this._cards[i]?.set(seat, seat.id !== '' && seat.id === this._kickId));
  }

  /** The start area and its status line live in one box that redraws as readiness changes. */
  private _footAt(x: number, y: number): void {
    this.begin();
    this._foot = new Container();
    this._foot.position.set(x, y);
    this.target.addChild(this._foot);
    void this._drawFoot();
  }

  private _drawFoot(): Promise<void> {
    const foot = this._foot;

    if (!foot || foot.destroyed) return Promise.resolve();
    this._footButtons = [];
    this._armMeter = null;
    this._status = null;
    this._start = null;

    return this._redraw(foot, () => this._drawFootInto(foot.y));
  }

  /** Draws the foot's controls and status line from its top-left; `footY` is where that sits in the box. */
  private _drawFootInto(footY: number): void {
    const { k, W, S } = this;
    const { role, hostName, waitingFor } = this.data;
    const land = k === 'l' ? this._landSeats() : null;
    const phoneW = land ? land.w : W - S.l - S.r;
    const phoneH = land ? LAND_FOOT_H : 64;
    const you = this.data.seats.find((s) => s.isYou);
    const a = this.host.actions;
    const armed = this._armedUntil > performance.now();
    const keep = (b: Button): Button => {
      this._footButtons.push(b);

      return b;
    };
    const kicking = this._kickId ? this.data.seats.find((s) => s.id === this._kickId) : null;
    const waitList = listNames(waitingFor);
    const seated = this.data.seats.filter((s) => s.kind !== 'open').length;
    const statusCopy = kicking
      ? [`Removing ${kicking.name} frees their seat for a bot or a friend.`, COLORS.mist]
      : armed
        ? [this._armedLine(k === 'd' ? Math.ceil((this._armedUntil - performance.now()) / 1000) : 0), COLORS.amber]
        : waitingFor.length
          ? [`Waiting for ${waitList}. Press Start twice to go without them.`, COLORS.mist]
          : seated <= 1
            ? ['Just you so far. Share the code, or add a bot.', COLORS.mist]
            : ['Everyone is ready.', COLORS.go];
    const overScene = k !== 'd';
    const statusColor = (c: string): string => (overScene && c === COLORS.mist ? WHITE80 : c);

    if (role === 'guest') {
      const ready = !!you?.ready;
      const label = ready ? 'Not ready' : 'Ready';
      const toggle = (): void => a.setReady(!ready);
      const bw = k === 'd' ? 300 : phoneW;
      const bh = k === 'd' ? DESK_FOOT_H : phoneH;

      keep(this.button(label, 0, 0, bw, bh, ready ? 'secondary' : 'go', ready ? 'close' : 'check', toggle, true));
      if (k === 'd') {
        keep(this.button('Leave party', 330, 0, 230, bh, 'secondary', 'exit', () => void this.back()));
        this._status = this.text(`${hostName} starts the race when everyone is ready.`, 0, bh + 18, {
          s: 15,
          c: WHITE80,
          glow: true,
        });
      }
    } else if (role === 'spectator') {
      const bw = k === 'd' ? 300 : phoneW;
      const leave = (): void => void this.back();

      keep(this.button('Leave party', 0, 0, bw, k === 'd' ? DESK_FOOT_H : phoneH, 'secondary', 'exit', leave, true));
    } else {
      const w = k === 'd' ? 340 : phoneW;
      const h = k === 'd' ? DESK_FOOT_H : phoneH;
      const start = (): void => this.pressStart();
      const meterY = k === 'd' ? h + 12 : k === 'p' ? -20 : -14;

      if (armed) {
        this._start = keep(this.button('Start anyway', 0, 0, w, h, 'caution', 'flag', start, true));
        this._armMeter = this.meter(14, meterY, w - 28, 8, 1, COLORS.amber);
      } else if (waitingFor.length) {
        this._start = keep(this.button('Start race', 0, 0, w, h, 'secondary', 'flag', start, !kicking));
      } else this._start = keep(this.button('Start race', 0, 0, w, h, 'go', 'flag', start, !kicking));
      const [copy, color] = statusCopy;

      if (k === 'd') {
        // Beside Start, on a plate of its own so the scene behind never fights the words; its lit bar says the state
        const px = w + 16;
        const pw = DESK_SEATS_W - px;
        const lit = color === COLORS.mist ? undefined : color;

        this.panel(px, 0, pw, h, { tone: 'hud', chamfer: 10, accent: lit });
        this._status = this.text(copy, px + 14, 0, { s: 14, c: color, wrap: pw - 26, lh: 1.25 });
        this._status.y = (h - this._status.height) / 2 + 2;
      } else {
        // Centred in the band between the seats and Start, or between the seats and the meter while it runs.
        const mid = (this._seatsBottom - footY + (armed ? meterY : 0)) / 2;

        this._status = this.text(copy, w / 2, 0, {
          s: k === 'p' ? 14 : 13,
          c: statusColor(color),
          a: 'c',
          wrap: w,
          lh: 1.25,
          glow: true,
        });
        this._status.y = mid - this._status.height / 2;
      }
      this.middled(this._status);
    }
  }

  /**
   * Draws a new version of `box`'s contents beside what shows, and swaps them once the new art is up, so a control
   * changing look (Ready to Not ready, Start race going green) never shows a frame without its plate.
   */
  private _redraw(box: Container, draw: () => void): Promise<void> {
    const showing: Container[] = [];
    const current = this.focus.current;
    let held = false;

    for (const child of box.removeChildren()) {
      for (const b of buttonsIn(child)) {
        held ||= b === current;
        this.focus.remove(b);
      }
      if (child.visible) {
        child.eventMode = 'none';
        showing.push(child);
      } else child.destroy({ children: true });
    }
    const layer = new Container();

    box.addChild(...showing, layer);
    layer.visible = showing.length === 0;
    const prev = this.target;

    this.into(layer);
    draw();
    this.into(prev);
    const loads = buttonsIn(layer).map((b) => b.loaded);

    if (this._armMeter) loads.push(this._armMeter.loaded);

    return Promise.race([Promise.all(loads), sleep(SWAP_WAIT_MS)]).then(() => {
      if (layer.destroyed) return;
      layer.visible = true;
      for (const n of showing) if (!n.destroyed) n.destroy({ children: true });
      // Keys were on a control that redrew (Copy invite link, Ready): they stay on its new version.
      if (this.host.kit.keys && !this.focus.current?.focusable) {
        this.focus.focus(held ? (buttonsIn(layer).find((b) => b.focusable) ?? null) : null);
      }
    });
  }

  /** Everyone is ready: a hop runs down the seats, Start race drops into place green, a glint crosses it. */
  private _allReady(): void {
    const b = this._start;

    this.host.kit.sound.play('confirm');
    if (this.motion.reduced) return;
    this._cards.forEach((card, i) => {
      const y = card.node.y;

      this.motion
        .timeline({ delay: i * 0.05 })
        .to(card.node, { y: y - 7, duration: 0.1, ease: 'power2.out' })
        .to(card.node, { y, duration: 0.32, ease: 'back.out(3)' });
    });
    if (!b || b.destroyed) return;
    const y = b.y;

    this.motion.fromTo(b, { y: y - 14 }, { y, ...MOTION.slot });
    this.motion.fromTo(b.scale, { x: 1.08, y: 1.08 }, { x: 1, y: 1, ...MOTION.slot });
    this.motion.delay(0.12, () => {
      if (!b.destroyed) b.sweep();
    });
    if (this._status) this.motion.punch(this._status.scale, 1.25, 0.45);
  }

  /** Who isn't ready while Start anyway is armed, and how long it stays armed (`seconds` 0 leaves the time out). */
  private _armedLine(seconds: number): string {
    const waiting = this.data.waitingFor;
    const names = `${listNames(waiting)} ${waiting.length > 1 ? "aren't" : "isn't"} ready.`;

    return seconds > 0 ? `${names} Press again in ${seconds} s to go anyway.` : `${names} Press again to start anyway.`;
  }

  /** Start: goes when everyone is ready, otherwise arms Start anyway for 3 s; a second press forces it. */
  public pressStart(): void {
    const a = this.host.actions;

    if (!this.data.waitingFor.length) {
      this.host.kit.sound.play('confirm');
      a.start(false);

      return;
    }
    if (this._armedUntil > performance.now()) {
      this.host.kit.sound.play('arm');
      this._armedUntil = 0;
      a.start(true);
      void this._drawFoot();

      return;
    }
    this._armedUntil = performance.now() + ARM_MS;
    this.host.kit.sound.play('arm');
    void this._drawFoot();
    let shown = -1;
    const stop = this.motion.tick(() => {
      const left = this._armedUntil - performance.now();

      if (left <= 0) {
        stop();
        this._armedUntil = 0;
        void this._drawFoot();

        return;
      }
      this._armMeter?.set(left / ARM_MS);
      const s = Math.ceil(left / 1000);

      if (s !== shown && this._status && this.k === 'd') {
        shown = s;
        this._status.text = this._armedLine(s);
      }
    });
  }

  /** The copy-invite control: a button on desktop, the share icon by the plate on a phone either way up. */
  private _drawShare(slot = false): void {
    const box = this._share;

    if (!box || box.destroyed) return;
    void this._redraw(box, () => this._drawShareInto()).then(() => {
      const b = box.destroyed ? null : buttonsIn(box)[0];

      if (!slot || !b || this.motion.reduced) return;
      this.motion.fromTo(b, { y: b.y - 10, alpha: 0 }, { y: b.y, alpha: 1, ...MOTION.slot });
    });
  }

  private _drawShareInto(): void {
    const copied = this._copied;
    const shared = copied && this._sent === 'shared';
    // On touch the button opens the share sheet, so it says share; elsewhere it copies.
    const shares = this.host.kit.touch && typeof navigator.share === 'function';
    const copy = (): void => this.copyInvite();

    if (this.k !== 'd') {
      this.iconBtn(copied ? 'check' : shares ? 'share' : 'copy', 0, 0, 50, copied ? 'go' : 'primary', copy);

      return;
    }
    this.button(
      shared ? 'Link shared' : copied ? 'Link copied' : shares ? 'Share invite link' : 'Copy invite link',
      0,
      0,
      330,
      52,
      copied ? 'go' : 'secondary',
      copied ? 'check' : shares ? 'share' : 'link',
      copy,
    );
  }

  /**
   * Sends the invite (the share sheet on touch, else the clipboard): the plate turns green and glints, the button says
   * what happened, and the toast confirms it, with a reminder to keep the page open after a share.
   */
  public copyInvite(): void {
    const a = this.host.actions;
    const send = a.shareInvite ? a.shareInvite() : a.copyInvite().then(() => 'copied' as const);

    send.then(
      (how) => {
        if (this.destroyed) return;
        this._sent = how;
        this._copiedUntil = performance.now() + COPIED_MS;
        this.host.kit.sound.play('copySnap');
        this._plate?.setState('copied');
        if (this._plate) this.motion.punch(this._plate.node.scale, 1.06, 0.45);
        this._drawShare();
        if (this._plate) this._glint(this._plate.f.x, this._plate.f.y, this._plate.f.w, this._plate.f.h);
        this.host.toast(how === 'shared' ? { kind: 'shared' } : { kind: 'linkCopied' });
        this._armCopiedReset();
      },
      () => {
        if (this.destroyed) return;
        this.host.kit.sound.play('error');
        this.host.toast({ kind: 'notice', text: "Couldn't copy. Read the code out instead." });
      },
    );
  }

  /** Turns the plate and the copy control back to idle when the copied look runs out; a rebuild arms it again. */
  private _armCopiedReset(): void {
    const left = Math.max(0, this._copiedUntil - performance.now());

    this.motion.delay(left / 1000, () => {
      this._copiedUntil = 0;
      this._plate?.setState('idle');
      if (this._plate) this.motion.punch(this._plate.node.scale, 1.04, 0.35);
      this._drawShare(true);
    });
  }

  /** The light sweep across the plate. */
  private _glint(x: number, y: number, w: number, h: number): void {
    if (this.motion.reduced || !this._plate) return;
    const parent = this._plate.sprite.parent;

    if (!parent) return;
    const glint = new ArtSprite(this.host.kit.textures, glintSvg(h), this.L.density);
    const mask = new Graphics().rect(x, y, w, h).fill(0xffffff);

    glint.blendMode = 'add';
    glint.mask = mask;
    glint.y = y;
    parent.addChild(mask, glint);
    this.motion.fromTo(
      glint,
      { x: x - h * 0.6 },
      {
        x: x + w,
        ...MOTION.sweep,
        onComplete: () => {
          glint.destroy();
          mask.destroy();
        },
      },
    );
  }
}
