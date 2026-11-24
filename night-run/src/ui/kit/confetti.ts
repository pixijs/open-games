import type { Container } from 'pixi.js';

import type { ConfettiKind } from '../art/motifs';
import { confettiSvg } from '../art/motifs';
import { ArtSprite } from './ArtSprite';
import type { UiKit } from './kit';
import type { Motion } from './Motion';

const KINDS: readonly ConfettiKind[] = ['strip', 'square', 'chevron', 'star', 'disc'];

/**
 * Throws `count` pieces of confetti in `color` from `x`, `y` in `parent`: they burst out and up, tumble and fall,
 * then go. Each piece's moves are one timeline, so nothing tweens a piece after it lands and releases its texture.
 * Reduced motion throws none.
 */
export function confettiBurst(
  kit: UiKit,
  motion: Motion,
  parent: Container,
  x: number,
  y: number,
  color: string,
  count = 12,
  spread = 1,
): void {
  if (motion.reduced) return;
  for (let i = 0; i < count; i++) {
    const art = confettiSvg(KINDS[i % KINDS.length], color, 10 + (i % 3) * 3);
    const piece = new ArtSprite(kit.textures, art, kit.layout.density);
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.3;
    const speed = (70 + Math.random() * 90) * spread;
    const dur = 0.9 + Math.random() * 0.5;
    const flip = 0.18 + Math.random() * 0.12;
    const flips = Math.max(1, Math.floor(dur / flip / 2)) * 2;

    piece.anchor.set(0.5);
    piece.position.set(x, y);
    piece.rotation = Math.random() * Math.PI;
    parent.addChild(piece);
    motion
      .timeline({ onComplete: () => piece.destroy() })
      .to(piece, { x: x + Math.cos(angle) * speed, duration: dur, ease: 'power2.out' }, 0)
      .to(piece, { y: y + Math.sin(angle) * speed, duration: dur * 0.4, ease: 'power2.out' }, 0)
      .to(piece, { y: y + Math.sin(angle) * speed + 120 * spread, duration: dur * 0.6, ease: 'power1.in' }, dur * 0.4)
      .to(piece, { alpha: 0, duration: 0.25 }, dur - 0.25)
      .to(piece, { rotation: piece.rotation + (Math.random() - 0.5) * 8, duration: dur, ease: 'none' }, 0)
      .to(piece.scale, { x: -1, duration: dur / flips, repeat: flips - 1, yoyo: true, ease: 'sine.inOut' }, 0);
  }
}
