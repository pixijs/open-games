import gsap from 'gsap';
import { Container, Sprite, Texture, Ticker, TilingSprite } from 'pixi.js';

import { randomType } from '../game/boardConfig';
import { designConfig } from '../game/designConfig';
import { Cannon } from '../game/entities/Cannon';
import { PixiLogo } from '../ui/PixiLogo';
import { i18n } from '../utils/i18n';
import { lerp } from '../utils/maths/maths';
import { randomRange } from '../utils/maths/rand';

/** The default load screen for the game. */
export class LoadScreen extends Container {
    /** A unique identifier for the screen */
    public static SCREEN_ID = 'loader';
    /** An array of bundle IDs for dynamic asset loading. */
    public static assetBundles = ['preload'];

    private readonly _background: TilingSprite;
    private readonly _spinner: Sprite;
    private readonly _cannon: Cannon;
    private readonly _pixiLogo: PixiLogo;

    /** An added container to animate the pixi logo off screen. */
    private _bottomContainer = new Container();
    /** An rotational offset that gets randomised. */
    private _targetOffset = 0;
    /** A variable used to store the current time state of animation */
    private _tick = 0;

    constructor() {
        super();

        // Create the visual aspects of the load screen
        this._background = new TilingSprite({
            texture: Texture.from('background-tile'),
            width: 64,
            height: 64,
            tileScale: {
                x: designConfig.backgroundTileScale,
                y: designConfig.backgroundTileScale,
            },
        });
        this.addChild(this._background);

        this._spinner = Sprite.from('loading-circle');
        this._spinner.anchor.set(0.5);
        this.addChild(this._spinner);

        this._cannon = new Cannon();
        this._cannon.view.scale.set(0.5);
        this._cannon.type = randomType();
        this.addChild(this._cannon.view);

        this._pixiLogo = new PixiLogo(i18n.t('pixiLogoHeader'));
        this._pixiLogo.view.scale.set(0.75);
        this._bottomContainer.addChild(this._pixiLogo.view);
        this.addChild(this._bottomContainer);
    }

    /** Called when the screen is being shown. */
    public async show() {
        // Kill tweens of the screen container
        gsap.killTweensOf(this);

        // Reset screen data
        this.alpha = 0;
        this._bottomContainer.y = 0;

        // Tween screen into being visible
        await gsap.to(this, { alpha: 1, duration: 0.2, ease: 'linear' });
    }

    /** Called when the screen is being hidden. */
    public async hide() {
        // Kill tweens of the screen container
        gsap.killTweensOf(this);

        // Hide pixi logo off screen
        await gsap.to(this._bottomContainer, {
            y: 100,
            duration: 0.25,
        });

        // Tween screen into being invisible
        await gsap.to(this, { alpha: 0, delay: 0.1, duration: 0.2, ease: 'linear' });
    }

    /**
     * Called every frame
     * @param time - Ticker object with time related data.
     */
    public update(time: Ticker) {
        const delta = time.deltaTime;

        // Rotate spinner
        this._spinner.rotation -= delta / 60;

        // Lerp the rotations of the cannon to the spinner rotation but with an offset
        this._cannon.rotation = lerp(this._cannon.rotation, this._spinner.rotation - this._targetOffset, 0.1);

        // When tick is zero, randomise aforementioned offset
        if (this._tick <= 0) {
            this._targetOffset = randomRange(Math.PI * 0.2, Math.PI * 0.5);
            this._tick = 1;
        } else {
            // Decremented every frame using delta time
            this._tick -= delta / 60;
        }
    }

    /**
     * Gets called every time the screen resizes.
     * @param w - width of the screen.
     * @param h - height of the screen.
     */
    public resize(w: number, h: number) {
        // Fit background to screen
        this._background.width = w;
        this._background.height = h;

        // Set visuals to their respective locations
        this._spinner.x = this._cannon.view.x = w * 0.5;
        this._spinner.y = this._cannon.view.y = h * 0.5;

        this._pixiLogo.view.x = w * 0.5;
        this._pixiLogo.view.y = h - 55;
    }
}
