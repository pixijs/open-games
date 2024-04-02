import { Container } from 'pixi.js';
import { i18n } from '../utils/i18n';
import { Cloud } from './Cloud';
import { Label } from './Label';
import gsap from 'gsap';

/**
 * Time's up animation, after gameplay fully finishes, and also leads the animated
 * transition to the Result screen
 */
export class GameTimesUp extends Container {
    /** Inner container for animation */
    private container: Container;
    /** The animated cloud background */
    private cloud: Cloud;
    /** The displayed message */
    private messageLabel: Label;

    constructor() {
        super();

        this.container = new Container();
        this.addChild(this.container);

        this.cloud = new Cloud({
            color: 0x0a0025,
            width: 500,
            height: 70,
            circleSize: 100,
        });
        this.container.addChild(this.cloud);

        this.messageLabel = new Label(i18n.timesUp, {
            fill: 0xffffff,
            fontSize: 70,
        });
        this.container.addChild(this.messageLabel);
        this.visible = false;
    }

    /** Show the "Time's Up" message */
    public async playRevealAnimation() {
        const duration = 2;

        gsap.killTweensOf(this.container.scale);
        gsap.killTweensOf(this.container);
        gsap.killTweensOf(this.messageLabel);
        this.visible = true;
        this.messageLabel.scale.set(0.5);
        this.messageLabel.alpha = 0;
        gsap.to(this.messageLabel, { alpha: 1, duration, ease: 'linear' });
        gsap.to(this.messageLabel.scale, { x: 1, y: 1, duration, ease: 'expo.out' });
        await this.cloud.playFormAnimation(duration);
    }

    /** Expand the component to cover the entire screen, for transitioning to Result screen */
    public async playExpandAnimation() {
        const duration = 0.5;

        gsap.killTweensOf(this.cloud);
        gsap.killTweensOf(this.cloud.scale);
        gsap.killTweensOf(this.messageLabel.scale);
        gsap.killTweensOf(this.messageLabel);
        gsap.to(this.messageLabel, { alpha: 0, duration, ease: 'linear' });
        gsap.to(this.messageLabel.scale, { x: 5, y: 5, duration, ease: 'expo.in' });
        gsap.to(this.cloud, { height: 1000, duration, ease: 'expo.in' });
        await gsap.to(this.cloud.scale, { x: 9, y: 9, duration, ease: 'expo.in' });
    }
}
