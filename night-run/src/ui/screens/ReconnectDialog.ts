import type { Screen } from '../contract';
import type { HeldParts } from './ConnectionScreen';
import { ConnectionScreen } from './ConnectionScreen';
import type { ScreenHost } from './ScreenHost';

type ClosedData = Extract<Screen, { id: 'closed' }>;

const HELD_MS = 20000;

/**
 * The reconnecting dialog over whatever shows: the amber spinner, the seconds the seat is still held and a meter
 * draining to `heldUntil`. At zero it swaps to Couldn't reconnect, with Rejoin and Back to title.
 */
export class ReconnectDialog extends ConnectionScreen<ClosedData> {
  private _heldUntil: number;
  private _lost = false;
  private _shown = -1;

  constructor(host: ScreenHost, heldUntil: number) {
    super(host, { id: 'closed', reason: 'lost', hostName: '' });
    this._heldUntil = heldUntil;
  }

  public setHeld(heldUntil: number): void {
    this._heldUntil = heldUntil;
    if (this._lost && heldUntil > performance.now()) {
      this._lost = false;
      this.rebuild();
    }
  }

  protected override entered(): void {
    this.host.kit.sound.play('warn');
  }

  public override rebuild(): void {
    super.rebuild();
    // The seat ran out: the panel jolts and the lost icon lands.
    const panel = this.heroIcon?.parent;

    if (!this._lost || !panel) return;
    this.punchHero(0.05);
    this.motion.shake(panel, 5, 0.28, 2);
  }

  protected override build(): void {
    this._shown = -1;
    const parts = this.drawConnection(this._lost ? 'lost' : 'reconnect', '', 0.62);

    if (parts) this.motion.tick(() => this._tickHeld(parts));
  }

  private _tickHeld(parts: HeldParts): void {
    const left = Math.max(0, this._heldUntil - performance.now());
    const secs = Math.ceil(left / 1000);

    parts.meter.set(left / HELD_MS);
    if (secs !== this._shown) {
      this._shown = secs;
      parts.seconds.text = String(secs);
      parts.body.text = `Reconnecting. Your seat is held for ${secs} more second${secs === 1 ? '' : 's'}.`;
      if (secs <= 5) {
        this.motion.punch(parts.seconds.scale, 1.35);
        this.host.kit.sound.play('tick');
      }
    }
    if (left <= 0 && !this._lost) {
      this._lost = true;
      this.host.kit.sound.play('error');
      this.motion.delay(0, () => this.rebuild());
    }
  }
}
