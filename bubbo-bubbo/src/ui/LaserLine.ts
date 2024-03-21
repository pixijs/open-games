import gsap from 'gsap';
import { Container, NineSliceSprite, Sprite, Texture } from 'pixi.js';

import { designConfig } from '../game/designConfig';

/** Class to render the laser line found in game. */
export class LaserLine {
    /* The container instance that is the root of all visuals in this class. */
    public view = new Container();

    /** The visual line. */
    private readonly _line: NineSliceSprite;
    /** The glowing effect of the line. */
    private readonly _glow: Sprite;
    /** The alpha target for glow effect */
    private _targetAlpha = 1;
    /** The direction in which the alpha value should change. */
    private _alphaDirection = 1;
    /** The speed of the alpha change. */
    private readonly _alphaSpeed = 0.2;
    /** The minimum value the alpha can reach. */
    private readonly _minAlpha = 0.2;
    /** The maximum value the alpha can reach. */
    private readonly _maxAlpha = 0.5;
    /** The alpha value of the pulse effect. */
    private readonly _pulseAlpha = 1;
    /** Whether the line is currently pulsing. */
    private _isPulsing = false;

    constructor() {
        // Create the line visual
        this._line = new NineSliceSprite({ texture: Texture.from('laser-line') });
        this._line.height -= 12;
        this._line.pivot.y = this._line.height * 0.5 - 6;
        this._line.width = designConfig.content.width;

        // Create the glow visual
        this._glow = Sprite.from('laser-line-glow');
        this._glow.anchor.set(0.5);
        this._glow.x = this._line.width * 0.5;
        this.view.addChild(this._glow, this._line);

        this._glow.alpha = 0.25;
    }

    /**
     * Called every frame.
     * @param delta - The time elapsed since the last update.
     */
    public update(delta: number) {
        // If pulsing from tween, return to prevent animation mismatch
        if (this._isPulsing) return;

        // Updates the glow's alpha value based on the elapsed time and
        this._targetAlpha += (delta / 60) * (this._alphaDirection * this._alphaSpeed);

        // If target alpha is lower than the minimum or greater than maximum, reverse the alpha direction
        if (this._targetAlpha <= this._minAlpha) {
            this._targetAlpha = this._minAlpha;
            this._alphaDirection = 1;
        } else if (this._targetAlpha >= this._maxAlpha) {
            this._targetAlpha = this._maxAlpha;
            this._alphaDirection = -1;
        }

        // Assign target glow alpha to glow sprite
        this._glow.alpha = this._targetAlpha;
    }

    /**
     * Animate a pulsing effect
     */
    public pulse() {
        // Update the flag to prevent the update animation overwriting this one
        this._isPulsing = true;

        // Set the glow sprite's alpha to the pulse alpha
        this._glow.alpha = this._pulseAlpha;

        // Kill tweens of glow sprite
        gsap.killTweensOf(this._glow);

        // Fade alpha back to original value before pulsing
        gsap.to(this._glow, {
            alpha: this._targetAlpha,
            delay: 0.2,
            onComplete: () => {
                // On complete, allow update function to take over glow alpha animation
                this._isPulsing = false;
            },
        });
    }
}
