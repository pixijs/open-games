import { Container, Sprite } from 'pixi.js';

/** PixiJS logo UI component */
export class PixiLogo extends Container {
    /** The logo image */
    private image: Sprite;

    constructor() {
        super();
        this.image = Sprite.from('logo-pixi');
        this.image.anchor.set(0.5);
        this.addChild(this.image);
    }
}
