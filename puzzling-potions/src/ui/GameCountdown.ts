import { Container } from 'pixi.js';
import { i18n } from '../utils/i18n';
import { Cloud } from './Cloud';
import { Label } from './Label';
import gsap from 'gsap';
import { registerCustomEase } from '../utils/animation';
import { waitFor } from '../utils/asyncUtils';
import { sfx } from '../utils/audio';

/** Custom ease curve for showing up countdown labels in a way that they slow down in the middle of the animation */
const easeMidSlowMotion = registerCustomEase(
    'M0,0 C0,0 0.023,0.173 0.045,0.276 0.05,0.301 0.058,0.319 0.07,0.34 0.077,0.355 0.085,0.37 0.1,0.375 0.352,0.46 0.586,0.52 0.875,0.612 0.891,0.617 0.904,0.623 0.915,0.634 0.928,0.648 0.936,0.664 0.945,0.683 0.955,0.707 0.96,0.725 0.965,0.751 0.981,0.846 1,1 1,1 ',
);

/**
 * The "Ready... GO!" message that shows up right before gameplay starts, that takes place of
 * a regular "3, 2, 1... GO!" animation, for speed.
 */
export class GameCountdown extends Container {
    /** Inner container for internal animations */
    private container: Container;
    /** The animated cloud background */
    private cloud: Cloud;
    /** The message displaying */
    private messageLabel: Label;

    constructor() {
        super();

        this.container = new Container();
        this.addChild(this.container);

        this.cloud = new Cloud({
            color: 0x0a0025,
            width: 400,
            height: 70,
            circleSize: 100,
        });
        this.container.addChild(this.cloud);

        this.messageLabel = new Label('', {
            fill: 0xffffff,
            fontSize: 70,
        });
        this.container.addChild(this.messageLabel);
        this.visible = false;
    }

    /** Play "Ready?" animation */
    private async playReadyAnimation() {
        sfx.play('common/sfx-countdown.wav', { speed: 0.8, volume: 0.5 });
        gsap.killTweensOf(this.messageLabel);
        gsap.killTweensOf(this.messageLabel.scale);
        this.messageLabel.text = i18n.countdownReady;
        this.messageLabel.scale.set(0);
        this.messageLabel.y = -5;
        await gsap.to(this.messageLabel.scale, {
            x: 1,
            y: 1,
            duration: 0.7,
            ease: 'back.out',
        });
    }

    /** Play "GO!" animation */
    private async playGoAnimation() {
        gsap.killTweensOf(this.messageLabel);
        gsap.killTweensOf(this.messageLabel.scale);
        await gsap.to(this.messageLabel, { alpha: 0, duration: 0.2, ease: 'sine.in' });
        await gsap.to(this.messageLabel.scale, {
            x: 1.5,
            y: 1.5,
            duration: 0.2,
            ease: 'sine.in',
        });
        sfx.play('common/sfx-countdown.wav', { speed: 1.2, volume: 0.5 });
        this.messageLabel.y = 0;
        this.messageLabel.text = i18n.countdownGo;
        this.messageLabel.scale.set(0.8);
        gsap.to(this.messageLabel, { alpha: 1, duration: 0.2, ease: 'linear' });
        gsap.to(this.messageLabel, { alpha: 0, duration: 0.2, ease: 'linear', delay: 0.6 });
        await gsap.to(this.messageLabel.scale, {
            x: 3,
            y: 3,
            duration: 0.8,
            ease: easeMidSlowMotion,
        });
    }

    /** Show up the countdown and play "Ready?" animation */
    public async show() {
        gsap.killTweensOf(this.container.scale);
        gsap.killTweensOf(this.container);
        this.visible = true;
        this.playReadyAnimation();
        await this.cloud.playFormAnimation(0.7);
    }

    /** Play "Go!" animation then hides the countdown */
    public async hide() {
        this.playGoAnimation();
        await waitFor(0.6);
        await this.cloud.playDismissAnimation(0.7);
        this.visible = false;
    }
}
