import { Container, Sprite } from 'pixi.js';
import gsap from 'gsap';
import { randomRange } from '../utils/random';

/**
 * Little explosion effect, that is used mainly for gameplay effects
 */
export class PopExplosion extends Container {
    /** List of animated particles */
    private particles: Sprite[] = [];

    constructor() {
        super();

        for (let i = 0; i < 12; i++) {
            const particle = Sprite.from('circle');
            particle.anchor.set(0.5);
            particle.visible = false;
            this.particles.push(particle);
            this.addChild(particle);
        }
    }

    /** Play the explosion animation */
    public async play() {
        const animPromises = [];
        for (const particle of this.particles) {
            animPromises.push(this.playParticle(particle));
        }

        await Promise.all(animPromises);
    }

    /** Play a single explosion particle */
    private async playParticle(particle: Sprite) {
        gsap.killTweensOf(particle);
        gsap.killTweensOf(particle.scale);
        particle.visible = true;
        particle.scale.set(0.1);
        particle.alpha = 1;
        particle.x = randomRange(-10, 10);
        particle.y = randomRange(-10, 10);
        const x = randomRange(-50, 50);
        const y = randomRange(-50, 50);
        const scale = randomRange(0.4, 0.6);
        const alpha = 0;
        const duration = 0.5;
        gsap.to(particle.scale, { x: scale, y: scale, duration, ease: 'sine.out' });
        await gsap.to(particle, { x, y, alpha, duration, ease: 'quad.out' });
        particle.visible = false;
    }
}
