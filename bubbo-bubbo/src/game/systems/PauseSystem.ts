import { navigation } from '../../navigation';
import { PauseOverlay } from '../../screens/overlays/PauseOverlay';
import { TitleScreen } from '../../screens/TitleScreen';
import { removeFromArray } from '../../utils/utils';
import type { Game } from '../Game';
import type { System } from '../SystemRunner';

/** A type reference defined by both gsap Tweens and Timelines */
export type Tween = gsap.core.Tween | gsap.core.Timeline;

/** A system that handles the pause state of the game. */
export class PauseSystem implements System {
    /** A unique identifier used by the system runner. */
    public static SYSTEM_ID = 'pause';
    /** The instance of the game the system is attached to. */
    public game!: Game;
    /** The game's pause state */
    public isPaused = false;

    /** An array containing all game-based tweens (e.g. bubble grid movement) */
    private readonly _tweenList: Tween[] = [];
    /** A reference to a bound visibility function */
    private _visibilityPauseBound!: () => void;

    /** Called at the start of the game. */
    public start() {
        // Assigns the bound function reference
        this._visibilityPauseBound = this._visibilityPause.bind(this);
        // Add the event listener so the game will pause when it is no longer visible
        document.addEventListener('visibilitychange', this._visibilityPauseBound);
    }

    /**
     * Check each frame if there are any tweens that are completed.
     * If there are, remove them.
     */
    public update() {
        // Only need to check if the game is not paused as the tweens cannot progress if paused
        if (!this.isPaused) {
            this._tweenList.forEach((tween) => {
                // Check if the progress of the tween exceeds `1`
                if (tween.totalProgress() >= 1) {
                    // Remove the tween from the tween list
                    this.removeTween(tween);
                }
            });
        }
    }

    /** Called at the end of the game. */
    public end() {
        // Remove the event listener so it doesn't trigger outside of the game screen.
        document.removeEventListener('visibilitychange', this._visibilityPauseBound);
    }

    /** Resets the state of the system back to its initial state. */
    public reset() {
        // Reset the pause flag to be false
        this.isPaused = false;

        // Kill all tweens in the tween list
        this._tweenList.forEach((tween) => {
            tween.kill();
        });

        // Reset the tween list to be empty
        this._tweenList.length = 0;
    }

    /**
     * Add a tween so it can be paused when the game pauses.
     * @param tween - The tween being added.
     * @returns - The tween being added.
     */
    public addTween(tween: Tween) {
        this._tweenList.push(tween);

        return tween;
    }

    /**
     * Remove a tween so it no longer gets paused when the game pauses.
     * @param tween - The tween being removed.
     * @returns - The tween being removed.
     */
    public removeTween(tween: Tween) {
        removeFromArray(this._tweenList, tween);

        return tween;
    }

    /** Pause the game, which includes pausing all game-based tweens and updating the `isPaused` flag. */
    public pause() {
        // Update the paused flag
        this.isPaused = true;

        // Show the pause overlay on top of the game
        navigation.showOverlay(PauseOverlay, {
            // Send the current score data to the overlay
            score: this.game.stats.get('score'),
            // Send a callback function to help determine user intent
            callback: this._pauseCallback.bind(this),
        });

        // Pause all tweens
        this._tweenList.forEach((tween) => {
            tween.pause();
        });
    }

    /** Resume the game, which includes resuming all game-based tweens and updating the `isPaused` flag. */
    public resume() {
        // Update the paused flag
        this.isPaused = false;

        // Resume all tweens
        this._tweenList.forEach((tween) => {
            tween.resume();
        });
    }

    /** Pause if game visibility is `hidden` */
    private _visibilityPause() {
        if (document.visibilityState !== 'visible') {
            if (!this.isPaused) this.pause();
        }
    }

    /** A callback function to help determine user intent */
    private async _pauseCallback(state: 'quit' | 'resume') {
        // Hide the pause overlay
        await navigation.hideOverlay();

        // Resume the game if that is the intent
        if (state === 'resume') this.resume();
        else {
            // Exit the game if that is the intent
            navigation.goToScreen(TitleScreen);
        }
    }
}
