import gsap from 'gsap';
import type { PointData } from 'pixi.js';
import { Container, Graphics } from 'pixi.js';

import { sfx } from '../../audio';
import { randomRange } from '../../utils/maths/rand';
import type { BubbleType } from '../boardConfig';
import { boardConfig } from '../boardConfig';
import { designConfig } from '../designConfig';
import { BubbleView } from './BubbleView';
import { PhysicsBody, PhysicsState } from './PhysicsBody';

/**
 * SpoofBubble class. Used for non-visual basic data storing.
 *
 * Base class for Bubble.
 */
export class SpoofBubble {
    /** Index of the bubble in the x-axis. */
    public i!: number;
    /** Index of the bubble in the y-axis. */
    public j!: number;

    /**
     * Default x position of the bubble.
     * Calculated based on `i` and `boardConfig.bubbleSize`.
     */
    public get defaultX() {
        return (this.i + 1) * (boardConfig.bubbleSize / 2);
    }

    /**
     * Default y position of the bubble.
     * Calculated based on `j` and `boardConfig.bubbleSize`.
     */
    public get defaultY() {
        return -this.j * boardConfig.bubbleSize;
    }
}

/**
 * Unique identifier used by the bubble and physics body.
 * (the bubble and physics body within the bubble use the same identifier).
 */
let UID = 0;

/** A class representing a bubble in the game. */
export class Bubble extends SpoofBubble {
    /** Unique identifier for the bubble. */
    public UID!: number;
    /* The container instance that is the root of all visuals in this class. */
    public view = new Container();
    /** The view of the bubble itself. */
    public bubbleView: BubbleView;
    /** The physics body used to determine position in game space based on a variation of factors. */
    public body = new PhysicsBody();
    /** Drop group identifier for the bubble. */
    public dropGroupId!: number;

    /** The type of the bubble. */
    private _type!: BubbleType;

    constructor() {
        super();

        // Create the bubble view
        this.bubbleView = new BubbleView();
        this.view.addChild(this.bubbleView.view);
    }

    /** Resets the bubble to its initial state. */
    public reset() {
        // Update unique identifier of both bubble and physics body
        this.UID = this.body.UID = UID++;
        // Resets the physics data on the bubble
        this.body.reset();
        // Resets the grid position so it is no longer on the grid
        this.i = this.j = -1;
        // Reset group ID as it no longer belongs to a falling cluster
        this.dropGroupId = 0;

        // Used to debug the visuals of the physics body, only accounts for body radius and centers on bubble view
        if (designConfig.debugBody) {
            this.view.addChild(new Graphics().circle(0, 0, this.body.radius).fill({ color: 0xffffff, alpha: 0.5 }));
        }
    }

    /**
     * Connects the bubble to the board.
     * @param i - Row position in the grid.
     * @param j - Line position in the grid.
     */
    public connect(i: number, j: number) {
        this.i = i;
        this.j = j;
        this.body.state = PhysicsState.STATIC; // Automatically resets physics state as it shouldn't move using physics
    }

    /** Drops the bubble from the board. */
    public drop() {
        // Kill any existing tweens that might have been running on the bubble
        gsap.killTweensOf(this);
        // Set the physics state of the bubble to dynamic to it is effected by basic physics
        this.body.state = PhysicsState.DYNAMIC;
        // Apply a random force to the bubble in x and y direction
        this.body.applyForce(randomRange(-30, 30), randomRange(-20, 0));
    }

    /** Handles the bounce effect of the bubble when it collides with the bottom of the screen. */
    public bounce() {
        // Play the 'bubble-land-sfx' audio with a random speed (which changes pitch)
        sfx.play('audio/bubble-land-sfx.wav', {
            speed: randomRange(0.8, 1.1, false),
        });

        // Set the type of the bubble view to 'glow', which is just visual and has no gameplay effect
        this.bubbleView.type = 'glow';

        // Increment the number of bounces of the bubble's physics body
        this.body.bounces++;

        // Adjust the y position of the bubble to account for its velocity
        this.body.y -= this.body.velocity.y;

        // Set the y velocity of the bubble to the absolute value of its y velocity multiplied by its damping
        this.body.velocity.y = -Math.abs(this.body.velocity.y * this.body.damping);
    }

    /**
     * Handles the impact animation of the bubble when another bubble "collides" with it.
     * @param direction - The x and y direction of the impact animation.
     * @returns - A gsap animation object.
     */
    public impact(direction: PointData) {
        return gsap.to(this.bubbleView.view, {
            x: direction.x,
            y: direction.y,
            duration: 0.075,
            yoyo: true,
            repeat: 1,
        });
    }

    /** Updates the position of the bubble based on its physics body. */
    public update() {
        // Set the x and y position of the bubble view to match the x and y position of its physics body
        this.view.x = this.body.x;
        this.view.y = this.body.y;
    }

    /**
     * Gets the x position of the bubble.
     * @returns - The x position of the bubble.
     */
    public get x(): number {
        return this.body.x;
    }

    /**
     * Sets the x position of the bubble.
     * @param value - The new x position of the bubble.
     */
    public set x(value: number) {
        this.body.x = value;
    }

    /**
     * Gets the y position of the bubble.
     * @returns - The y position of the bubble.
     */
    public get y(): number {
        return this.body.y;
    }

    /**
     * Sets the y position of the bubble.
     * @param value - The new y position of the bubble.
     */
    public set y(value: number) {
        this.body.y = value;
    }

    /**
     * Gets the type of the bubble.
     * @returns - The type of the bubble.
     */
    public get type(): BubbleType {
        return this._type;
    }

    /**
     * Sets the type of the bubble and updates the bubble's visuals.
     * @param value - The new type of the bubble.
     */
    public set type(value: BubbleType) {
        // Store the new type
        this._type = value;
        // Set the type of the bubble view
        this.bubbleView.type = this.type;
    }
}
