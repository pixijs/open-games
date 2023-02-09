import { Container, Texture, TilingSprite } from 'pixi.js';
import { app } from '../main';

/**
 * The app's animated background based on TilingSprite, always present in the screen
 */
export class TiledBackground extends Container {
    /** The direction that the background should animate */
    public direction = -Math.PI * 0.15;
    /** The tiling sprite that will repeat the pattern */
    private sprite: TilingSprite;

    constructor() {
        super();

        this.sprite = new TilingSprite(
            Texture.from('background'),
            app.screen.width,
            app.screen.height,
        );
        this.sprite.tileTransform.rotation = this.direction;
        this.addChild(this.sprite);
    }

    /** Get the sprite width */
    public get width() {
        return this.sprite.width;
    }

    /** Set the sprite width */
    public set width(value: number) {
        this.sprite.width = value;
    }

    /** Get the sprite height */
    public get height() {
        return this.sprite.height;
    }

    /** Set the sprite height */
    public set height(value: number) {
        this.sprite.height = value;
    }

    /** Auto-update by overriding Container's updateTransform */
    public updateTransform() {
        super.updateTransform();
        const delta = app.ticker.deltaTime;
        this.sprite.tilePosition.x -= Math.sin(-this.direction) * delta;
        this.sprite.tilePosition.y -= Math.cos(-this.direction) * delta;
    }

    /** Resize the background, fired whenever window size changes  */
    public resize(width: number, height: number) {
        this.width = width;
        this.height = height;
    }
}
