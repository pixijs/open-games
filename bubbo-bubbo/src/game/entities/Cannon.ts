import gsap from 'gsap';
import { Container, Sprite } from 'pixi.js';

import type { BubbleType } from '../boardConfig';
import { boardConfig } from '../boardConfig';
import { BubbleView } from './BubbleView';

/** A class representing the cannon. */
export class Cannon {
    /** The Container instance which contains all the visual elements for this class. */
    public view = new Container();

    /** The view of the current bubble in the cannon. */
    private readonly _bubbleView: BubbleView;
    /** Define the default scale of the bubble, to keep constant values in one place */
    private readonly _defaultBubbleScale = 2.5;
    /** Holds the references to the various cannon parts as Sprite objects. */
    private _parts: Record<string, Sprite> = {};
    /** The type of the current bubble in the cannon. */
    private _type!: BubbleType | 'empty';
    /** The rotation angle of the cannon. */
    private _rotation = 0;

    constructor() {
        // Use a helper function to simplify building the cannon
        this._build();

        // Create a bubble view that acts as an ammunition visualiser
        this._bubbleView = new BubbleView();
        this._bubbleView.view.scale.set(0);
        this.view.addChild(this._bubbleView.view);
    }

    /**
     * Getter for the rotation angle of the cannon.
     */
    public get rotation(): number {
        return this._rotation;
    }

    /**
     * Setter for the rotation angle of the cannon.
     * @param value - The rotation of the cannon.
     */
    public set rotation(value: number) {
        this._rotation = value;
        // Using chain assignment, set the rotation on the relevant sprites
        this._parts['cannon-barrel'].rotation = this._parts['cannon-arrow'].rotation = value;
    }

    /**
     * Setter for the type of the current bubble in the cannon.
     * @param value - The type of the bubble (or "empty" if you want no bubble).
     */
    public set type(value: BubbleType | 'empty') {
        // Hide the bubble
        this._bubbleView.view.scale.set(0);

        // Store the new type
        this._type = value;

        if (value === 'empty') {
            // Force the tint-ables to be white
            this._parts['cannon-arrow'].tint = this._parts['cannon-main'].tint = 0xffffff;

            return;
        }

        // Set the color of the cannon arrow and main body using chain assignment
        this._parts['cannon-arrow'].tint = this._parts['cannon-main'].tint = boardConfig.bubbleTypeToColor[value];
        // Set the type of the current bubble view
        this._bubbleView.type = value;

        // Animate the bubble view in
        gsap.to(this._bubbleView.view.scale, {
            x: this._defaultBubbleScale,
            y: this._defaultBubbleScale,
            duration: 0.4,
            ease: 'back.out',
        });
    }

    /**
     * Getter for the type of the current bubble in the cannon
     */
    public get type(): BubbleType {
        return this._type;
    }

    /**
     * Helper function to build the cannon
     */
    private _build() {
        /**
         * This function loops over the provided ids and creates a sprite for each id
         * @param ids - A list of ids to create sprites for
         */
        const create = (...ids: string[]) => {
            ids.forEach((id: string) => {
                // Create a sprite using the id and set its anchor to 0.5
                const element = Sprite.from(id);

                element.anchor.set(0.5);

                // Add the newly created sprite to the `_parts` object with the id as the key
                this._parts[id] = element;

                // Add the sprite to the view
                this.view.addChild(element);
            });
        };

        // Call the create function with the ids for the cannon parts
        create('cannon-barrel', 'cannon-main', 'cannon-arrow', 'cannon-top');
    }
}
