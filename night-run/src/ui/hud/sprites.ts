import type { Sprite } from 'pixi.js';

import type { SvgArt } from '../art/svg';

/** Puts a sprite (anchor 0) so its art's face top-left lands on x, y */
export function atFace(sprite: Sprite, art: SvgArt, x: number, y: number): void {
  sprite.anchor.set(0, 0);
  sprite.position.set(x - (art.face?.x ?? 0), y - (art.face?.y ?? 0));
}

/** Centres a sprite on x, y by its art's anchor (the middle when it has none) */
export function atAnchor(sprite: Sprite, art: SvgArt, x: number, y: number): void {
  sprite.anchor.set(art.anchor?.x ?? 0.5, art.anchor?.y ?? 0.5);
  sprite.position.set(x, y);
}

/** The face box of a piece of art */
export function faceOf(art: SvgArt): { x: number; y: number; w: number; h: number } {
  return art.face ?? { x: 0, y: 0, w: art.width, h: art.height };
}
