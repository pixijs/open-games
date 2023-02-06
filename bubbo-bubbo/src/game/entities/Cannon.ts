import { Container, Sprite } from 'pixi.js';

import type { BubbleType } from '../boardConfig';
import { boardConfig } from '../boardConfig';
import { BubbleView } from './BubbleView';

/** A class representing the cannon. */
export class Cannon
{
    /** The Container instance which contains all the visual elements for this class. */
    public view = new Container();

    /** Holds the references to the various cannon parts as Sprite objects. */
    private _parts: Record<string, Sprite> = {};
    /** The type of the current bubble in the cannon. */
    private _type!: BubbleType;
    /** The rotation angle of the cannon. */
    private _rotation = 0;
    /** The view of the current bubble in the cannon. */
    private readonly _currentBubble: BubbleView;

    constructor()
    {
        // Use a helper function to simplify building the cannon
        this._build();

        // Create a bubble view that acts as an ammunition visualiser
        this._currentBubble = new BubbleView();
        this._currentBubble.view.scale.set(2.5);
        this.view.addChild(this._currentBubble.view);
    }

    /**
     * Getter for the rotation angle of the cannon.
     */
    public get rotation(): number
    {
        return this._rotation;
    }

    /**
     * Setter for the rotation angle of the cannon.
     * @param value - The rotation of the cannon.
     */
    public set rotation(value: number)
    {
        this._rotation = value;
        // Using chain assignment, set the rotation on the relevant sprites
        this._parts['cannon-barrel'].rotation = this._parts['cannon-arrow'].rotation = value;
    }

    /**
     * Setter for the type of the current bubble in the cannon.
     * @param type - The type of the bubble.
     */
    public set type(value: BubbleType)
    {
        // If the new type is the same as the old type, return
        if (value === this._type) return;

        // Set the color of the cannon arrow and main body using chain assignment
        this._parts['cannon-arrow'].tint = this._parts['cannon-main'].tint = boardConfig.bubbleTypeToColor[value];
        // Set the type of the current bubble view
        this._currentBubble.type = value;
        // Store the new type
        this._type = value;
    }

    /**
     * Getter for the type of the current bubble in the cannon
     */
    public get type(): BubbleType
    {
        return this._type;
    }

    /**
     * Helper function to build the cannon
     */
    private _build()
    {
        /**
         * This function loops over the provided ids and creates a sprite for each id
         * @param ids - A list of ids to create sprites for
         */
        const create = (...ids: string[]) =>
        {
            ids.forEach((id: string) =>
            {
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