import { Container } from 'pixi.js';
import { Label } from './Label';
import { Cloud } from './Cloud';
import gsap from 'gsap';

const defaultCloudLabelOptions = {
    color: 0x2c136c,
    labelColor: 0xffffff,
};

export type CloudLabelOptions = typeof defaultCloudLabelOptions;

/**
 * Class that composes a Cloud and a Label, used in different places in this app,
 */
export class CloudLabel extends Container {
    private container: Container;
    private cloud: Cloud;
    private label: Label;
    private showing = true;

    constructor(options: Partial<CloudLabelOptions> = {}) {
        super();
        const opts = { ...defaultCloudLabelOptions, ...options };

        this.container = new Container();
        this.addChild(this.container);

        this.cloud = new Cloud({
            color: opts.color,
            width: 120,
            height: 10,
            circleSize: 30,
        });
        this.container.addChild(this.cloud);

        this.label = new Label('', {
            fill: opts.labelColor,
            fontSize: 18,
        });
        this.container.addChild(this.label);
    }

    /** Get label text */
    public get text() {
        return this.label.text;
    }

    /** Set label text */
    public set text(v: string | number) {
        this.label.text = v;
    }

    /** Present label and form cloud */
    public async show(animated = true) {
        if (this.showing) return;
        this.showing = true;
        this.visible = true;
        this.killTweens();
        if (animated) {
            const duration = 1;
            this.cloud.playFormAnimation(duration * 0.5);
            this.container.alpha = 0;
            this.label.scale.set(3);
            this.container.scale.set(0.5);
            gsap.to(this.container, { alpha: 1, duration: duration * 0.5, ease: 'linear' });
            gsap.to(this.label.scale, { x: 1, y: 1, duration, ease: 'expo.out' });
            await gsap.to(this.container.scale, { x: 1, y: 1, duration, ease: 'expo.out' });
        } else {
            this.container.alpha = 1;
            this.label.alpha = 1;
            this.label.scale.set(1);
        }
    }

    /** Hide label and dismiss cloud */
    public async hide(animated = true) {
        if (!this.showing) return;
        this.showing = false;
        this.killTweens();
        if (animated) {
            this.cloud.playDismissAnimation(0.3);
            await gsap.to(this.container, { alpha: 0, duration: 0.3, ease: 'linear' });
        }
        this.visible = false;
    }

    /** Kill all tweens related to this component */
    private killTweens() {
        gsap.killTweensOf(this.container);
        gsap.killTweensOf(this.container.scale);
        gsap.killTweensOf(this.label);
        gsap.killTweensOf(this.label.scale);
    }
}
