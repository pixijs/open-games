import { FancyButton } from '@pixi/ui';
import { Sprite } from 'pixi.js';
import gsap from 'gsap';
import { sfx } from '../utils/audio';

const defaultImageButtonOptions = {
    image: '',
    scaleOverride: 1,
};

type ImageButtonOptions = typeof defaultImageButtonOptions;

/**
 * A simple sprite button, based on a single texture frame
 */
export class ImageButton extends FancyButton {
    /** The image used for this button */
    private image: Sprite;
    /** Optional custom scale */
    private scaleOverride: number;

    constructor(options: Partial<ImageButtonOptions> = {}) {
        const opts = { ...defaultImageButtonOptions, ...options };

        const defaultView = Sprite.from(opts.image);

        super({
            defaultView,
            anchor: 0.5,
        });

        this.image = defaultView;
        this.scaleOverride = opts.scaleOverride;

        this.onHover.connect(this.handleHover.bind(this));
        this.onOut.connect(this.handleOut.bind(this));
        this.onDown.connect(this.handleDown.bind(this));
        this.onUp.connect(this.handleUp.bind(this));
        this.on('pointerupoutside', this.handleUp.bind(this));
    }

    private handleHover() {
        sfx.play('common/sfx-hover.wav');
        this.image.blendMode = 'add';
    }

    private handleOut() {
        this.image.blendMode = 'normal';
    }

    private handleDown() {
        sfx.play('common/sfx-press.wav');
        this.image.alpha = 0.5;
    }

    private handleUp() {
        this.image.alpha = 1;
    }

    /** Show the component */
    public async show(animated = true) {
        gsap.killTweensOf(this.scale);
        this.visible = true;
        if (animated) {
            this.scale.set(0.5);
            await gsap.to(this.scale, {
                x: this.scaleOverride,
                y: this.scaleOverride,
                duration: 0.3,
                ease: 'back.out',
            });
        } else {
            this.scale.set(this.scaleOverride);
        }
    }

    /** Hide the component */
    public async hide(animated = true) {
        gsap.killTweensOf(this.scale);
        if (animated) {
            await gsap.to(this.scale, { x: 0.5, y: 0.5, duration: 0.3, ease: 'back.in' });
        } else {
            this.scale.set(0);
        }
        this.visible = false;
    }
}
