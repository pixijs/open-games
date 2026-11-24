import type { Text } from 'pixi.js';

import { iconSvg } from '../art/icons';
import { spinnerSvg } from '../art/motifs';
import { COLORS } from '../art/tokens';
import type { Screen } from '../contract';
import type { Meter } from '../kit/Meter';
import { balancedWrap, lineCount } from '../kit/text';
import { MenuScreen } from './MenuScreen';

/** The three moments of a connection: joining a code, a seat held while reconnecting, and the seat lost. */
export type ConnectionState = 'join' | 'reconnect' | 'lost';

/** What the reconnect state hands back so its countdown can tick. */
export interface HeldParts {
  readonly seconds: Text;
  readonly body: Text;
  readonly meter: Meter;
}

/** The panel's padding under its buttons, as every menu dialog keeps it. */
const FOOT = 30;

/**
 * The connection panel the connecting screen, the reconnecting dialog and the lost screen share: the spinner (or the
 * lost icon), the title, the copy, the reconnect meter and the buttons, stacked down the middle with the panel as tall
 * as they need. Its words say where you are: a race to leave or watch, or a party to get back into.
 */
export abstract class ConnectionScreen<D extends Screen> extends MenuScreen<D> {
  /** Draws the panel for `state`; returns the reconnect countdown's parts in the reconnect state. */
  protected drawConnection(state: ConnectionState, code: string, dim: number): HeldParts | null {
    const { k, W, H } = this;
    const a = this.host.actions;
    const inRace = this.host.memory.racing;
    const w = k === 'd' ? 480 : k === 'p' ? W - 40 : 440;
    const accent = state === 'join' ? COLORS.cyan : state === 'lost' ? COLORS.danger : COLORS.amber;
    const big = { f: 'b', s: k === 'd' ? 36 : 30, w: 900, a: 'c' } as const;
    const prose = { s: 15, c: COLORS.mist, a: 'c', lh: 1.35 } as const;
    const title = state === 'join' ? `Joining ${code}` : state === 'lost' ? "Couldn't reconnect" : 'Connection lost';
    const body =
      state === 'join'
        ? "Connecting to the host's tab. This takes a few seconds."
        : state === 'reconnect'
          ? 'Reconnecting. Your seat is held for 20 more seconds.'
          : inRace
            ? 'Your seat was held for 20 seconds. Rejoin to watch the rest of this race and drive in the next one.'
            : 'Your seat was held for 20 seconds. Rejoin to get back into the party.';
    const copy = { ...prose, wrap: balancedWrap(body, { ...prose, wrap: w - 60 }) };
    // Down the panel from its top: the spinner, the title, the copy, the meter, the buttons.
    const hero = k === 'd' ? 76 : 64;
    const heroY = k === 'd' ? 34 : 30;
    const titleY = heroY + hero + (k === 'l' ? 14 : 18);
    const bodyY = titleY + big.s + 10;
    const bodyEnd = bodyY + lineCount(body, copy) * copy.s * copy.lh;
    const meterY = bodyEnd + 16;
    const buttonsY = (state === 'reconnect' ? meterY + 8 : bodyEnd) + (k === 'l' ? 22 : 28);
    const bh = k === 'l' ? 50 : k === 'd' ? 58 : 56;
    const stacked = state === 'lost' && k === 'p';
    const h = buttonsY + (stacked ? bh * 2 + 10 : bh) + FOOT;

    this.begin(true);
    this.dim(dim);
    this.begin();
    const p = this.panel((W - w) / 2, (H - h) / 2 - (k === 'p' ? 20 : 0), w, h, { accent });
    const cx = p.c.x + w / 2;
    const heroC = p.c.y + heroY + hero / 2;

    if (state === 'lost') {
      const s = k === 'd' ? 48 : 40;

      this.heroIcon = this.centred(
        this.put(
          iconSvg('offline', { size: s, color: COLORS.white, accent: COLORS.danger }),
          cx - s / 2,
          heroC - s / 2,
        ),
      );
    } else this.spinner(cx, heroC, hero, accent);
    this.text(title, cx, p.c.y + titleY, big);
    const bodyText = this.text(body, cx, p.c.y + bodyY, copy);
    const by = p.c.y + buttonsY;

    if (state === 'join') {
      this.button('Cancel', cx - 110, by, 220, bh, 'secondary', null, () => a.leave(), true);

      return null;
    }
    if (state === 'reconnect') {
      // Big Shoulders' digits sit low in their line, so the count goes a little over the spinner's middle.
      const seconds = this.middled(
        this.text('20', cx, heroC - 16, { f: 'b', s: k === 'd' ? 30 : 26, w: 900, a: 'c', c: COLORS.amber }),
      );
      const meter = this.meter(p.c.x + 40, p.c.y + meterY, w - 80, 8, 1, COLORS.amber);
      const leave = inRace ? 'Leave race' : 'Leave party';

      this.button(leave, cx - 110, by, 220, bh, 'secondary', 'exit', () => a.leave(), true);

      return { seconds, body: bodyText, meter };
    }
    if (stacked) {
      this.button('Rejoin', p.c.x + 30, by, w - 60, bh, 'primary', 'rematch', () => a.rejoin(), true);
      this.button('Back to title', p.c.x + 30, by + bh + 10, w - 60, bh, 'secondary', 'back', () => a.leave());
    } else {
      const half = (w - 76) / 2;

      this.button('Back to title', p.c.x + 30, by, half, bh, 'secondary', 'back', () => a.leave());
      this.button('Rejoin', p.c.x + 46 + half, by, half, bh, 'primary', 'rematch', () => a.rejoin(), true);
    }

    return null;
  }

  /** The waiting spinner, turning in twelfths at 8 steps a second. */
  protected spinner(cx: number, cy: number, size: number, color: string): void {
    const s = this.put(spinnerSvg(size, color), cx - size / 2, cy - size / 2).sprite;

    s.anchor.set(0.5);
    s.position.set(cx, cy);
    if (this.motion.reduced) return;
    this.motion.tick((time) => {
      s.rotation = (Math.floor(time * 8) / 12) * Math.PI * 2;
    });
  }
}
