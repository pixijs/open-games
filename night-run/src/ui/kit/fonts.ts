import { CanvasTextMetrics } from 'pixi.js';

import { FONTS } from '../art/tokens';
import { clearBaselines } from './text';

const FACES = [
  '900 40px "Big Shoulders Display"',
  '800 40px "Big Shoulders Display"',
  '700 40px "Big Shoulders Display"',
  'italic 700 20px Kanit',
  'italic 600 20px Kanit',
  '700 16px Kanit',
  '600 16px Kanit',
  '500 16px Kanit',
];

/** Resolves once the stylesheet has arrived (its @font-face rules exist), or failed. */
function sheetLoaded(link: HTMLLinkElement): Promise<void> {
  return new Promise((resolve) => {
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => resolve(), { once: true });
  });
}

let loading: Promise<boolean> | null = null;

/**
 * Loads the UI's two font families once per page. Resolves `true` when they're in, or `false` after
 * `timeoutMs` (offline, blocked): Text made before then draws in the fallbacks `FONTS` lists, and the caller rebuilds
 * when the late load finishes through `onLate`.
 */
export function loadFonts(timeoutMs: number, onLate: () => void): Promise<boolean> {
  if (!loading) {
    const link = document.createElement('link');

    link.rel = 'stylesheet';
    link.href = FONTS.url;
    const sheet = sheetLoaded(link);

    document.head.appendChild(link);
    loading = sheet
      .then(() => Promise.all(FACES.map((face) => document.fonts.load(face))))
      .then(
        (faces) => {
          CanvasTextMetrics.clearMetrics();
          clearBaselines();

          return faces.every((list) => list.length > 0);
        },
        () => false,
      );
  }
  const loaded = loading;
  let timer = 0;
  const timeout = new Promise<boolean>((resolve) => {
    timer = window.setTimeout(() => resolve(false), timeoutMs);
  });

  return Promise.race([loaded, timeout]).then((inTime) => {
    window.clearTimeout(timer);
    if (!inTime) void loaded.then((ok) => ok && onLate());

    return inTime;
  });
}
