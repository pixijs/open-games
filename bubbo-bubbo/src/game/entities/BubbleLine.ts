import { boardConfig } from '../boardConfig';
import type { Game } from '../Game';
import { PhysicsSystem } from '../systems/PhysicsSystem';
import type { Bubble } from './Bubble';

/** The maximum bubble index that can be assigned to a bubble. */
export const MAX_BUBBLE_INDEX = 2 * boardConfig.bubblesPerLine - 2;

/** A class representing a line of bubbles. Used to organise bubbles into rows. */
export class BubbleLine {
    /** The index to determine the line's position within the main grid. */
    public j!: number;
    /** Whether the line is even or odd. Which determines the line structure. */
    public isEven!: boolean;
    /**
     * An array containing the bubbles of the line.
     * Every other index is empty
     */
    public bubbles: (Bubble | undefined)[] = new Array(MAX_BUBBLE_INDEX + 1);
    /** The number of bubbles in the line. */
    public bubbleCount!: number;
    public game!: Game;

    /** The y-position of the line in game space. */
    private _y!: number;

    /**
     * Initializes the bubble line.
     * @param j - The line number (index).
     * @param game - The game instance.
     * @param isEven - Whether the line is even or odd.
     */
    public init(j: number, game: Game, isEven: boolean) {
        this.j = j;
        this.isEven = isEven;
        this.bubbleCount = 0;
        this.game = game;

        // Reset the bubbles array to be empty, but with the correct length
        this.bubbles.length = MAX_BUBBLE_INDEX + 1;
    }

    /** The y-position of the line in game space. */
    public get y() {
        return this._y;
    }

    /**
     * The y-position of the line in game space.
     * and updates the y-position of all the bubbles in the line.
     */
    public set y(value: number) {
        this._y = value;

        // Update the y-position of all bubbles in the line
        this.bubbles.forEach((bubble) => {
            if (bubble) bubble.y = this.y;
        });
    }

    /**
     * Adds a bubble to the line.
     * @param bubble - The bubble to add.
     * @param x - The x-position of the bubble.
     */
    public addBubble(bubble: Bubble, x: number) {
        bubble.x = x;
        bubble.y = this.y;

        if (this.bubbles[bubble.i] === undefined) this.bubbleCount += 1;
        this.bubbles[bubble.i] = bubble;

        // Add a physics body to the bubble
        this.game.systems.get(PhysicsSystem).addBody(bubble.body);

        /**
         * This error is triggered when the number of bubbles in the line becomes too high, which shouldn't happen under normal circumstances.
         * It could indicate a problem with the game logic or the configuration of boardConfig.
         */
        if (this.bubbleCount > boardConfig.bubblesPerLine) {
            console.error('Number of bubble is too high!');
        }
    }

    /**
     * Updates the vertical position of the BubbleLine based on the given ratio parameter.
     * @param ratio - The ratio of the position between `0` and `1`.
     */
    public updatePosRatio(ratio = 1) {
        // Previous grid position
        const previousPos = boardConfig.screenTop + (this.j - 1) * boardConfig.bubbleSize;
        // Current grid position
        const newPos = boardConfig.screenTop + this.j * boardConfig.bubbleSize;

        // Position between two positions based on the given ratio
        const position = (newPos - previousPos) * ratio + previousPos;

        // Update this y position
        this.y = position;
    }

    /**
     * Returns `true` if there is a bubble at the given `i` index and `false` otherwise.
     * @param i - The index to check for a bubble.
     * @returns Whether there is a bubble at the given index.
     */
    public hasBubbleAt(i: number) {
        return this.bubbles[i] !== undefined;
    }

    /**
     * Returns the Bubble at the given `i` index, or `undefined` if there is no bubble at that index.
     * @param i - The index to check for a bubble.
     * @returns The bubble at the given index, or undefined if there is no bubble.
     */
    public getBubbleAt(i: number) {
        return this.bubbles[i];
    }

    /**
     * Removes the given bubble from the line, and decrements the count of bubbles in the line.
     * @param bubble - The bubble that is to be removed.
     * @param drop - If the bubble is dropped to become a dynamic entity, or to just be destroyed
     */
    public removeBubble(bubble: Bubble, drop = true) {
        // Empty the array at the bubble index
        this.bubbles[bubble.i] = undefined;

        // Reduce bubble count
        this.bubbleCount -= 1;

        /**
         * This error is triggered when the number of bubbles in the line becomes negative, which shouldn't happen under normal circumstances.
         * It could indicate a problem with the game logic or the configuration of boardConfig.
         */
        if (this.bubbleCount < 0) {
            console.error('Number of bubble is too low!');
        }

        if (drop) {
            // Drop the bubble to become a dynamic entity
            bubble.drop();
        }
    }
}
