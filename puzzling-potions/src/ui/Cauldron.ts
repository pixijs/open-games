import { Container, Sprite, Texture } from 'pixi.js';
import gsap from 'gsap';
import { randomRange } from '../utils/random';
import { registerCustomEase } from '../utils/animation';
import { pool } from '../utils/pool';
import { Spine } from '@pixi/spine-pixi';

/** Custom ease curve for splash drops y animation */
const easeDropJumpOut = registerCustomEase('M0,0,C0,0,0.07,-0.63,0.402,-0.422,0.83,-0.152,1,1,1,1');

/**
 * Spine-animated cauldron, with some dynamic functionality, like
 * play splash animation and set up an inner sprite that follows up the spine animation.
 */
export class Cauldron extends Container {
    /** Inner container for the cauldron */
    private container: Container;
    /** The optional cauldron shadow, displayed in game screen */
    private shadow: Sprite;
    /** The cauldron spine animation */
    private spine: Spine;
    /** Optional content attached to the cauldron, that will follow its animation */
    private content?: Container;

    constructor(shadow = false) {
        super();

        this.container = new Container();
        this.addChild(this.container);

        this.shadow = Sprite.from('circle');
        this.shadow.anchor.set(0.5);
        this.shadow.width = 180;
        this.shadow.height = 40;
        this.shadow.tint = 0x262626;
        this.shadow.alpha = 0.2;
        this.shadow.y = 40;
        this.shadow.visible = shadow;
        this.container.addChild(this.shadow);

        this.spine = Spine.from({
            skeleton: 'preload/cauldron-skeleton.json',
            atlas: 'preload/cauldron-skeleton.atlas',
        });

        this.spine.autoUpdate = true;
        this.spine.y = 50;
        this.spine.state.setAnimation(0, 'animation', true);
        this.container.addChild(this.spine);

        this.onRender = () => this.renderUpdate();
    }

    /** Show cauldron */
    public async show(animated = true) {
        gsap.killTweensOf(this.container.scale);
        this.visible = true;
        if (animated) {
            this.container.scale.set(0);
            await gsap.to(this.container.scale, { x: 1, y: 1, duration: 0.3, ease: 'back.out' });
        } else {
            this.container.scale.set(1);
        }
    }

    /** Hide cauldron */
    public async hide(animated = true) {
        gsap.killTweensOf(this.container.scale);
        if (animated) {
            await gsap.to(this.container.scale, { x: 0, y: 0, duration: 0.3, ease: 'back.in' });
        } else {
            this.container.scale.set(0);
        }
        this.visible = false;
    }

    /** Splash drops out of caldron */
    public async playSplash(x: number, numDrops = 6) {
        this.playWobble();
        const animPromises = [];
        for (let i = 0; i < numDrops; i++) {
            animPromises.push(this.playSplashDrop(x));
        }
        await Promise.all(animPromises);
    }

    /** Play a single splash drop out of caldron */
    private async playSplashDrop(x: number) {
        const duration = randomRange(0.4, 0.6);
        const drop = pool.get(CauldronCircle);
        drop.x = x + randomRange(-10, 10);
        drop.y = -45;
        this.addChild(drop);
        await drop.playSplashDrop(
            {
                x: x + randomRange(-100, 100),
                y: randomRange(30, 70),
            },
            randomRange(0.03, 0.07),
            duration,
        );
        this.removeChild(drop);
        pool.giveBack(drop);
    }

    /** Make cauldron do a quick impact wobble */
    public async playWobble() {
        gsap.killTweensOf(this.spine.scale);
        const scaleX = randomRange(1.1, 1.2);
        const scaley = randomRange(0.8, 0.9);
        await gsap.to(this.spine.scale, { x: scaleX, y: scaley, duration: 0.05, ease: 'linear' });
        await gsap.to(this.spine.scale, { x: 1, y: 1, duration: 0.8, ease: 'elastic.out' });
    }

    /** Add a sprite to the front of the cauldron that will follow up the spine animation */
    public addContent(content: Container) {
        if (!this.content) this.content = new Container();
        this.spine.addChild(this.content);
        this.content.addChild(content);
    }

    /** Auto-update every frame */
    public renderUpdate() {
        if (!this.content) return;
        const bone = this.spine.skeleton.bones[1] as any;
        this.content.x = bone.ax;
        this.content.y = -bone.ay - 5;
        this.content.rotation = bone.arotation * -0.015;
    }
}

/** A cauldron drop of its inner content, to be played with the splash animation */
class CauldronCircle extends Sprite {
    constructor() {
        super();
        this.texture = Texture.from('circle');
        this.anchor.set(0.5);
        this.tint = 0x2c136c;
    }

    public async playSplashDrop(to: { x: number; y: number }, scale: number, duration: number) {
        gsap.killTweensOf(this);
        gsap.killTweensOf(this.scale);
        this.scale.set(scale);
        this.alpha = 1;
        gsap.to(this.scale, { x: scale * 3, y: scale * 3, duration, ease: 'linear' });
        gsap.to(this, { alpha: 0, duration: 0.1, ease: 'linear', delay: duration - 0.1 });
        gsap.to(this, { x: to.x, duration, ease: 'linear' });
        await gsap.to(this, { y: to.y, duration, ease: easeDropJumpOut });
    }
}
