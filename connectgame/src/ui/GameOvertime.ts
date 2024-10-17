import { Container, Sprite, Texture } from 'pixi.js';
import { i18n } from '../utils/i18n';
import { Label } from './Label';
import gsap from 'gsap';
import { app } from '../main';
import { sfx } from '../utils/audio';

/**
 * Shows up when the game is 5 seconds to finish, with a countdown 5 to 1,
 * then shows a "Finished" message while the grid takes its time to complete processing
 */
export class GameOvertime extends Container {
    /** Label for the seconds left */
    private labelNum: Label;
    /** Label for the final message */
    private labelOver: Label;
    /** Number stroke sprites, for animation */
    private stroke: Sprite;

    constructor() {
        super();

        this.labelNum = new Label('', { fontSize: 230, fill: 0xffffff });
        this.labelNum.y = -8;
        this.addChild(this.labelNum);

        this.labelOver = new Label(i18n.overtime, {
            fontSize: 70,
            fill: 0xffffff,
            fontWeight: 'bold',
        });
        this.labelOver.y = -8;
        this.addChild(this.labelOver);

        this.stroke = new Sprite();
        this.stroke.anchor.set(0.5);
        this.addChild(this.stroke);

        this.alpha = 0.4;
        this.visible = false;
    }

    /** Play a number animation */
    private async playNumber(num: number) {
        this.labelOver.visible = false;
        this.labelNum.visible = true;
        this.stroke.visible = true;
        const str = String(num);
        if (this.labelNum.text === str) return;

        sfx.play('common/sfx-countdown.wav', { speed: 2, volume: 0.5 });
        this.stroke.texture = Texture.from('num-stroke-' + str);
        this.labelNum.text = str;

        gsap.killTweensOf(this.stroke);
        gsap.killTweensOf(this.stroke.scale);
        gsap.killTweensOf(this.labelNum);
        gsap.killTweensOf(this.labelNum.scale);

        this.labelNum.scale.set(0.5);
        gsap.to(this.labelNum, { alpha: 1, duration: 0.4, ease: 'linear' });
        gsap.to(this.labelNum.scale, { x: 1, y: 1, duration: 0.4, ease: 'back.out' });

        this.stroke.alpha = 1;
        this.stroke.scale.set(1);
        gsap.to(this.stroke, { alpha: 0, duration: 0.4, ease: 'linear' });
        gsap.to(this.stroke.scale, { x: 4, y: 4, duration: 0.4, ease: 'sine.in' });

        gsap.to(this.labelNum, { alpha: 0, duration: 0.2, ease: 'linear', delay: 0.8 });
        gsap.to(this.labelNum.scale, { x: 3, y: 3, duration: 0.2, ease: 'linear', delay: 0.8 });
    }

    /** Play the "Finished" animation  */
    private playOvertime() {
        this.labelNum.visible = false;
        this.stroke.visible = false;

        if (!this.labelOver.visible) {
            sfx.play('common/sfx-countdown.wav', { speed: 0.5, volume: 0.5 });
            gsap.killTweensOf(this.labelOver);
            gsap.killTweensOf(this.labelOver.scale);
            this.labelOver.visible = true;
            this.labelOver.scale.set(0);
            gsap.to(this.labelOver.scale, { x: 1, y: 1, duration: 0.3, ease: 'sine.out' });
        }

        this.labelOver.rotation = Math.sin(app.ticker.lastTime * 0.01) * 0.05;
        this.labelOver.alpha = 0.7 + Math.sin(app.ticker.lastTime * 0.02) * 0.3;
    }

    /** Update the display according to the remaining time passed - will be ignored until 5 secs left */
    public updateTime(remainingTimeMs: number) {
        if (remainingTimeMs >= 6000) {
            this.visible = false;
            return;
        }

        if (!this.visible && remainingTimeMs > 0) this.show();

        const secs = Math.floor(remainingTimeMs / 1000);
        if (secs > 0) {
            this.playNumber(secs);
        } else {
            this.playOvertime();
        }
    }

    /** Show the component  */
    public async show() {
        this.alpha = 0;
        this.visible = true;
        gsap.to(this, { alpha: 0.5, duration: 0.3, ease: 'linear' });
    }

    /** Hide the component  */
    public async hide() {
        await gsap.to(this, { alpha: 0, duration: 0.4, ease: 'linear' });
        this.visible = false;
    }
}
