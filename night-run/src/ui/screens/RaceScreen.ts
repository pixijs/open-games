import type { Screen } from '../contract';
import { ScreenView } from './ScreenView';

type RaceData = Extract<Screen, { id: 'race' }>;

/** The race itself: nothing of its own, the HUD (owned by the shell) shows through. */
export class RaceScreen extends ScreenView<RaceData> {
  protected override build(): void {}

  public override async enter(_delay = 0): Promise<void> {
    this.root.visible = true;
  }

  public override exit(): Promise<void> {
    return Promise.resolve();
  }
}
