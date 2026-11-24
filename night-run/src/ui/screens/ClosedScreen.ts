import { COLORS } from '../art/tokens';
import type { Screen } from '../contract';
import { ConnectionScreen } from './ConnectionScreen';

type ClosedData = Extract<Screen, { id: 'closed' }>;

/** The party ended for you: the host left, the host removed you, or your seat was lost (with Rejoin). */
export class ClosedScreen extends ConnectionScreen<ClosedData> {
  protected override build(): void {
    const { reason, hostName } = this.data;
    const leave = (): void => this.host.actions.leave();

    if (reason === 'lost') {
      this.drawConnection('lost', '', 0.62);

      return;
    }
    const kicked = reason === 'kicked';

    this.sheetDialog({
      accent: COLORS.danger,
      icon: kicked ? 'leave' : 'exit',
      title: kicked ? `${hostName} removed you` : 'The party is over',
      body: kicked
        ? `You're out of ${hostName}'s party. If that was a mistake, ask ${hostName} for the code and join again.`
        : `${hostName}, the host, left. Their tab ran the race, so it can't go on without them.`,
      buttons: [{ label: 'Back to title', variant: 'primary', icon: 'back', onPress: leave, isDefault: true }],
      dim: kicked ? 0.66 : 0.72,
      h: 254,
      hp: kicked ? 270 : 250,
      hl: kicked ? 240 : 230,
    });
  }

  /** The bad news lands: the icon punches in with its sound, and being removed jolts the panel. */
  protected override entered(): void {
    const reason = this.data.reason;

    this.punchHero(0.12);
    this.motion.delay(0.12, () => this.host.kit.sound.play(reason === 'lost' ? 'error' : 'leave'));
    const panel = this.heroIcon?.parent;

    if (reason === 'kicked' && panel) this.motion.delay(0.16, () => this.motion.shake(panel, 5, 0.28, 2));
  }

  public override back(): boolean {
    this.host.actions.leave();

    return true;
  }
}
