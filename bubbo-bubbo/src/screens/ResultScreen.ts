import gsap from 'gsap';
import { Container, Graphics, Sprite, Text, Texture, TilingSprite } from 'pixi.js';

import { boardConfig, randomType } from '../game/boardConfig';
import { designConfig } from '../game/designConfig';
import { AppScreen, navigation } from '../navigation';
import { IconButton } from '../ui/buttons/IconButton';
import { PrimaryButton } from '../ui/buttons/PrimaryButton';
import { Porthole } from '../ui/Porthole';
import { i18n } from '../utils/i18n';
import { GameScreen } from './GameScreen';
import { TitleScreen } from './TitleScreen';

/** The `ResultsData` interface represents the data of the results screen. */
export interface ResultsData {
    /** The score of the player. */
    score: number;
    /** The number of bubbles popped. */
    popped: number;
    /** The highest combo achieved. */
    combo: number;
    /** The number of powerups used. */
    powerups: number;
    /** The highscore achieved in the game, or the one that is stored in localstorage. */
    highscore: number;
}

/** The `StatView` class represents a visual representation of a game stats. */
class StatView {
    /* The container instance that is the root of all visuals in this class */
    public view = new Container();

    /** The text displaying the name of the stat. */
    private _statNameText: Text;
    /** The text displaying the value of the stat. */
    private _statValueText: Text;

    /**
     * @param name - The name of the stat.
     * @param width - The value relative to the stat.
     */
    constructor(name: string, width: number) {
        // Create stat visuals
        this._statNameText = new Text({
            text: name,
            style: {
                fontSize: 18,
                fontWeight: '100',
                fontFamily: 'Opensans-Semibold',
                fill: 0x000000,
                align: 'left',
            },
        });

        this._statNameText.anchor.set(0, 0.5);
        this._statNameText.x = -width * 0.5;

        this._statValueText = new Text({
            text: '1000',
            style: {
                fontSize: 18,
                fontWeight: '100',
                fontFamily: 'Opensans-Semibold',
                fill: 0x000000,
                align: 'right',
            },
        });
        this._statValueText.x = width * 0.5;

        this._statValueText.anchor.set(1, 0.5);

        this.view.addChild(this._statNameText, this._statValueText);
    }

    /**
     * Update the stat's value.
     * @param value - The stat value.
     */
    public updateValue(value: number) {
        // Highly unlikely the value would get this high,
        // but it is an alternative to shrinking the text
        if (value > 99999999999) {
            this._statValueText.text = '9999999999+';

            return;
        }

        // Assign the new value to the text
        this._statValueText.text = value;
    }
}

class ResultsPanel {
    /* The container instance that is the root of all visuals in this class */
    public view = new Container();

    /** The base sprite of the results panel. */
    private readonly _base: Sprite;
    /** The stat view for the number of bubbles popped. */
    private _bubblesPoppedStat!: StatView;
    /** The stat view for the number of powerups used. */
    private _powerupsUsedStat!: StatView;
    /** The stat view for the best combo score. */
    private _comboStat!: StatView;
    /** The text display for the player's score. */
    private _scoreText!: Text;
    /** The text display for the player's high score. */
    private _highscoreText!: Text;
    /** The maximum width for the score text. */
    private _maxScoreWidth = 0;

    constructor() {
        // Initialise the base sprite and creates child objects for the breakdown panel and score and high score displays
        this._base = Sprite.from('panel-end-screen-base');
        this._base.anchor.set(0.5);

        const titleText = new Text({
            text: i18n.t('resultsTitle'),
            style: {
                fontSize: 30,
                fontWeight: '900',
                fontFamily: 'Bungee-Regular',
                fill: 0x000000,
                align: 'center',
            },
        });

        titleText.anchor.set(0.5);
        titleText.y = -(this._base.height * 0.5) + 27;

        this._base.addChild(titleText);

        // Create the extra stats section of the results screen
        this._buildBreakdownPanel();

        // Use a helper function to create a subpanel to display the highscore
        this._highscoreText = this._buildSubPanel({
            yOffset: -175,
            title: i18n.t('resultsHighscoreTitle'),
            alpha: 0.4,
        });

        // Use a helper function to create a subpanel to display the current score
        this._scoreText = this._buildSubPanel({
            yOffset: 200,
            title: i18n.t('resultsScoreTitle'),
        });

        this.view.addChild(this._base);
    }

    /**
     * Updates the data displayed in the results panel.
     * @param data - The ResultsData object to display.
     */
    public updateData(data: ResultsData) {
        // Update the substats panel data
        this._bubblesPoppedStat.updateValue(data.popped);
        this._comboStat.updateValue(data.combo);
        this._powerupsUsedStat.updateValue(data.powerups);

        // Update the player score
        this._scoreText.text = data.score;

        // Reset the score text font size
        this._scoreText.style.fontSize = 60;

        // Decrease the font size while the display object is bigger than the max possible size
        while (this._scoreText.width > this._maxScoreWidth) {
            this._scoreText.style.fontSize--;
        }

        // Do the same for the highscore
        this._highscoreText.text = data.highscore;

        this._highscoreText.style.fontSize = 60;

        while (this._highscoreText.width > this._maxScoreWidth) {
            this._highscoreText.style.fontSize--;
        }
    }

    /** Helper function to create a smaller panel within the main panel. */
    private _buildBreakdownPanel() {
        // Create visuals
        const breakdownPanel = Sprite.from('panel-end-screen-points-breakdown');

        breakdownPanel.anchor.set(0.5);
        breakdownPanel.y = 15;

        const breakdownTitleText = new Text({
            text: i18n.t('resultsBreakdownTitle'),
            style: {
                fontSize: 16,
                fontWeight: '900',
                fontFamily: 'Bungee-Regular',
                fill: 0x000000,
                align: 'center',
            },
        });

        breakdownPanel.alpha = 0.4;

        breakdownTitleText.anchor.set(0.5);
        breakdownTitleText.y = -(breakdownPanel.height * 0.5) + breakdownTitleText.height * 0.5 + 2;

        // Create a new container and add the information to it
        // since the main background is being alpha'd and would otherwise affect the information
        const informationContainer = new Container();

        informationContainer.y = breakdownPanel.y;

        const verticalOffset = 10;
        const verticalGap = 30;

        // Create stat instances and attach to panel
        this._bubblesPoppedStat = new StatView(i18n.t('resultsBreakdownPopped'), breakdownPanel.width * 0.9);
        this._bubblesPoppedStat.view.y = verticalOffset - verticalGap;
        this._comboStat = new StatView(i18n.t('resultsBreakdownCombo'), breakdownPanel.width * 0.9);
        this._comboStat.view.y = verticalOffset;
        this._powerupsUsedStat = new StatView(i18n.t('resultsBreakdownPowerups'), breakdownPanel.width * 0.9);
        this._powerupsUsedStat.view.y = verticalOffset + verticalGap;

        informationContainer.addChild(
            breakdownTitleText,
            this._bubblesPoppedStat.view,
            this._powerupsUsedStat.view,
            this._comboStat.view,
        );

        this._base.addChild(breakdownPanel, informationContainer);
    }

    /**
     * Helper function to create sub panel for the large panel.
     * @param options - Information for when each panel requires specific information.
     * @returns A text object.
     */
    private _buildSubPanel(options: {
        /** The vertical offset of the sub panel */
        yOffset: number;
        /** The title of the sub panel */
        title: string;
        /** The alpha of the sub panel, defaults to `1` */
        alpha?: number;
    }) {
        // Create visuals
        const panel = Sprite.from('panel-end-screen-points-total');

        panel.anchor.set(0.5);
        if (options.alpha) panel.alpha = options.alpha;
        panel.y = options.yOffset;

        this._maxScoreWidth = panel.width * 0.8;

        // Create a new container and add the information to it
        // since the main background is being alpha'd and would otherwise affect the information
        const informationContainer = new Container();

        informationContainer.y = options.yOffset;

        // Create subpanel title text
        const scoreTitleText = new Text({
            text: options.title,
            style: {
                fontSize: 22,
                fontWeight: '900',
                fontFamily: 'Bungee-Regular',
                fill: 0x000000,
                align: 'center',
            },
        });

        scoreTitleText.anchor.set(0.5);
        scoreTitleText.y = -(panel.height * 0.5) + scoreTitleText.height * 0.5 + 3;

        // Create subpanel value text
        const scoreText = new Text({
            style: {
                fontSize: 50,
                fontWeight: '900',
                fontFamily: 'Bungee-Regular',
                fill: 0x000000,
                align: 'center',
            },
        });

        scoreText.anchor.set(0.5);
        scoreText.y = 10;

        informationContainer.addChild(scoreTitleText, scoreText);

        this._base.addChild(panel, informationContainer);

        return scoreText;
    }
}

export class ResultScreen extends Container implements AppScreen {
    /** A unique identifier for the screen. */
    public static SCREEN_ID = 'result';
    /** An array of bundle IDs for dynamic asset loading. */
    public static assetBundles = ['results-screen'];

    private _background: TilingSprite;
    /** An animated background decor instance. */
    private _porthole!: Porthole;
    /** A layered visual panel. */
    private _resultsPanel: ResultsPanel;
    private _footer!: Graphics;
    private _playBtn!: PrimaryButton;
    private _backBtn!: IconButton;

    constructor() {
        super();

        // Create the background
        this._background = new TilingSprite(Texture.from('background-tile'), 64, 64);
        this._background.tileScale.set(designConfig.backgroundTileScale);

        this.addChild(this._background);

        // Add visual details like footer, portholes
        this._buildDetails();

        // Add buttons like the play button and return button
        this._buildButtons();

        // Created the layered visual panel, separated for code cleanliness
        this._resultsPanel = new ResultsPanel();
        this._resultsPanel.view.scale.set(0.95);
        this.addChild(this._resultsPanel.view);
    }

    /**
     * Called before `show` function.
     * @param data - An object containing data specific to this screen.
     */
    public prepare(data: ResultsData) {
        // Update the details data
        this._resultsPanel.updateData(data);
    }

    /** Called when the screen is being shown. */
    public async show() {
        // Kill tweens of the screen container
        gsap.killTweensOf(this);

        // Reset screen data
        this.alpha = 0;

        // Starts the animations for the background porthole details
        this._porthole.start();

        // Tween screen into being visible
        await gsap.to(this, { alpha: 1, duration: 0.2, ease: 'linear' });
    }

    /** Called when the screen is being hidden. */
    public async hide() {
        // Kill tweens of the screen container
        gsap.killTweensOf(this);

        // Tween screen into being invisible
        await gsap.to(this, { alpha: 0, duration: 0.2, ease: 'linear' });

        // Stop porthole to prevent them from animating when not on screen
        this._porthole.stop();
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

        this._footer.width = w * 1.2;
        this._footer.x = w * 0.5;
        this._footer.y = h + 25;

        this._porthole.view.x = 40;
        this._porthole.view.y = 80;

        this._playBtn.x = w * 0.5;
        this._playBtn.y = h - this._playBtn.height + 5;

        this._backBtn.x = 50;
        this._backBtn.y = h - 50;

        this._resultsPanel.view.x = w * 0.5;
        this._resultsPanel.view.y = h * 0.5 - 85;
    }

    /** Add visual details to title screen. */
    private _buildDetails() {
        this._porthole = new Porthole();
        this.addChild(this._porthole.view);

        this._footer = new Graphics()
            .ellipse(0, 0, 300, 125)
            .fill({ color: boardConfig.bubbleTypeToColor[randomType()] });
        this.addChild(this._footer);
    }

    /** Add buttons to screen. */
    private _buildButtons() {
        this._playBtn = new PrimaryButton({
            text: i18n.t('resultsPlay'),
        });

        this._playBtn.onPress.connect(() => {
            // Go to game screen when user presses play button
            navigation.goToScreen(GameScreen);
        });

        this._backBtn = new IconButton('icon-back', 1);
        this._backBtn.onPress.connect(() => {
            // Go to title screen when user presses return button
            navigation.goToScreen(TitleScreen);
        });

        this.addChild(this._playBtn, this._backBtn);
    }
}
