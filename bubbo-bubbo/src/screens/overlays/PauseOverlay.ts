import gsap from 'gsap';
import { Container, Graphics, Sprite, Text } from 'pixi.js';

import type { AppScreen } from '../../navigation';
import { storage } from '../../storage';
import { AudioSecondaryButton } from '../../ui/buttons/AudioSecondaryButton';
import { SecondaryButton } from '../../ui/buttons/SecondaryButton';
import { i18n } from '../../utils/i18n';

/** The main pause panel. Separated for cleaner code. */
class PausePanel {
    /** The Container instance which contains all the visual elements for this class. */
    public view = new Container();

    private readonly _base: Sprite;
    private readonly _titleText: Text;
    private readonly _scoreTitleText: Text;
    private readonly _scoreText: Text;

    constructor() {
        // Create the visuals of the panel
        this._base = Sprite.from('images/pause-overlay/pause-panel.png');
        this._base.anchor.set(0.5);
        this.view.addChild(this._base);

        this._titleText = new Text({
            text: i18n.t('paused'),
            style: {
                fontSize: 30,
                fontWeight: '900',
                fontFamily: 'Bungee-Regular',
                fill: 0xffffff,
                align: 'center',
            },
        });

        this._titleText.anchor.set(0.5);
        this._titleText.y = -(this._base.height * 0.5) + 50;
        this.view.addChild(this._titleText);

        this._scoreTitleText = new Text({
            text: i18n.t('score'),
            style: {
                fontSize: 20,
                fontWeight: '900',
                fontFamily: 'Bungee-Regular',
                fill: 0x000000,
                align: 'center',
            },
        });

        this._scoreTitleText.anchor.set(0.5);
        this._scoreTitleText.y = -82;
        this.view.addChild(this._scoreTitleText);

        this._scoreText = new Text({
            style: {
                fontSize: 60,
                fontWeight: '900',
                fontFamily: 'Bungee-Regular',
                fill: 0x000000,
                align: 'center',
            },
        });

        this._scoreText.anchor.set(0.5);
        this._scoreText.y = -37;
        this.view.addChild(this._scoreText);
    }

    /**
     * Set's the score of the player on the panel.
     * @param score - The player's total score.
     */
    public setScore(score: number) {
        // Used to add commas into a number, outputs as string
        this._scoreText.text = score.toLocaleString();

        // Reset fontSize to original state
        this._scoreText.style.fontSize = 60;

        // While the score text is bigger than expected, decrease fontsize.
        while (this._scoreText.width > this._base.width) {
            this._scoreText.style.fontSize--;
        }
    }
}

/**
 * Callback function definition to help determine user interaction on the pause screen.
 * It will callback with the intended action of the user, either `resume` or `quit` as a parameter
 */
type PauseCallback = (state: 'quit' | 'resume') => void;

/** The overlay shown when the game has been paused. */
export class PauseOverlay extends Container implements AppScreen {
    /** A unique identifier for the screen */
    public static SCREEN_ID = 'pause';
    /** An array of bundle IDs for dynamic asset loading. */
    public static assetBundles = ['pause-overlay'];

    private readonly _background: Graphics;
    private readonly _panel: PausePanel;
    private _audioBtn!: AudioSecondaryButton;
    private _resumeBtn!: SecondaryButton;
    private _quitBtn!: SecondaryButton;

    /**
     *  A function to help determine user interaction on the pause screen.
     *  It will callback with the intended action of the user, either `resume` or `quit` as a parameter
     */
    private _callBack!: PauseCallback;

    constructor() {
        super();

        // Create the background, this is used as an interaction blocker
        this._background = new Graphics().rect(0, 0, 50, 50).fill({ color: 0x000000, alpha: 0.5 });
        // Prevent interaction behind overlay
        this._background.interactive = true;
        this.addChild(this._background);

        // Add the main pause panel
        this._panel = new PausePanel();
        this.addChild(this._panel.view);

        // Add buttons
        this._buildButtons();
    }

    /**
     * Called before `show` function.
     * @param data - An object containing data specific to this screen.
     */
    public prepare(data: {
        /** The player's total score. */
        score: number;
        /**
         *  A function to help determine user interaction on the pause screen.
         *  It will callback with the intended action of the user, either `resume` or `quit` as a parameter
         */
        callback: PauseCallback;
    }) {
        // Set the score in the main panel
        this._panel.setScore(data?.score ?? 0);

        // Stores the callback for later use
        this._callBack = data.callback;

        // Force the audio button to change icon based on audio mute state
        this._audioBtn.forceSwitch(storage.getStorageItem('muted'));
    }

    /** Called when the screen is being shown. */
    public async show() {
        // Kill tweens of the screen container
        gsap.killTweensOf(this);

        // Reset screen data
        this.alpha = 0;
        await gsap.to(this, { alpha: 1, duration: 0.2, ease: 'linear' });
    }

    /** Called when the screen is being hidden. */
    public async hide() {
        // Kill tweens of the screen container
        gsap.killTweensOf(this);

        await gsap.to(this, { alpha: 0, duration: 0.2, ease: 'linear' });
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

        // Move main panel to center screen
        this._panel.view.x = w * 0.5;
        this._panel.view.y = h * 0.5;
    }

    /** Add buttons to screen. */
    private _buildButtons() {
        this._audioBtn = new AudioSecondaryButton();

        this._panel.view.addChild(this._audioBtn);

        this._audioBtn.y = 50;

        this._resumeBtn = new SecondaryButton({
            text: i18n.t('resume'),
            tint: 0xffc42c,
        });

        this._resumeBtn.onPress.connect(() => {
            // Callback to game with the intention to resume
            this._callBack?.('resume');
        });
        this._resumeBtn.y = this._audioBtn.y + 60;

        this._panel.view.addChild(this._resumeBtn);

        this._quitBtn = new SecondaryButton({
            text: i18n.t('quit'),
            tint: 0x49c8ff,
        });

        this._quitBtn.onPress.connect(() => {
            // Callback to game with the intention to quit
            this._callBack?.('quit');
        });

        this._panel.view.addChild(this._quitBtn);
        this._quitBtn.y = this._resumeBtn.y + 60;
    }
}
