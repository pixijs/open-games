import gsap from 'gsap';
import { Container, Texture, Ticker, TilingSprite } from 'pixi.js';

import { designConfig } from '../game/designConfig';
import { Game } from '../game/Game';
import type { AppScreen } from '../navigation';

/** The screen that contains all the gameplay */
export class GameScreen extends Container implements AppScreen {
    /** A unique identifier for the screen */
    public static SCREEN_ID = 'game';
    /** An array of bundle IDs for dynamic asset loading. */
    public static assetBundles = ['game-screen'];

    private readonly _background: TilingSprite;
    private readonly _game: Game;

    constructor() {
        super();

        // Create the background
        this._background = new TilingSprite({
            texture: Texture.from('background-tile-space'),
            width: 64,
            height: 64,
            tileScale: {
                x: designConfig.backgroundTileScale,
                y: designConfig.backgroundTileScale,
            },
        });
        this.addChild(this._background);

        // Create an instance of the game and initialise
        this._game = new Game();
        this._game.init();
        this.addChild(this._game.stage);
    }

    /** Called when the screen is being shown. */
    public async show() {
        // Kill tweens of the screen container
        gsap.killTweensOf(this);

        // Reset screen data
        this.alpha = 0;

        // Wake up the game
        this._game.awake();
        await gsap.to(this, { alpha: 1, duration: 0.2, ease: 'linear' });
        // Start the game
        this._game.start();
    }

    /** Called when the screen is being hidden. */
    public async hide() {
        // Kill tweens of the screen container
        gsap.killTweensOf(this);
        // End the game
        this._game.end();
        await gsap.to(this, { alpha: 0, duration: 0.2, ease: 'linear' });
        // Reset the game
        this._game.reset();
    }

    /**
     * Called every frame.
     * @param time - Ticker object with time related data.
     */
    public update(time: Ticker) {
        this._game.update(time.deltaTime);
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

        // Forward screen dimensions to the game
        this._game.resize(w, h);
    }
}
