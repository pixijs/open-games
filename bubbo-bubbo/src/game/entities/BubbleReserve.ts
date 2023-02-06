import { Container, Sprite } from 'pixi.js';

import type { BubbleType } from '../boardConfig';
import { boardConfig } from '../boardConfig';
import { BubbleView } from './BubbleView';

/**
 * This class represents the BubbleReserve.
 * It holds the BubbleView instance which is the next bubble that will be shot from the cannon.
 */
export class BubbleReserve
{
    /** The Container instance which contains all the visual elements for this class. */
    public view = new Container();
    /** An instance of the BubbleView class, representing the next bubble that will be shot from the cannon. */
    public bubbleView: BubbleView;
    
    /** The type of the bubble. */
    private _type!: BubbleType;
    /** The visual base of the reserve, which contains the bubble view */
    private _base: Sprite;

    constructor()
    {
        // Create a sprite instance from the "bubble-reserve-base" texture.
        this._base = Sprite.from('bubble-reserve-base');

        // Set the anchor point and scale of the base.
        this._base.anchor.set(0.5);
        this._base.scale.set(0.9);

        this.view.addChild(this._base);
        
        const ring = Sprite.from('bubble-reserve-ring');

        // Set the anchor point and scale of the base to be less than the base.
        // Move two pixels to offset the shadow
        ring.anchor.set(0.5);
        ring.scale.set(0.85);
        ring.y -= 2;
        this._base.addChild(ring);

        // Create the bubble view to represent the next shot for the cannon
        this.bubbleView = new BubbleView();
        this.bubbleView.view.scale.set(2);
        ring.addChild(this.bubbleView.view);
    }

    /**
     * Gets the type of the bubble.
     * @returns - The type of the bubble.
     */
    public get type(): BubbleType
    {
        return this._type;
    }

    /**
     * Setter for the type of the bubble.
     * It updates the texture, tint, and visibility of the sprite and shadow based on the new type.
     * @param value - The type of the bubble (or "glow").
     */
    public set type(value: BubbleType)
    {
        // Store the new type
        this._type = value;
        // Set the type of the BubbleView instance.
        this.bubbleView.type = value;
        // Set the tint color of the base sprite based on the type of the bubble.
        this._base.tint = boardConfig.bubbleTypeToColor[value];
    }
}