import gsap from 'gsap';
import { Point } from 'pixi.js';
import { Container, Rectangle } from 'pixi.js';

import { navigation } from '../navigation';
import { ResultScreen } from '../screens/ResultScreen';
import { boardConfig } from './boardConfig';
import { Stats } from './Stats';
import { SystemRunner } from './SystemRunner';
import { AimSystem } from './systems/AimSystem';
import { CannonSystem } from './systems/CannonSystem';
import { EffectsSystem } from './systems/EffectsSystem';
import { HudSystem } from './systems/HudSystem';
import { LevelSystem } from './systems/LevelSystem';
import { PauseSystem } from './systems/PauseSystem';
import { PhysicsSystem } from './systems/PhysicsSystem';
import { PowerSystem } from './systems/PowerSystem';
import { ScoreSystem } from './systems/ScoreSystem';
import { SpaceDecorSystem } from './systems/SpaceDecorSystem';

/** A class that handles all of gameplay based features. */
export class Game {
    /** Container to hold all game visuals. */
    public stage = new Container();
    /** Container to hold gameplay elements like bubbles. */
    public gameContainer = new Container();
    /** Original game container position to use as reset for screen shake effects. */
    public gameContainerPosition = new Point();
    /** Container to handle user interaction. */
    public hitContainer = new Container();
    /** A system manager to handle the common functions found in systems. */
    public systems: SystemRunner;
    /** A class that deals with user specific stats. */
    public stats: Stats;
    /** A flag to determine if the game has reached the "GAMEOVER" state */
    public isGameOver = false;

    /** The hit area to be used by the `hitContainer`. */
    private readonly _hitArea: Rectangle;

    constructor() {
        this.stage.addChild(this.gameContainer);

        // Prepare the container for interaction
        this._hitArea = new Rectangle();

        this.hitContainer.interactive = true;
        this.hitContainer.hitArea = this._hitArea;
        this.gameContainer.addChild(this.hitContainer);

        // Instantiate system runner and pass `this`
        this.systems = new SystemRunner(this);
        // Instantiate stats
        this.stats = new Stats();
    }

    /**
     * Adds views (Containers, Sprites, etc.) to the game container.
     * @param views - The views to add to the game container.
     */
    public addToGame(...views: Container[]) {
        views.forEach((view) => {
            this.gameContainer.addChild(view);
        });
    }

    /**
     * Removes views (Containers, Sprites, etc.) from the game container.
     * @param views - The views to remove from the game container.
     */
    public removeFromGame(...views: Container[]) {
        views.forEach((view) => {
            view.removeFromParent();
        });
    }

    /** Initialisation point of the Game, used to add systems to the game. */
    public init() {
        // Add systems to system runner
        this.systems.add(SpaceDecorSystem);
        this.systems.add(PauseSystem);
        this.systems.add(PhysicsSystem);
        this.systems.add(HudSystem);
        this.systems.add(PowerSystem);
        this.systems.add(LevelSystem);
        this.systems.add(AimSystem);
        this.systems.add(CannonSystem);
        this.systems.add(EffectsSystem);
        this.systems.add(ScoreSystem);

        // Initialise systems
        this.systems.init();
    }

    /** Performs initial setup for the game. */
    public async awake() {
        // Call `awake()` on the systems
        this.systems.awake();
        // Set the game container to be visible
        this.gameContainer.visible = true;
    }

    /** Starts the game logic. */
    public async start() {
        // Call `start()` on the systems.
        this.systems.start();
    }

    /** Handles the end of the game. */
    public async gameOver() {
        // Set game over flag to be true
        this.isGameOver = true;
        // This includes disabling the AimSystem
        this.systems.get(AimSystem).enabled(false);
        // Update the highscore
        this.systems.get(ScoreSystem).updateHighscore();
        // Trigger hud slide down animation the HudSystem
        await this.systems.get(HudSystem).closeHud();
        // Hide the game container to prevent it from being viewed behind the closed hud when the screen fades out
        this.gameContainer.visible = false;
        gsap.delayedCall(1, () => {
            // Navigate to the ResultScreen after a 1 second delay
            // Send all relevant user stats
            navigation.goToScreen(ResultScreen, {
                score: this.stats.get('score'),
                popped: this.stats.get('bubblesPopped'),
                powerups: this.stats.get('powerupsUsed'),
                combo: this.stats.get('bestCombo'),
                highscore: this.stats.get('highscore'),
            });
        });
    }

    /** Ends the game logic. */
    public async end() {
        // Remove listeners on hit container to prevent unwanted interaction
        this.hitContainer.removeAllListeners();
        // Call `end()` on the systems
        this.systems.end();
    }

    /**
     * Called every frame to update the game state
     * This includes updating the systems if the game is not paused or over.
     * @param delta - The time elapsed since the last update.
     */
    public update(delta: number) {
        if (this.systems.get(PauseSystem).isPaused || this.isGameOver) return;
        this.systems.update(delta);
    }

    /** Resets the game to its initial state. */
    public reset() {
        // Set game over flag to be false
        this.isGameOver = false;
        // Reset the user's stats
        this.stats.reset();
        // Call `reset()` on the systems
        this.systems.reset();
    }

    /**
     * Gets called every time the screen resizes.
     * @param w - width of the screen.
     * @param h - height of the screen.
     */
    public resize(w: number, h: number) {
        // Sets game container to the bottom of the screen,
        // since the game should be anchor there
        this.gameContainerPosition.x = w * 0.5;
        this.gameContainerPosition.y = h;

        this.gameContainer.x = this.gameContainerPosition.x;
        this.gameContainer.y = this.gameContainerPosition.y;

        // Offsets the hit area position back to top left of the screen,
        // it then sets the dimensions of the hit area to match the screen dimensions
        // Leave a little room to prevent interaction bellow the cannon
        this._hitArea.x = -w / 2;
        this._hitArea.y = -h;
        this._hitArea.width = w;
        this._hitArea.height = h - boardConfig.bounceLine * 0.75;

        // Call `resize()` on the systems
        this.systems.resize(w, h);
    }
}
