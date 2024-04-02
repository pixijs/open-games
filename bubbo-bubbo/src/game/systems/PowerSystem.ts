import gsap from 'gsap';
import { Signal } from 'typed-signals';

import { sfx } from '../../audio';
import { boardConfig, isSpecialType, SpecialBubbleType } from '../boardConfig';
import type { Game } from '../Game';
import type { System } from '../SystemRunner';
import { LevelSystem } from './LevelSystem';
import { PauseSystem } from './PauseSystem';

/** The PowerSystem is responsible for handling powers in the game. */
export class PowerSystem implements System {
    /**
     * A unique identifier used by the system runner.
     * The identifier is used by the runner to differentiate between different systems.
     */
    public static SYSTEM_ID = 'power';
    /**
     * The instance of the game the system is attached to.
     * This is automatically set by the system runner when the system is added to the game.
     */
    public game!: Game;

    public signals = {
        /**
         * Emitted when a power is used.
         * @param power - The type of power being used
         * @param hasEnded - Whether the power is at its start state or end state
         */
        onPowerUsed: new Signal<(power: SpecialBubbleType, hasEnded: boolean) => void>(),
    };

    /**
     * Start a power-up effect based on the provided power type.
     * @param power - The type of power to use.
     * @param i - The row index of the power.
     * @param j - The column index of the power.
     */
    public usePower(power: SpecialBubbleType, i: number, j: number) {
        switch (power) {
            case 'super':
                this._super(j);
                break;
            case 'bomb':
                this._bomb(i, j);
                break;
            case 'timer':
                this._timer();
                break;
        }

        // Emit the onPowerUsed signal.
        this.signals.onPowerUsed.emit(power, false);
        // Increment the powers used stat.
        this.game.stats.increment('powerupsUsed');
    }

    /**
     * Use the super power. It removes all bubbles in a given line.
     * @param j - The column index of the power.
     */
    private _super(j: number) {
        // Get the LevelSystem.
        const level = this.game.systems.get(LevelSystem);
        // Get the grid line of the power.
        const line = level.lines[j];

        // Play the audio for the super power.
        sfx.play('audio/powerup-super.wav');

        // Remove all bubbles in the line.
        line.bubbles.forEach(async (bubble) => {
            if (!bubble) return;

            // Remove the bubble, considering whether it's a special bubble type.
            await level.removeBubble(bubble, !isSpecialType(bubble.type));
        });
    }

    /**
     * This function is called when the 'bomb' power is used.
     * It removes bubbles that are within two units away from the selected bubble (i, j).
     * @param i - The row index of the power.
     * @param j - The column index of the power.
     */
    private _bomb(i: number, j: number) {
        // Get the LevelSystem instance
        const level = this.game.systems.get(LevelSystem);

        // Play the 'powerup-bomb' sound effect
        sfx.play('audio/powerup-bomb.wav');

        // Loop through all the bubbles that are up to two units away from the selected bubble
        level.getNeighbours(i, j, boardConfig.power.blastRadius)?.forEach(async (bubble) => {
            // Remove the bubble
            await level.removeBubble(bubble, true);
        });
    }

    /**
     * This function is called when the 'timer' power is used.
     * It pauses the level generation for a small period of time.
     */
    private _timer() {
        // Play the 'powerup-time' sound effect
        sfx.play('audio/powerup-time.wav');

        // Use the `gsap.delayedCall` function to add a 5 second delay before emitting the signal to state the power effect has ended
        // Add the tween to the pause system
        this.game.systems.get(PauseSystem).addTween(
            gsap.delayedCall(boardConfig.power.timerFreezeTime, () => {
                // Emit the 'timer' power used signal
                this.signals.onPowerUsed.emit('timer', true);
            }),
        );
    }
}
