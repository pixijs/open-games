import gsap from 'gsap';
import { Container, Sprite, Texture } from 'pixi.js';

import type { BubbleType } from '../boardConfig';
import { boardConfig } from '../boardConfig';

/**
 * BubbleView is a class that represents the view of a bubble in the game.
 */
export class BubbleView {
    /** The Container instance which contains all the visual elements for this class. */
    public view = new Container();

    /** The sprite for the shadow of the bubble. */
    private readonly _shadow: Sprite;
    /** The sprite for the bubble itself. */
    private readonly _sprite: Sprite;
    /** The sprite for the shine effect. */
    private readonly _shine: Sprite;
    /** The type of the bubble. */
    private _type!: BubbleType;
    /** The timeline for the shimmer animation. */
    private readonly _shimmerTimeline: gsap.core.Timeline;

    /**
     * @param type - The type of the bubble.
     */
    constructor(type?: BubbleType) {
        // Initialize the sprite for the bubble
        this._sprite = type ? Sprite.from(`bubble-${type}`) : new Sprite(Texture.WHITE);
        this._sprite.anchor.set(0.5);
        this._sprite.width = boardConfig.bubbleSize;
        this._sprite.height = boardConfig.bubbleSize;

        // Initialize the sprite for the shadow
        this._shadow = Sprite.from(`bubble-shadow`);
        this._shadow.anchor.set(0.5);
        this._shadow.tint = 0xffffff;
        this._shadow.visible = !!type;
        this._shadow.width = this._sprite.width * 1.1;
        this._shadow.height = this._sprite.height * 1.1;
        this._shadow.y = (this._shadow.height - this._sprite.height) * 1.5;

        // Make the sprite for the bubble visible only if a type is provided
        this._sprite.visible = !!type;
        this._shadow.visible = !!type;

        // Initialize the sprite for the shine effect
        this._shine = Sprite.from('bubble-shine');
        this._shine.anchor.set(0.5);
        this._shine.width = this._sprite.width;
        this._shine.height = this._sprite.height;
        this._shine.alpha = 0;
        this._shine.visible = false;

        // Add the shadow, the sprite and the shine to the root container
        this.view.addChild(this._shadow, this._sprite, this._shine);

        // Set the duration for the shimmer animation
        const duration = 0.1;

        // Initialize the shimmer animation timeline
        this._shimmerTimeline = gsap
            .timeline({ paused: true })
            // Reset rotation and alpha of shine sprite
            .set(this._shine, { rotation: 0, alpha: 0 })
            // Animate around half a circle
            .to(this._shine, {
                rotation: Math.PI,
                ease: 'power3.out',
                duration,
            })
            // Fade alpha in then out
            .to(
                this._shine,
                {
                    alpha: 1,
                    yoyo: true,
                    repeat: 1,
                    onComplete: () => {
                        this._shine.visible = false;
                    },
                    duration: duration * 0.6,
                },
                '<',
            ); // '<' used to start this tween at the same point as the previous one

        // If the type argument is provided, then it sets the type of the bubble
        if (type) this.type = type;
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
     * @param value - The type of the bubble (or "glow").
     */
    public set type(value: BubbleType | 'glow') {
        // Store the new type
        this._type = value;

        // Update the texture of the sprite based on the new type
        this._sprite.texture = Texture.from(`bubble-${this._type}`);

        // TODO: Resolve sizing issue when setting size on Texture.WHITE Sprite before setting texture
        this._sprite.width = boardConfig.bubbleSize;
        this._sprite.height = boardConfig.bubbleSize;

        // Update the tint of the shadow based on the new type
        this._shadow.tint = boardConfig.bubbleTypeToColor[value] ?? 0x606060;

        // Make the sprite and shadow visible
        this._sprite.visible = true;
        this._shadow.visible = value !== 'glow';
    }

    /** This function starts the shimmer effect. */
    public shimmer() {
        // Reset the rotation and alpha values of the shine sprite, and also make it visible
        this._shine.rotation = 0;
        this._shine.alpha = 0;
        this._shine.visible = true;

        // Play the shimmer timeline at its starting point
        return this._shimmerTimeline.play(0);
    }
}
