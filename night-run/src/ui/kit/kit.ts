import type { Container } from 'pixi.js';

import type { SvgTextures } from '../art/svgTexture';
import type { UiSound } from '../contract';
import type { UiLayout } from './layout';

/** What every screen and widget reads from the shell: the shared textures, the UI sound, the layout and the input. */
export interface UiKit {
  readonly textures: SvgTextures;
  readonly sound: UiSound;
  readonly layout: UiLayout;
  /** The last input was a key or a gamepad: focus rings show and prompts name keys */
  readonly keys: boolean;
  /** The device has touch, or touch drove last */
  readonly touch: boolean;
}

/** Something keys and a gamepad can focus and press. */
export interface Focusable {
  readonly node: Container;
  /** Can take focus now (enabled and on screen) */
  readonly focusable: boolean;
  setFocused(on: boolean): void;
  /** Pressed by Enter, Space or the A button */
  activate(): void;
}
