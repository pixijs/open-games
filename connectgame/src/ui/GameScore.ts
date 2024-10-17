import { Container } from 'pixi.js';
import { Cloud } from './Cloud';
import { Label } from './Label';
import gsap from 'gsap';
import { throttle } from '../utils/throttle';
import { sfx } from '../utils/audio';

/**
 * The game score that shows during gameplay, with points animation
 */
export class GameScore extends Container {
    /** Inner container for animation */
    private container: Container;
    /** The animated cloud background */
    private cloud: Cloud;
    /** The score number displayed */
    private messageLabel: Label;
    /** Score currently set */
    private points = -1;
    /** Turns false when hidden */
    private showing = true;
    /** Points that will gradually increase until match actual points */
    private animatedPoints = 0;
    /** Increases with the frequence that score is updated, for changing the sfx playback pitch */
    private intensity = 0;

    constructor() {
        super();

        this.container = new Container();
        this.addChild(this.container);

        this.cloud = new Cloud({
            color: 0x2c136c,
            width: 200,
            height: 20,
            circleSize: 50,
        });
        this.container.addChild(this.cloud);

        this.messageLabel = new Label('0', { fill: 0xffffff, fontSize: 30 });
        this.messageLabel.y = 8;
        this.container.addChild(this.messageLabel);
        this.points = 0;
    }

    /** Reset score to 0 */
    public reset() {
        this.points = 0;
        this.messageLabel.text = '0';
    }

    /** Set the score and play the points animation */
    public setScore(value: number) {
        if (this.points === value) return;
        this.points = value;
        this.playPoints();
    }

    /** Show the component */
    public async show(animated = true) {
        if (this.showing) return;
        this.showing = true;
        gsap.killTweensOf(this.container.scale);
        this.visible = true;
        if (animated) {
            this.container.scale.set(0);
            await gsap.to(this.container.scale, { x: 1, y: 1, duration: 0.3, ease: 'back.out' });
        } else {
            this.container.scale.set(1);
        }
    }

    /** Hide the component */
    public async hide(animated = true) {
        if (!this.showing) return;
        this.showing = false;
        gsap.killTweensOf(this.container.scale);
        if (animated) {
            await gsap.to(this.container.scale, { x: 0, y: 0, duration: 0.3, ease: 'back.in' });
        }
        this.visible = false;
    }

    /** Play points animation, increasing gradually until reaches actual score */
    private async playPoints() {
        gsap.killTweensOf(this);
        const diff = this.points - this.animatedPoints;
        await gsap.to(this, {
            intensity: this.intensity + diff,
            animatedPoints: this.points,
            duration: Math.min(diff * 0.025, 2),
            ease: 'linear',
            onUpdate: () => {
                this.printPoints();
            },
        });
        gsap.to(this, {
            intensity: 1,
            duration: 1.5,
            ease: 'expo.in',
        });
    }

    /** Print currently animated points to the screen and play a sound */
    private printPoints() {
        const points = Math.round(this.animatedPoints);
        const text = String(points);
        if (this.messageLabel.text !== text) {
            this.messageLabel.text = text;
            const speed = Math.min(0.8 + this.intensity * 0.001, 2);
            // Throttle sfx to a minimum interval, otherwise too many sounds instances
            // will be played at the same time, making it very noisy
            throttle('score', 100, () => {
                sfx.play('common/sfx-points.wav', { speed, volume: 0.2 });
            });
        }
    }
}
