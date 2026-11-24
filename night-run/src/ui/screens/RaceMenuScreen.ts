import type { ButtonVariant } from '../art/buttons';
import type { IconName } from '../art/icons';
import { COLORS } from '../art/tokens';
import type { Screen } from '../contract';
import type { Button } from '../kit/Button';
import { MenuScreen } from './MenuScreen';

type PauseData = Extract<Screen, { id: 'pause' }>;

interface MenuItem {
  readonly label: string;
  readonly variant: ButtonVariant;
  readonly icon: IconName;
  readonly onPress: () => void;
}

/** How tall {@link MenuScreen.settingRow} draws, so the Sound row centres in a button's slot or on the title's line. */
const SOUND_ROW = 34;

/** `list` two to a row, in order. */
function pairs<T>(list: readonly T[]): T[][] {
  const rows: T[][] = [];

  for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2));

  return rows;
}

/**
 * The race menu. Online the race keeps going behind it (host: End race for everyone, which asks once; guest: Leave
 * race); solo it really pauses (Resume, Restart race, Quit to title). Every role gets Back on track and the Sound
 * switch.
 */
export class RaceMenuScreen extends MenuScreen<PauseData> {
  private _confirmEnd = false;
  private _end: Button | null = null;

  protected override build(): void {
    this._end = null;
    if (this._confirmEnd) {
      this._buildEndConfirm();

      return;
    }
    const { k, W, H } = this;
    const role = this.data.role;
    const solo = role === 'solo';
    const a = this.host.actions;
    const resume: MenuItem = {
      label: solo ? 'Resume' : 'Back to the race',
      variant: 'primary',
      icon: 'play',
      onPress: () => a.resume(),
    };
    const respawn: MenuItem = {
      label: 'Back on track',
      variant: 'secondary',
      icon: 'respawn',
      onPress: () => {
        a.respawn();
        a.resume();
      },
    };
    const leave = (): void =>
      this.host.showLocal({
        id: 'leaveConfirm',
        role,
        hostName: this.host.memory.lobby?.hostName ?? '',
        others: (this.host.memory.lobby?.seats ?? []).filter((s) => !s.isYou && s.kind === 'player').map((s) => s.name),
      });
    const edit: MenuItem[] = this.data.editable
      ? [
          {
            label: 'Edit track',
            variant: 'secondary',
            icon: 'edit',
            onPress: () => a.editTrack(this.data.trackId ?? ''),
          },
        ]
      : [];
    const items: (MenuItem | 'sound')[] = solo
      ? [
          resume,
          respawn,
          { label: 'Restart race', variant: 'secondary', icon: 'rematch', onPress: () => a.restart() },
          ...edit,
          'sound',
          { label: 'Quit to title', variant: 'secondary', icon: 'exit', onPress: () => a.leave() },
        ]
      : role === 'host'
        ? [
            resume,
            respawn,
            'sound',
            {
              label: 'End race for everyone',
              variant: 'caution',
              icon: 'flag',
              onPress: () => {
                this._confirmEnd = true;
                this.host.kit.sound.play('arm');
                this.rebuild();
              },
            },
            { label: 'Leave party', variant: 'danger', icon: 'exit', onPress: leave },
          ]
        : [resume, respawn, 'sound', { label: 'Leave race', variant: 'danger', icon: 'exit', onPress: leave }];
    const note = solo ? 'Paused. The race is stopped.' : 'The race keeps going while this is open.';
    const bh = k === 'l' ? 44 : 52;
    const gap = 12;
    const pad = 30;
    const top = k === 'd' ? 120 : k === 'l' ? 98 : 110;
    const titleS = k === 'd' ? 40 : k === 'l' ? 28 : 32;
    const w = k === 'd' ? 440 : k === 'p' ? W - 40 : 520;
    // Landscape is too short for a column of six: the buttons pair up in reading order (a last odd one spans the
    // row) and Sound moves up beside the title.
    const rows: (MenuItem | 'sound')[][] =
      k === 'l' ? pairs(items.filter((it) => it !== 'sound')) : items.map((it) => [it]);
    const h = top + rows.length * (bh + gap) - gap + pad;
    const x = (W - w) / 2;
    const y = (H - h) / 2;

    this.begin(true);
    this.dim(0.66);
    this.begin();
    const p = this.panel(x, y, w, h, { accent: COLORS.cyan });

    this.title(solo ? 'Paused' : 'Race menu', p.c.x + pad, p.c.y + 26, titleS);
    this.text(note, p.c.x + pad, p.c.y + (k === 'd' ? 80 : k === 'l' ? 62 : 70), { s: 15, c: COLORS.mist });
    const sound = (): boolean => this.host.memory.sound;
    const toggle = (): void => this.host.setSound(!this.host.memory.sound);
    const draw = (it: MenuItem | 'sound', bx: number, by: number, bw: number): void => {
      if (it === 'sound') this.settingRow(bx, by + (bh - SOUND_ROW) / 2, bw, 'Sound', sound, toggle);
      else {
        const b = this.button(it.label, bx, by, bw, bh, it.variant, it.icon, it.onPress, it === resume);

        if (it.variant === 'caution') this._end = b;
      }
    };

    rows.forEach((row, r) => {
      const bw = (w - pad * 2 - gap * (row.length - 1)) / row.length;

      row.forEach((it, c) => draw(it, p.c.x + pad + c * (bw + gap), p.c.y + top + r * (bh + gap), bw));
    });
    if (k === 'l') {
      this.settingRow(p.c.x + w - pad - 200, p.c.y + 26 + (titleS - SOUND_ROW) / 2, 200, 'Sound', sound, toggle);
    }
  }

  public override back(): boolean {
    if (this._confirmEnd) {
      this._confirmEnd = false;
      this.host.kit.sound.play('back');
      this.rebuild();
      if (this.host.kit.keys && this._end) this.focus.focus(this._end);

      return true;
    }
    this.host.actions.resume();

    return true;
  }

  private _buildEndConfirm(): void {
    this.sheetDialog({
      accent: COLORS.amber,
      icon: 'flag',
      title: 'End the race now?',
      body: 'Everyone goes to the results with the places as they stand.',
      buttons: [
        { label: 'End race', variant: 'caution', icon: 'flag', onPress: () => this.host.actions.endRace() },
        { label: 'Keep racing', variant: 'secondary', onPress: () => this.back(), isDefault: true },
      ],
      h: 230,
      hp: 316,
      hl: 216,
    });
  }
}
