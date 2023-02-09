import { Container, Sprite } from 'pixi.js';
import gsap from 'gsap';

/**
 * A single star used in the Result stars animation
 */
export class Star extends Container {
    /** The star image, for internal animation */
    private image: Sprite;

    constructor() {
        super();
        this.image = Sprite.from('star');
        this.image.anchor.set(0.5);
        this.addChild(this.image);
    }

    /** Show the component */
    public async show(animated = true) {
        gsap.killTweensOf(this.image.scale);
        this.visible = true;
        if (animated) {
            this.image.scale.set(0);
            await gsap.to(this.image.scale, { x: 1, y: 1, duration: 0.3, ease: 'back.out' });
        } else {
            this.image.scale.set(1);
        }
    }

    /** Hide the component */
    public async hide(animated = true) {
        gsap.killTweensOf(this.image.scale);
        if (animated) {
            await gsap.to(this.image.scale, { x: 0, y: 0, duration: 0.3, ease: 'back.in' });
        } else {
            this.image.scale.set(0);
        }
        this.visible = false;
    }

    /** Reveal the star playing a stamp-like animation */
    public async playStamp() {
        gsap.killTweensOf(this.image);
        gsap.killTweensOf(this.image.scale);
        this.visible = true;
        this.image.visible = true;
        this.image.alpha = 0;
        this.image.rotation = 3;
        this.image.scale.set(5);
        gsap.to(this.image, { alpha: 1, duration: 0.2, ease: 'linear' });
        gsap.to(this.image, { rotation: 0, duration: 0.5, ease: 'back.out' });
        await gsap.to(this.image.scale, { x: 1, y: 1, duration: 0.5, ease: 'expo.in' });
    }
}
