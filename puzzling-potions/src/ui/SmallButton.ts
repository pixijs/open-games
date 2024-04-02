import { FancyButton } from '@pixi/ui';
import { Container, NineSliceSprite, Texture } from 'pixi.js';
import { Label } from './Label';
import gsap from 'gsap';
import { sfx } from '../utils/audio';

const defaultSmallButtonOptions = {
    text: '',
    width: 67,
    height: 53,
    labelColor: 0xec1561,
    labelFontSize: 8,
};

type SmallButtonOptions = typeof defaultSmallButtonOptions;

/**
 * A rectangular small button, with label idle and pressed states
 */
export class SmallButton extends FancyButton {
    /** The message displayed */
    public messageLabel: Label;
    /** Inner container for animation */
    private container: Container;

    constructor(options: Partial<SmallButtonOptions> = {}) {
        const opts = { ...defaultSmallButtonOptions, ...options };

        const defaultView = new NineSliceSprite({
            texture: Texture.from('button-small'),
            leftWidth: 16,
            topHeight: 16,
            rightWidth: 16,
            bottomHeight: 20,
            width: opts.width,
            height: opts.height,
        });

        const hoverView = new NineSliceSprite({
            texture: Texture.from('button-small-hover'),
            leftWidth: 16,
            topHeight: 16,
            rightWidth: 16,
            bottomHeight: 20,
            width: opts.width,
            height: opts.height,
        });

        const pressedView = new NineSliceSprite({
            texture: Texture.from('button-small-press'),
            leftWidth: 16,
            topHeight: 16,
            rightWidth: 16,
            bottomHeight: 20,
            width: opts.width,
            height: opts.height,
        });

        super({
            defaultView,
            hoverView,
            pressedView,
            anchor: 0.5,
        });

        this.container = new Container();
        this.addChild(this.container);

        if (this.defaultView) this.container.addChild(this.defaultView);
        if (this.hoverView) this.container.addChild(this.hoverView);
        if (this.pressedView) this.container.addChild(this.pressedView);
        if (this.disabledView) this.container.addChild(this.disabledView);

        this.messageLabel = new Label(opts.text, {
            fill: opts.labelColor,
            align: 'center',
            fontSize: opts.labelFontSize,
        });
        this.messageLabel.y = -8;
        this.container.addChild(this.messageLabel);

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
        this.messageLabel.y = -3;
    }

    private handleUp() {
        this.messageLabel.y = -8;
    }

    public async show(animated = true) {
        gsap.killTweensOf(this.scale);
        this.visible = true;
        if (animated) {
            this.scale.set(0);
            await gsap.to(this.scale, { x: 1, y: 1, duration: 0.3, ease: 'back.out' });
        } else {
            this.scale.set(1);
        }
    }

    public async hide(animated = true) {
        gsap.killTweensOf(this.scale);
        if (animated) {
            await gsap.to(this.scale, { x: 0, y: 0, duration: 0.3, ease: 'back.in' });
        } else {
            this.scale.set(0);
        }
        this.visible = false;
    }
}
