import { Container } from 'pixi.js';
import { i18n } from '../utils/i18n';
import { Label } from './Label';
import gsap from 'gsap';
import { throttle } from '../utils/throttle';
import { sfx } from '../utils/audio';

/**
 * Score component that shows up in the Result screen, used for both
 * gameplay score and best score.
 */
export class ResultScore extends Container {
    /** The score message displayed */
    private messageLabel: Label;

    constructor(fill = 0xffffff) {
        super();
        this.messageLabel = new Label('', { fill });
        this.addChild(this.messageLabel);
    }

    /** Show the component */
    public async show(animated = true) {
        gsap.killTweensOf(this.messageLabel);
        this.visible = true;
        if (animated) {
            this.messageLabel.scale.set(0);
            this.messageLabel.text = 0 + i18n.pointsSuffix;
            await gsap.to(this.messageLabel.scale, { x: 1, y: 1, duration: 0.3, ease: 'back.out' });
        } else {
            this.messageLabel.text = 0 + i18n.pointsSuffix;
            this.messageLabel.scale.set(1);
        }
    }

    /** Set the label text */
    public setText(text: string, speed = 1) {
        if (this.messageLabel.text !== text) {
            this.messageLabel.text = text;
            throttle('score', 100, () => {
                sfx.play('common/sfx-points.wav', { speed, volume: 0.3 });
            });
        }
    }

    /** Play score animation, increasing it gradually */
    public async playScore(points: number) {
        this.messageLabel.text = 0 + i18n.pointsSuffix;
        if (points === 0) return;
        const score = { points: 0 };
        await gsap.to(score, {
            points,
            duration: 2,
            ease: 'linear',
            onUpdate: () => {
                const partial = Math.round(score.points);
                const speed = 0.9 + Math.min(1, partial * 0.0005);
                this.setText(partial + i18n.pointsSuffix, speed);
            },
        });
    }
}
