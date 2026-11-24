import { CanvasTextMetrics, TextStyle } from 'pixi.js';

import { COLORS } from '../art/tokens';
import type { Screen } from '../contract';
import { textStyle } from '../kit/text';
import { MenuScreen } from './MenuScreen';

type LeaveData = Extract<Screen, { id: 'leaveConfirm' }>;

/** "Jun", "Jun and Sam", "Jun, Sam and Ana". */
export function listNames(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? '';

  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Leave confirm: as host it says who the party ends for; as a guest it says the code still works. The danger button
 * sits above Stay on a phone, never alone at the bottom.
 */
export class LeaveScreen extends MenuScreen<LeaveData> {
  protected override build(): void {
    const { role, hostName, others } = this.data;
    const host = role === 'host';
    const inRace = this.host.memory.racing;
    const what = inRace ? 'race' : 'party';
    const body = host
      ? others.length
        ? `You're the host: leaving ends the party for ${listNames(others)} too.`
        : "You're the host: leaving ends the party."
      : role === 'spectator' && !inRace
        ? `You'll stop watching ${hostName}'s party. You can join again with the code while it's open.`
        : `You'll leave ${hostName}'s party. You can join again with the code while it's open.`;
    const stay = (): void => this._stay();
    const more = this._moreLines(body);

    this.sheetDialog({
      accent: COLORS.danger,
      title: `Leave the ${what}?`,
      body,
      buttons: [
        {
          label: host ? 'End party' : 'Leave',
          variant: 'danger',
          icon: 'exit',
          onPress: () => this.host.actions.leave(),
        },
        {
          label: this.k === 'p' ? `Stay in the ${what}` : 'Stay',
          variant: 'secondary',
          onPress: stay,
          isDefault: true,
        },
      ],
      h: 230 + more,
      hp: 296 + more,
      hl: 196 + more,
    });
  }

  /**
   * How much taller than a one-line body the sheet's body runs: the host's line grows with the names in the party, so
   * the sheet measures it to keep the gap above the buttons the same as the end-race confirm's.
   */
  private _moreLines(body: string): number {
    const { k, W } = this;
    const s = k === 'd' ? 16 : 15;
    const wrap = (k === 'd' ? 500 : k === 'p' ? W - 40 : 440) - 60;
    const style = new TextStyle(textStyle({ s, lh: 1.35, wrap }));

    return (CanvasTextMetrics.measureText(body, style).lines.length - 1) * Math.round(s * 1.35);
  }

  public override back(): boolean {
    this._stay();

    return true;
  }

  private _stay(): void {
    this.host.kit.sound.play('back');
    if (!this.host.backLocal()) this.host.actions.resume();
  }
}
