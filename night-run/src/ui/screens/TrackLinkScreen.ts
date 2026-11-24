import { leanShift } from '../art/svg';
import type { Screen } from '../contract';
import { MenuScreen } from './MenuScreen';

type LinkData = Extract<Screen, { id: 'trackLink' }>;

/**
 * A shared track's link, landed on: who shared it, then its pit board as My tracks shows it (its plan, name, length,
 * lap and your best, with its buttons on it; side by side on a phone held sideways) over the attract race already
 * running on it. Race it keeps it in My tracks "from" whoever shared
 * it and races it; Edit a copy keeps it and opens the editor (Edit, once it's in My tracks, opens that one); Save keeps
 * it; back is Not now, to the title.
 */
export class TrackLinkScreen extends MenuScreen<LinkData> {
  public override back(): boolean {
    this.host.kit.sound.play('back');
    this.host.actions.closeTracks();

    return true;
  }

  protected override build(): void {
    const { k, W, H, S } = this;
    const { card, from } = this.data;

    this.begin(true);
    if (k === 'p') {
      this.scrim('bottom', 0.95, 0.75);
      this.scrim('top', 0.85, 0.4);
    } else {
      this.scrim('left', 0.94, 0.7);
    }

    const tx = S.l + 44 + leanShift(44, 12) + 16;

    this.begin();
    const back = this.iconBtn('back', S.l, S.t, 44, 'secondary', () => void this.back());

    this.explain(back, 'Not now', ['Esc']);
    this.text(from ? `${from} shared a track` : 'A shared track', tx, S.t + 2, {
      f: 'b',
      s: k === 'd' ? 40 : 28,
      w: 900,
      max: W - S.r - tx,
    });

    const raceH = k === 'd' ? 60 : 52;
    const rowH = k === 'd' ? 48 : 44;
    const gap = k === 'l' ? 8 : 10;
    const top = S.t + (k === 'd' ? 68 : 56);
    const sub = card.builtIn
      ? 'The original circuit'
      : `${card.feel}, ${card.corners} ${card.corners === 1 ? 'corner' : 'corners'}`;

    this.begin();
    this.trackBoard(
      card,
      { x: S.l, y: top, w: k === 'd' ? 480 : W - S.l - S.r, h: H - S.b - top },
      {
        sub,
        row: k === 'l',
        actionsH: raceH + gap + rowH,
        actions: (x, y, aw) => this._buttons(x, y, aw, raceH, rowH, gap),
      },
    );
  }

  /** Race it, then Edit a copy (Edit once it's in My tracks) and Save side by side under it. */
  private _buttons(x: number, y: number, w: number, raceH: number, rowH: number, gap: number): void {
    const { card, saved } = this.data;
    const a = this.host.actions;
    const keep = (): string | null => a.saveSharedTrack();
    const half = (w - gap) / 2;

    this.button(
      'Race it',
      x,
      y,
      w,
      raceH,
      'go',
      'play',
      () => {
        const id = keep();

        if (id) a.raceTrack(id, true);
      },
      true,
    );
    // A track already in My tracks opens there; any other is kept as a copy first.
    this.button(
      saved && !card.builtIn ? 'Edit' : 'Edit a copy',
      x,
      y + raceH + gap,
      half,
      rowH,
      'secondary',
      'edit',
      () => {
        const id = keep();

        if (id) a.editTrack(id);
      },
    );

    const save = this.button(
      saved ? 'Saved' : 'Save',
      x + half + gap,
      y + raceH + gap,
      half,
      rowH,
      'secondary',
      saved ? 'check' : 'plus',
      () => {
        if (keep()) this.host.toast({ kind: 'notice', text: 'Saved to My tracks.' });
      },
    );

    save.setDisabled(saved);
  }
}
