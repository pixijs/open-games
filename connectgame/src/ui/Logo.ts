import { Container, Sprite } from 'pixi.js';
import gsap from 'gsap';

/**
 * The game logo, presented in the Home screen
 */
export class Logo extends Container {
    /** The logo image */
    private image: Sprite;

    constructor() {
        super();
        this.scale.set(0.5);
        this.image = Sprite.from('logo-game');
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
}
