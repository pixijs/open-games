import gsap from 'gsap';
import { Container, Sprite } from 'pixi.js';

import type { BubbleType } from '../boardConfig';
import { boardConfig } from '../boardConfig';
import { BubbleView } from './BubbleView';

/**
 * This class represents the BubbleReserve.
 * It holds the BubbleView instance which is the next bubble that will be shot from the cannon.
 */
export class BubbleReserve {
    /** The Container instance which contains all the visual elements for this class. */
    public view = new Container();

    /** An instance of the BubbleView class, representing the next bubble that will be shot from the cannon. */
    private _bubbleView: BubbleView;
    /** Define the default scale of the bubble, to keep constant values in one place */
    private readonly _defaultBubbleScale = 2;
    /** The type of the bubble. */
    private _type!: BubbleType | 'empty';
    /** The visual base of the reserve, which contains the bubble view */
    private _base: Sprite;

    constructor() {
        const baseWrapper = new Container();
        baseWrapper.scale.set(0.9);
        this.view.addChild(baseWrapper);

        // Create a sprite instance from the "bubble-reserve-base" texture.
        this._base = Sprite.from('bubble-reserve-base');
        // Set the anchor point and scale of the base.
        this._base.anchor.set(0.5);
        baseWrapper.addChild(this._base);

        const ringWrapper = new Container();
        ringWrapper.scale = 0.85;
        ringWrapper.y -= 2;
        baseWrapper.addChild(ringWrapper);

        const ring = Sprite.from('bubble-reserve-ring');
        // Set the anchor point and scale of the base to be less than the base.
        // Move two pixels to offset the shadow
        ring.anchor.set(0.5);
        ringWrapper.addChild(ring);

        // Create the bubble view to represent the next shot for the cannon
        this._bubbleView = new BubbleView();
        this._bubbleView.view.scale.set(0);
        ringWrapper.addChild(this._bubbleView.view);
    }

    /**
     * Gets the type of the bubble.
     * @returns - The type of the bubble.
     */
    public get type(): BubbleType {
        return this._type;
    }

    /**
     * Setter for the type of the bubble.
     * It updates the texture, tint, and visibility of the sprite and shadow based on the new type.
     * @param value - The type of the bubble (or "empty" if you want no bubble).
     */
    public set type(value: BubbleType | 'empty') {
        // Hide the bubble
        this._bubbleView.view.scale.set(0);

        // Store the new type
        this._type = value;

        if (value === 'empty') {
            // Force the tint to be white
            this._base.tint = 0xffffff;

            return;
        }

        // Set the type of the BubbleView instance.
        this._bubbleView.type = value;
        // Set the tint color of the base sprite based on the type of the bubble.
        this._base.tint = boardConfig.bubbleTypeToColor[value];

        // Animate the bubble view in
        gsap.to(this._bubbleView.view.scale, {
            x: this._defaultBubbleScale,
            y: this._defaultBubbleScale,
            duration: 0.4,
            ease: 'back.out',
        });
    }
}
