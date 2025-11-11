import gsap from 'gsap';
import { Container, Text } from 'pixi.js';

import { designConfig } from '../game/designConfig';
import { randomRange } from '../utils/maths/rand';

/**
 * The PointToaster class is used to display and animate a score that pops up on the screen.
 */
export class PointToaster {
    /* The container instance that is the root of all visuals in this class */
    public view = new Container();

    private readonly _pointText: Text;

    /** The font fill color for the text */
    private _tint: number;

    constructor() {
        this._tint = 0xffffff;

        // Create score text
        this._pointText = new Text({
            style: {
                fontSize: 40,
                fontWeight: '900',
                fontFamily: 'Bungee-Regular',
                fill: this._tint,
                stroke: {
                    color: 0x000000,
                    width: 3,
                },
                align: 'center',
            },
        });

        this._pointText.anchor.set(0.5);

        this.view.addChild(this._pointText);
    }

    /**
     * Displays and animates the score.
     * @param score The score to display.
     * @param onComplete The callback function to call after the animation is complete.
     * @returns The GSAP animation timeline.
     */
    public popScore(score: number, onComplete: (toaster: this) => void) {
        // Hide score
        this.view.alpha = 0;

        // Update score value
        this._pointText.text = score;

        // Determine the edge distance of the wall, based on game wall position and text width
        const wallEdge = designConfig.content.width * 0.5 - this._pointText.width * 0.5;

        // Prevent score view from going off screen
        this.view.x = Math.min(Math.max(this.view.x, -wallEdge), wallEdge);

        // Animate score up to a random point on screen between two values
        return gsap.to(this.view, {
            y: this.view.y - randomRange(15, 120),
            alpha: 1,
            duration: 0.25,
            onComplete: () => {
                // On movement complete, fade out and call callback function
                gsap.to(this.view, { alpha: 0, onComplete: () => onComplete?.(this) });
            },
        });
    }

    /**
     * Gets the tint color of the score Text.
     */
    public get tint(): number {
        return this._tint;
    }

    /**
     * Sets the font fill color of the score Text.
     * @param value - Tint color.
     */
    public set tint(value: number) {
        // Store tint
        this._tint = value;

        // Update font color
        this._pointText.style.fill = value ?? 0xffffff;
    }
}
