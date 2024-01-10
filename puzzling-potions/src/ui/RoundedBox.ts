import { Container, NineSliceSprite, Texture } from 'pixi.js';

const defaultRoundedBoxOptions = {
    color: 0x2c136c,
    width: 350,
    height: 600,
    shadow: true,
    shadowColor: 0x0a0025,
    shadowOffset: 22,
};

export type RoundedBoxOptions = typeof defaultRoundedBoxOptions;

/**
 * Generic rounded box based on a nine-sliced sprite that can be resized freely.
 */
export class RoundedBox extends Container {
    /** The rectangular area, that scales without distorting rounded corners */
    private image: NineSliceSprite;
    /** Optional shadow matching the box image, with y offest */
    private shadow?: NineSliceSprite;

    constructor(options: Partial<RoundedBoxOptions> = {}) {
        super();
        const opts = { ...defaultRoundedBoxOptions, ...options };
        this.image = new NineSliceSprite({
            texture: Texture.from('rounded-rectangle'),
            leftWidth: 34,
            topHeight: 34,
            rightWidth: 34,
            bottomHeight: 34,
            width: opts.width,
            height: opts.height,
            tint: opts.color,
        });
        this.image.x = -this.image.width * 0.5;
        this.image.y = -this.image.height * 0.5;
        this.addChild(this.image);

        if (opts.shadow) {
            this.shadow = new NineSliceSprite({
                texture: Texture.from('rounded-rectangle'),
                leftWidth: 34,
                topHeight: 34,
                rightWidth: 34,
                bottomHeight: 34,
                width: opts.width,
                height: opts.height,
                tint: opts.shadowColor,
            });
            this.shadow.x = -this.shadow.width * 0.5;
            this.shadow.y = -this.shadow.height * 0.5 + opts.shadowOffset;
            this.addChildAt(this.shadow, 0);
        }
    }

    /** Get the base width, without counting the shadow */
    public get boxWidth() {
        return this.image.width;
    }

    /** Get the base height, without counting the shadow */
    public get boxHeight() {
        return this.image.height;
    }
}
