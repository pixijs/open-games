import { FancyButton } from '@pixi/ui';
import { NineSlicePlane, Texture } from 'pixi.js';
import { Label } from './Label';
import gsap from 'gsap';
import { sfx } from '../utils/audio';

const defaultLargeButtonOptions = {
    text: '',
    width: 301,
    height: 112,
};

type LargeButtonOptions = typeof defaultLargeButtonOptions;

/**
 * The big rectangle button, with a label, idle and pressed states
 */
export class LargeButton extends FancyButton {
    /** The buttoon message displayed */
    private label: Label;

    constructor(options: Partial<LargeButtonOptions> = {}) {
        const opts = { ...defaultLargeButtonOptions, ...options };

        const defaultView = new NineSlicePlane(Texture.from('button-large'), 36, 42, 36, 52);
        defaultView.width = opts.width;
        defaultView.height = opts.height;

        const hoverView = new NineSlicePlane(Texture.from('button-large-hover'), 36, 42, 36, 52);
        hoverView.width = opts.width;
        hoverView.height = opts.height;

        const pressedView = new NineSlicePlane(Texture.from('button-large-press'), 36, 42, 36, 52);
        pressedView.width = opts.width;
        pressedView.height = opts.height;

        super({
            defaultView,
            hoverView,
            pressedView,
            anchor: 0.5,
        });

        this.label = new Label(opts.text, {
            fill: 0x4a4a4a,
            align: 'center',
        });
        this.label.y = -13;
        this.addChild(this.label);

        this.onDown.connect(this.handleDown.bind(this));
        this.onUp.connect(this.handleUp.bind(this));
        this.onHover.connect(this.handleHover.bind(this));
        this.on('pointerupoutside', this.handleUp.bind(this));
        this.on('pointerout', this.handleUp.bind(this));
    }

    private handleHover() {
        sfx.play('common/sfx-hover.wav');
    }

    private handleDown() {
        sfx.play('common/sfx-press.wav');
        this.label.y = -5;
    }

    private handleUp() {
        this.label.y = -13;
    }

    /** Show the component */
    public async show(animated = true) {
        gsap.killTweensOf(this.pivot);
        this.visible = true;
        if (animated) {
            this.pivot.y = -200;
            await gsap.to(this.pivot, { y: 0, duration: 0.5, ease: 'back.out' });
        } else {
            this.pivot.y = 0;
        }
        this.interactiveChildren = true;
    }

    /** Hide the component */
    public async hide(animated = true) {
        this.interactiveChildren = false;
        gsap.killTweensOf(this.pivot);
        if (animated) {
            await gsap.to(this.pivot, { y: -200, duration: 0.3, ease: 'back.in' });
        } else {
            this.pivot.y = -200;
        }
        this.visible = false;
    }
}
