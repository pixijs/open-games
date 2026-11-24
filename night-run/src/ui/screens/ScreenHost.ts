import type { Container } from 'pixi.js';

import type { CarColor, Role, Screen, UiActions } from '../contract';
import type { UiKit } from '../kit/kit';
import type { MenuToast } from '../kit/ToastStack';

export type LobbyData = Extract<Screen, { id: 'lobby' }>;

/** What the UI remembers across screens: what the game last said, for screens the UI opens itself. */
export interface UiMemory {
  name: string;
  sound: boolean;
  car: CarColor;
  /** Laps in the party's (or the last) race */
  laps: number;
  /** The last lobby the game showed: the select sheet and the leave confirm read it */
  lobby: LobbyData | null;
  /** The role in the current party or race */
  role: Role;
  /** A race (or its menu) is on, so the HUD stays and race sounds rule */
  racing: boolean;
  /** The title as the game last showed it, for the screens that go back to it themselves */
  title: Extract<Screen, { id: 'title' }> | null;
}

/** What a screen may ask of the shell (`GameUI`). */
export interface ScreenHost {
  readonly kit: UiKit;
  readonly actions: UiActions;
  readonly memory: UiMemory;
  /** Shows a screen the UI opens itself (join from the title, select from the lobby, a leave confirm) */
  showLocal(screen: Screen, replace?: boolean): void;
  /** Joins a code; a failure opens the join entry with the error, whatever shows by then */
  join(code: string): void;
  /** Opens the truck picker over the lobby */
  openSelect(): void;
  /** Back to the screen before the one the UI opened itself; false when there's none */
  backLocal(): boolean;
  /** The title as the game last described it, with the name and sound as they are now */
  titleScreen(): Extract<Screen, { id: 'title' }>;
  toast(toast: MenuToast): void;
  /** Sound on or off: the game's master gain and the UI's own mute */
  setSound(on: boolean): void;
  /** A white flash over everything, for a repaint or a pick */
  flash(alpha: number, duration: number): void;
  /** The layer over the screens (box px), where confetti flies */
  readonly fx: Container;
  /** Throws confetti from `x`, `y` in `fx`; the shell owns it, so it outlives the screen that threw it */
  confetti(x: number, y: number, color: string, count?: number, spread?: number): void;
}
