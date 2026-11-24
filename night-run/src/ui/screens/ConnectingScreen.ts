import type { Screen } from '../contract';
import { ConnectionScreen } from './ConnectionScreen';

type ConnectingData = Extract<Screen, { id: 'connecting' }>;

/** Joining a code: the spinner while the host's tab answers, and Cancel. */
export class ConnectingScreen extends ConnectionScreen<ConnectingData> {
  protected override build(): void {
    this.drawConnection('join', this.data.code, 0.55);
  }

  public override back(): boolean {
    this.host.actions.leave();

    return true;
  }
}
