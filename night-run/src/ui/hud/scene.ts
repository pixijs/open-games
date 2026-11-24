import type { UiSound } from '../contract';
import type { GlyphFont } from './GlyphFont';
import type { CalloutSizes } from './hudArt';
import type { HudAtlas } from './HudAtlas';
import type { HudMotion } from './HudMotion';
import type { HudBox, HudSpec } from './layout';

/** What every HUD part lays itself out from: the layout, its sizes, its atlases and the readout fonts */
export interface HudScene {
  readonly box: HudBox;
  readonly spec: HudSpec;
  readonly sizes: CalloutSizes;
  readonly hud: HudAtlas<string>;
  readonly callouts: HudAtlas<string>;
  /** Only while the race is starting */
  readonly start: HudAtlas<string> | null;
  readonly heavy: GlyphFont;
  readonly light: GlyphFont;
  /** Touch controls show */
  readonly touch: boolean;
}

/** Services the parts share for the HUD's life */
export interface HudServices {
  readonly motion: HudMotion;
  readonly sound: UiSound;
}
