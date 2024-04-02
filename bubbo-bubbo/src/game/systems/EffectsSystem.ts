import { ShockwaveFilter } from 'pixi-filters/shockwave';

import { sfx } from '../../audio';
import { randomRange } from '../../utils/maths/rand';
import { designConfig } from '../designConfig';
import type { Game } from '../Game';
import type { System } from '../SystemRunner';

/** A system that handles special effects like filters in the game. */
export class EffectsSystem implements System {
    /**
     * A unique identifier used by the system runner.
     * The identifier is used by the runner to differentiate between different systems.
     */
    public static SYSTEM_ID = 'effects';
    /**
     * The instance of the game the system is attached to.
     * This is automatically set by the system runner when the system is added to the game.
     */
    public game!: Game;
    /** The shockwave filter that is used to apply the shockwave effect to the game container. */
    public shockwaveFilter = new ShockwaveFilter();

    /** A flag that indicates whether the shockwave effect is currently active. */
    private _activeShockwave = false;
    /** The speed modification for the shockwave effect. */
    private _shockwaveSpeedMod = 1;
    /** The intensity of the shockwave effect. */
    private _shockIntensity!: number;

    /**
     * Activates the shockwave effect.
     * @param x The x-coordinate of the shockwave's center.
     * @param y The y-coordinate of the shockwave's center.
     * @param intense Indicates whether the effect should be intense (default: false).
     */
    public shockwave(x: number, y: number, intense = false) {
        const { shockwaveFilter } = this;

        this._activeShockwave = true;

        // Apply the shockwave filter to the game container
        this.game.gameContainer.filters = [shockwaveFilter];

        // Set the center of the shockwave filter to the specified x and y coordinates
        shockwaveFilter.center = {
            x: designConfig.content.width * 0.5 + x,
            y: designConfig.content.height + y,
        };

        // Reset the time property of the shockwave filter
        this.shockwaveFilter.time = 0;

        // Set the shockwave intensity based on the "intense" parameter
        this._shockIntensity = intense ? 10 : 5;

        // Play the sound effect for the shockwave. It's pitch is determined by whether or not it is intense
        sfx.play('audio/bubbles-falling.wav', {
            speed: intense ? 0.7 : randomRange(1, 1.25, false),
        });

        // If the effect is not intense, set the shockwave filter's properties to the corresponding values
        if (!intense) {
            shockwaveFilter.radius = 100;
            shockwaveFilter.wavelength = 55;
            this._shockwaveSpeedMod = 0.75;

            return;
        }

        // If it is intense, set the shockwave filter's properties to the corresponding values

        shockwaveFilter.radius = 300;
        shockwaveFilter.wavelength = 140;
        this._shockwaveSpeedMod = 1;
    }

    /**
     * Stops the shockwave effect that is currently active.
     */
    public stopShockwave() {
        this._activeShockwave = false;

        // Remove any filters from the game container
        this.game.gameContainer.filters = [];

        // Set the game container position back to its original position
        this.game.gameContainer.x = this.game.gameContainerPosition.x;
        this.game.gameContainer.y = this.game.gameContainerPosition.y;
    }

    /**
     * Called every frame.
     * The main update loop of the system, which maintains the shockwave effect over time.
     * @param delta - The time elapsed since the last update.
     */
    public update(delta: number) {
        if (!this._activeShockwave) return;

        // Update the position of the game container to simulate screen shake.
        this.game.gameContainer.x = this.game.gameContainerPosition.x + Math.random() * this._shockIntensity;
        this.game.gameContainer.y = this.game.gameContainerPosition.y + Math.random() * this._shockIntensity;

        // Stop the shockwave effect if the time has exceeded a certain threshold.
        if (this.shockwaveFilter.time > 0.4) this.stopShockwave();
        // Update shockwave over time
        else this.shockwaveFilter.time += (delta / 60) * this._shockwaveSpeedMod;
    }

    /** Resets the state of the system back to its initial state. */
    public reset() {
        // End the shockwave animation
        this.stopShockwave();
    }
}
