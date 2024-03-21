import gsap from 'gsap';
import { Container, Graphics, NineSliceSprite, Sprite, Texture } from 'pixi.js';

import { IconButton } from '../../ui/buttons/IconButton';
import { HelperPanel } from '../../ui/HelperPanel';
import { LaserLine } from '../../ui/LaserLine';
import { PointToaster } from '../../ui/PointToaster';
import { ScoreCounter } from '../../ui/ScoreCounter';
import { Title } from '../../ui/Title';
import { removeAllFromArray, removeFromArray } from '../../utils/utils';
import { boardConfig } from '../boardConfig';
import { designConfig } from '../designConfig';
import type { Bubble } from '../entities/Bubble';
import type { Game } from '../Game';
import { pool } from '../Pool';
import type { System } from '../SystemRunner';
import { CannonSystem } from './CannonSystem';
import { PauseSystem } from './PauseSystem';

export class HudSystem implements System {
    /**
     * A unique identifier used by the system runner.
     * The identifier is used by the runner to differentiate between different systems.
     */
    public static SYSTEM_ID = 'hud';
    /**
     * The instance of the game the system is attached to.
     * This is automatically set by the system runner when the system is added to the game.
     */
    public game!: Game;
    /* The container instance that is the root of all visuals in this class. */
    public view = new Container();
    /* The container instance that is used by the cannon system to add the cannon. */
    public readonly cannonContainer = new Container();

    /** The container that hold all of the background decor hud. */
    private readonly _decorContainer = new Container();
    /** The container that hold all of the game hud. */
    private readonly _gameHudContainer = new Container();

    // All the visuals for the hud elements
    private _laserLine!: LaserLine;
    private _topTray!: NineSliceSprite;
    private _roundedTray!: Sprite;
    private _hiddenTitle!: Title;
    private _bottomTray!: NineSliceSprite;
    private _leftBorder!: NineSliceSprite;
    private _rightBorder!: NineSliceSprite;
    private _pauseButton!: IconButton;
    private _scoreCounter!: ScoreCounter;
    private _helperPanel!: HelperPanel;

    /** The mask is used to keep visual elements from rendering outside of the given game bounds */
    private _mask!: Graphics;

    /** A flag to determine if the tutorial view has been seen. */
    private _hasShownHelper = false;
    /** Used to store all the point toaster visuals. */
    private readonly _toasterList: PointToaster[] = [];
    /** Store the current height game. */
    private _height!: number;
    /**
     * The ratio between the top and the bottom of the screen.
     * Used to animate the top hud visual down
     */
    private _topTrayOffsetRatio = 0;

    /** Called when the system is added to the game. */
    public init() {
        this.view.addChild(this._gameHudContainer, this._decorContainer);
        this.game.stage.addChild(this.view);

        // Create the visual representation of the bounce line
        this._laserLine = new LaserLine();

        // Position visual representation onto actual bounce line
        this._laserLine.view.y = -boardConfig.bounceLine;
        this._laserLine.view.x = -designConfig.content.width * 0.5;

        // Create the top section of the hud
        // Create the top hud element
        this._topTray = new NineSliceSprite({ texture: Texture.from('top-tray') });
        this._topTray.x = -designConfig.content.width * 0.5;
        this._topTray.width = designConfig.content.width;

        // Block interactions for when it animates of the whole game
        this._topTray.interactive = true;

        // Create hidden visuals that show up of thin screens
        this._roundedTray = Sprite.from('rounded-tray');
        this._roundedTray.anchor.set(0.5);

        this._hiddenTitle = new Title();
        this._hiddenTitle.view.scale.set(0.85);
        this._hiddenTitle.view.y -= 55;

        // Create the bottom section of the hud
        this._bottomTray = new NineSliceSprite({ texture: Texture.from('bottom-tray') });
        this._bottomTray.height = boardConfig.bounceLine - 30;
        this._bottomTray.pivot.y = this._bottomTray.height;
        this._bottomTray.x -= designConfig.content.width * 0.5;
        this._bottomTray.width = designConfig.content.width;

        // Create the score bar
        this._scoreCounter = new ScoreCounter();

        // Create the visual representation of the left bounds
        this._leftBorder = new NineSliceSprite({ texture: Texture.from('game-side-border') });
        this._leftBorder.x = -(designConfig.content.width * 0.5) - this._leftBorder.width;

        // Create the visual representation of the right bounds
        this._rightBorder = new NineSliceSprite({ texture: Texture.from('game-side-border') });
        this._rightBorder.x = designConfig.content.width * 0.5;

        // Get a reference to the pause system
        const pause = this.game.systems.get(PauseSystem);

        // Create the pause button
        this._pauseButton = new IconButton('icon-pause');
        this._pauseButton.onPress.connect(() => {
            // On press, pause the game
            pause.pause();
        });
        this._pauseButton.x = designConfig.content.width * 0.5 - 40;
        this._pauseButton.y = -designConfig.content.height + 37;

        // Create a mask and fit it to the game bounds
        this._mask = new Graphics()
            .rect(
                -designConfig.content.width * 0.5,
                -designConfig.content.height,
                designConfig.content.width,
                designConfig.content.height,
            )
            .fill({ color: 0x030320 });

        // Create the tutorial popout
        this._helperPanel = new HelperPanel();
        this._helperPanel.view.y = -designConfig.content.height + 200;

        // Add hud to containers
        this._decorContainer.addChild(
            this._mask,
            this._leftBorder,
            this._rightBorder,
            this._topTray,
            this._roundedTray,
            this._hiddenTitle.view,
        );
        this._gameHudContainer.addChild(
            this._bottomTray,
            this._scoreCounter.view,
            this._laserLine.view,
            this._helperPanel.view,
            this.cannonContainer,
            this._pauseButton,
        );

        // Designate the mask to the game hud
        this._gameHudContainer.mask = this._mask;

        // Connect to the cannon system
        this.game.systems.get(CannonSystem).signals.onCannonFire.connect((isFirst) => {
            if (isFirst) {
                // On the first shot, hide the tutorial popout
                this.game.systems.get(PauseSystem).addTween(this._helperPanel.hide());
            }
        });
    }

    /** Called prior to the `start` function at the beginning of the game. */
    public awake() {
        // Move the tutorial popout to outside the screen
        this._helperPanel.prepare();
        // Reset the top panel animation ratio
        this._topTrayOffsetRatio = 0;
        // Set the panel back to the top of the screen
        this._updateTopTrayHeight();
        // Show the game hud
        this._gameHudContainer.visible = true;
    }

    /** Called at the start of the game. */
    public start() {
        if (!this._hasShownHelper) {
            // If the tutorial popout hasn't been seen yet, show it
            // Add the tween to the pause system
            this.game.systems.get(PauseSystem).addTween(this._helperPanel.show());
            this._hasShownHelper = true;
        }
    }

    /** Animate the top hud element down, in a closing motion */
    public closeHud() {
        // Close the hud
        // Add the tween to the pause system
        return this.game.systems.get(PauseSystem).addTween(
            gsap.to(this, {
                _topTrayOffsetRatio: 1,
                duration: 2,
                ease: 'bounce.out',
                onUpdate: () => {
                    // Force the top tray position to be relative to the animation ratio
                    this._updateTopTrayHeight();
                },
                onComplete: () => {
                    // Hide the game hud to prevent it from being viewed behind the closed hud when the screen fades out
                    this._gameHudContainer.visible = false;
                },
            }),
        );
    }

    /**
     * Update the visuals of the score, both the point toaster and the score counter.
     * @param increment - The value in which the score increases.
     * @param total - The total player score.
     * @param bubble - The bubble that updated the score.
     */
    public updateScore(increment: number, total: number, bubble: Bubble) {
        // Get a point toaster from the pool
        const toaster = pool.get(PointToaster);

        // Position the toaster on the x axis to be the same as the bubble's
        toaster.view.x = bubble.x;
        // Position the toaster on the bounce line
        toaster.view.y = this._laserLine.view.y;
        // Set the tint of the point text to be the same as the bubble
        toaster.tint = boardConfig.bubbleTypeToColor[bubble.type];
        // Add the toaster to the list of toasters
        this._toasterList.push(toaster);
        // Pop up the toaster and assign it score value and a callback for when the animation ends
        // Add the toaster animation to the pause system
        this.game.systems.get(PauseSystem).addTween(toaster.popScore(increment, this._killToaster.bind(this)));
        // Add the toaster to the screen
        this.view.addChild(toaster.view);
        // Update the score counter
        this._scoreCounter.setScore(total);
    }

    /** Animate the visual line on impact */
    public lineImpact() {
        this._laserLine.pulse();
    }

    /**
     * Called every frame.
     * The main update loop of the system, which maintains the shockwave effect over time.
     * @param delta - The time elapsed since the last update.
     */
    public update(delta: number) {
        // Update laser line
        this._laserLine.update(delta);
    }

    /** Resets the state of the system back to its initial state. */
    public reset() {
        // Reset the score back to zero
        this._scoreCounter.setScore(0);

        // Destroy all point toasters
        removeAllFromArray(this._toasterList, (toaster: PointToaster) => {
            toaster.view.removeFromParent();
        });
    }

    /**
     * Resizes the system whenever the window size changes.
     * @param w The new width of the window.
     * @param h The new height of the window.
     */
    public resize(w: number, h: number) {
        this.view.x = w * 0.5;
        this.view.y = h;

        this._height = h;

        // Force the top tray position to be relative to the animation ratio
        this._updateTopTrayHeight();

        // Set the left visual wall to the left boundary
        this._leftBorder.y = -h;
        this._leftBorder.height = h;

        // Set the right visual wall to the right boundary
        this._rightBorder.y = -h;
        this._rightBorder.height = h;

        // Position the score counter
        this._scoreCounter.view.x = designConfig.content.width * 0.5 - this._scoreCounter.view.width - 30;
        this._scoreCounter.view.y = -70;
    }

    /** Updates the height of the top tray based on the current height of the main container. */
    private _updateTopTrayHeight() {
        // Calculate the height of the top tray by subtracting the fixed content height from the window height
        const topTrayHeight = this._height - designConfig.content.height;

        // Set the height of the top tray and its y position
        this._topTray.height = topTrayHeight + this._topTrayOffsetRatio * designConfig.content.height;
        this._topTray.y = -this._height;

        // Reset the scale of the rounded tray
        this._roundedTray.scale.set(1);

        // Calculate the modulus of the top tray height and the rounded tray height
        const mod = this._topTray.height / this._roundedTray.height;

        // Show or hide the rounded tray based on the modulus value
        this._roundedTray.visible = mod > 0.9;
        this._roundedTray.scale.set(Math.min(mod, 1));
        this._roundedTray.y = this._topTray.y + this._topTray.height - this._topTray.height * 0.5;
        this._hiddenTitle.view.y = this._topTray.y + this._topTray.height * 0.5 - 55;
        this._hiddenTitle.view.scale = this._roundedTray.scale.x * 0.85;
    }

    /**
     * Kill a point toaster by removing it from parent and returning it to the pool.
     * @param toaster - The toaster to kill.
     */
    private _killToaster(toaster: PointToaster) {
        // Remove from list of toasters
        removeFromArray(this._toasterList, toaster);
        // Remove from parent
        toaster.view.removeFromParent();
        // Return to pool
        pool.return(PointToaster);
    }
}
