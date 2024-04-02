import gsap from 'gsap';
import { Container, Graphics, Texture, TilingSprite } from 'pixi.js';

import { randomType } from '../game/boardConfig';
import { BubbleView } from '../game/entities/BubbleView';
import { randomRange } from '../utils/maths/rand';

/**
 * Options passed into the Porthole class.
 */
interface PortholeOptions {
    /** Color of the frame. */
    frameColor: number;
    /** Width of the outer frame. */
    frameWidth: number;
    /** Size of the entire view. */
    size: number;
}

/**
 * Class to render the porthole decals found on multiple screens
 */
export class Porthole {
    /** Default options to be overwritten with custom options if need be. */
    public static DEFAULT_OPTIONS: PortholeOptions = {
        /** Color of the frame. */
        frameColor: 0x767676,
        /** Width of the outer frame. */
        frameWidth: 10,
        /** Size of the entire view. */
        size: 60,
    };

    /* The container instance that is the root of all visuals in this class. */
    public view = new Container();

    /** The outer frame of the porthole. */
    private readonly _frame: Graphics;
    /** The container for the content behind the frame - grouped for masking */
    public readonly _portView = new Container();
    /** For the background behind the bubbles. */
    private readonly _background: TilingSprite;
    /** Mask that shapes the background and hides anything outside of the given size. */
    private readonly _mask: Graphics;
    /** The view of the bubble itself. */
    private readonly _bubble: BubbleView;

    /** Radius of the porthole. */
    private readonly _radius: number;
    /** Track if a bubble has been set or not */
    private _isBubbleSet = false;

    /**
     * @param options An object with properties for customizing the porthole appearance.
     */
    constructor(options?: PortholeOptions) {
        // Set the options to the default options or the provided options if any
        options = { ...Porthole.DEFAULT_OPTIONS, ...options };

        // Create the frame of the porthole
        this._frame = new Graphics()
            .circle(0, 0, options.size + options.frameWidth) // draw the frame as a circle
            .fill({ color: options.frameColor }); // fill the drawn circle with the frame color

        this.view.addChild(this._frame);

        // Create the tiling sprite for the background
        this._background = new TilingSprite({
            texture: Texture.from('background-tile-space'),
            width: 64,
            height: 64,
            anchor: { x: 0.5, y: 0.5 },
        });

        // Set the width and height of the background to be equal to the size of the porthole
        this._background.width = this._background.height = options.size * 2;
        this._portView.addChild(this._background);

        // create the bubble view
        this._bubble = new BubbleView();
        this._portView.addChild(this._bubble.view);

        // create the mask for shaping the port view
        this._mask = new Graphics().circle(0, 0, options.size).fill({ color: options.frameColor });
        this.view.addChild(this._mask); // add the mask to the view

        // Mask the port view and add to the main view
        this._portView.mask = this._mask;
        this.view.addChild(this._portView);

        // Assign value to radius
        this._radius = this._frame.width * 0.5;
    }

    /**
     * Position bubbles to prepare for the animation of the bubbles.
     */
    public start() {
        this._setBubble();
    }

    /**
     * Stop the animation of the bubbles.
     */
    public stop() {
        // Reset bubble position so it can no longer be in the middle of the view
        this._setBubble();
        // Kill the tweens of the bubble's view
        gsap.killTweensOf(this._bubble.view);
    }

    /**
     * Sets the bubble with a random position on the circumference of the circle, as well as random attributes.
     */
    private _setBubble() {
        this._isBubbleSet = true;
        // Set random scale between 0.5 and 1
        this._bubble.view.scale.set(randomRange(0.5, 1, false));

        // Assign random type to the bubble
        this._bubble.type = randomType();

        // Calculate a random angle in radians
        const angle = Math.random() * Math.PI * 2;

        // Calculate the radius with a bubble's width as a factor
        const radius = this._radius + this._bubble.view.width * 0.5;

        // Set x position of bubble on the circumference of the circle using cosine
        this._bubble.view.x = Math.cos(angle) * radius;
        // Set y position of bubble on the circumference of the circle using sine
        this._bubble.view.y = Math.sin(angle) * radius;

        // Schedule a delayed call to the _moveBubble method after a random delay between 3 and 6 seconds
        gsap.delayedCall(randomRange(3, 6), this._moveBubble.bind(this));
    }

    /**
     * Moves the bubble to a new random position on the circumference of the circle
     */
    private _moveBubble() {
        // If the bubble is not set, return from the method
        if (!this._isBubbleSet) return;

        this._isBubbleSet = false;

        // Calculate a random offset within 33% of Pi to make sure the bubble moves to the opposite side of the porthole
        const offset = randomRange(-Math.PI * 0.33, Math.PI * 0.33, false);
        // Calculate a new angle for the bubble
        const angle = Math.atan2(this._bubble.view.y, this._bubble.view.x) + offset;
        // Calculate the radius with a bubble's width as a factor
        const radius = this._radius + this._bubble.view.width * 0.5;
        // Calculate new x position of bubble
        const x = -radius * Math.cos(angle);
        // Calculate new y position of bubble
        const y = -radius * Math.sin(angle);

        // Animate the bubble to the new x, y position with a random duration between 2 and 5 seconds
        gsap.to(this._bubble.view, {
            x,
            y,
            duration: randomRange(2, 5),
            ease: 'none',
            // Once animation is complete, call the _setBubble method again to reset the animation loop
            onComplete: this._setBubble.bind(this),
        });
    }
}
