import type { ButtonState, ButtonVariant } from '../art/buttons';
import { BUTTON_TEXT, buttonSvg, iconButtonSvg, keySvg, switchSvg } from '../art/buttons';
import type { IconName } from '../art/icons';
import { iconSvg } from '../art/icons';
import { chamferRect, leanShift, slantRect } from '../art/svg';
import type { RacerColor } from '../art/tokens';
import { COLORS } from '../art/tokens';
import type { SwatchState } from '../art/truck';
import { truckSwatchSvg } from '../art/truck';
import { Button } from './Button';
import type { UiKit } from './kit';

/** A text button `w` by `h` (face px) with an optional icon before the label. */
export function textButton(
  kit: UiKit,
  label: string,
  w: number,
  h: number,
  variant: ButtonVariant,
  icon: IconName | null,
  onPress: () => void,
): Button {
  const pad = Math.round(h * 0.35);
  const color = BUTTON_TEXT[variant];

  return new Button(kit, {
    art: (state) => buttonSvg({ width: w, height: h, variant, state }),
    outline: slantRect(pad, pad, w, h, 12, h * 0.14),
    label,
    text: { s: Math.round(h * 0.36), w: 700, i: true, c: color, flat: variant !== 'secondary' },
    icon: icon
      ? (enabled) => {
          const c = enabled ? color : COLORS.mist;

          return iconSvg(icon, {
            size: Math.round(h * 0.4),
            color: c,
            accent: variant === 'secondary' && enabled ? COLORS.cyan : c,
            keyline: variant === 'secondary',
          });
        }
      : undefined,
    onPress,
  });
}

/** A square leaning icon button, its face `h` tall. */
export function iconButton(kit: UiKit, icon: IconName, h: number, variant: ButtonVariant, onPress: () => void): Button {
  const pad = Math.round(h * 0.35);

  return new Button(kit, {
    art: (state) => iconButtonSvg(icon, { height: h, variant, state }),
    name: icon,
    outline: slantRect(pad, pad, h + leanShift(h, 12), h, 12, h * 0.16),
    onPress,
  });
}

/** An upright keypad key with a letter, an icon or a word on it. */
export function keyButton(
  kit: UiKit,
  w: number,
  h: number,
  variant: 'char' | 'action' | 'go',
  content: { label?: string; icon?: IconName; size: number; board?: boolean },
  onPress: () => void,
): Button {
  const go = variant === 'go';

  return new Button(kit, {
    art: (state) =>
      keySvg({ width: w, height: h, variant, state: state === 'hover' || state === 'focus' ? 'idle' : state }),
    outline: chamferRect(8, 8, w, h, 7),
    label: content.label,
    name: content.icon,
    text: content.board
      ? { f: 'b', s: content.size, w: 800 }
      : { s: content.size, w: go ? 700 : 600, i: true, c: go ? COLORS.ink900 : COLORS.white, flat: go },
    icon: content.icon
      ? () => iconSvg(content.icon!, { size: content.size, color: COLORS.white, accent: COLORS.ink800 })
      : undefined,
    glint: false,
    lift: 0,
    ring: 4,
    onPress,
  });
}

/** A truck-colour swatch; `mode` says whether it's yours or taken, read every time the button refreshes. */
export function swatchButton(
  kit: UiKit,
  color: RacerColor,
  size: number,
  mode: () => 'selected' | 'taken' | null,
  onPress: () => void,
): Button {
  const pad = Math.round(size * 0.22);
  const w = Math.round(size * 1.3);

  return new Button(kit, {
    art: (state: ButtonState) => {
      const m = mode();
      const s: SwatchState = m && state !== 'press' ? m : m === 'taken' ? 'taken' : state;

      return truckSwatchSvg(color, s, size);
    },
    outline: slantRect(pad, pad, w, size, 12, size * 0.12),
    name: color.name,
    glint: false,
    lift: 3,
    onPress,
  });
}

/** The Sound switch for settings rows. */
export function switchButton(kit: UiKit, h: number, on: () => boolean, onPress: () => void): Button {
  const pad = Math.round(h * 0.4);

  return new Button(kit, {
    art: (state) => switchSvg(on(), { height: h, state }),
    outline: slantRect(pad, pad, Math.round(h * 2), h, 12, h * 0.16),
    name: 'switch',
    glint: false,
    lift: 0,
    ring: 4,
    onPress,
  });
}
