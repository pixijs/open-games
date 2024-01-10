import { Container, Sprite, Texture } from 'pixi.js';
import { app } from '../main';
import gsap from 'gsap';
import { randomRange } from '../utils/random';

const defaultCloudOptions = {
    width: 130,
    height: 10,
    color: 0xffffff,
    circleSize: 40,
};

export type CloudOptions = typeof defaultCloudOptions;

/**
 * A cloud-like animated component formed by circles that can be reused in different parts of the game
 */
export class Cloud extends Container {
    /** Cloud display settings */
    private options: CloudOptions;
    /** Rectangular area of the cloud */
    private base: Sprite;
    /** Bottom container for cloud circles */
    private bottom: Container;
    /** Top container for cloud circles */
    private top: Container;
    /** Pool of circles that can be reused */
    private circlesPool: CloudCircle[] = [];
    /** Currently displayed circles */
    private circles: CloudCircle[] = [];

    constructor(options: Partial<CloudOptions> = {}) {
        super();

        this.options = { ...defaultCloudOptions, ...options };
        this.base = new Sprite(Texture.WHITE);
        this.base.tint = this.options.color;
        this.base.anchor.set(0.5);
        this.addChild(this.base);

        this.bottom = new Container();
        this.addChild(this.bottom);

        this.top = new Container();
        this.addChild(this.top);

        this.width = this.options.width;
        this.height = this.options.height;

        this.onRender = () => this.renderUpdate();
    }

    /** Get cloud width from its base, not visible area */
    public get width() {
        return this.base.width;
    }

    /** Set cloud base width, visible area will be a bit larger */
    public set width(value: number) {
        this.base.width = value;
        this.rebuildCircles();
    }

    /** Get cloud height from its base, not visible area */
    public get height() {
        return this.base.height;
    }

    /** Set cloud base height, visible area will be a bit taller */
    public set height(value: number) {
        this.base.height = value;
        this.top.y = -value * 0.5;
        this.bottom.y = value * 0.5;
    }

    /** Create a cloud circle */
    private getCircle() {
        let circle = this.circlesPool.pop();
        if (!circle) {
            circle = new CloudCircle();
            circle.tint = this.options.color;
        }
        circle.step = Math.random() * 100;
        circle.speed = Math.random() * 0.5 + 0.5;
        return circle;
    }

    /** Dispose a cloud circle */
    private releaseCircle(circle: CloudCircle) {
        if (!this.circlesPool.includes(circle)) {
            this.circlesPool.push(circle);
        }
    }

    /** Re-create all circles based on current base width & height */
    private rebuildCircles() {
        for (const circle of this.circles) {
            this.bottom.removeChild(circle);
            this.top.removeChild(circle);
            this.releaseCircle(circle);
        }
        this.circles.length = 0;
        this.fillCircles(this.bottom, this.base.width, this.options.circleSize);
        this.fillCircles(this.top, this.base.width, this.options.circleSize);
    }

    /** Fill a container with circles distributed equally along given width */
    private fillCircles(container: Container, width: number, circleSize: number) {
        const spacing = circleSize * 0.4;
        const numCircles = Math.ceil(width / spacing);
        const offset = ((numCircles - 1) * spacing) / 2;
        for (let i = 0; i < numCircles; i++) {
            const circle = this.getCircle();
            circle.x = spacing * i - offset;
            circle.size = circleSize;
            container.addChild(circle);
            this.circles.push(circle);
        }
    }

    /** Auto-update every frame */
    public renderUpdate() {
        const delta = app.ticker.deltaTime;
        for (const circle of this.circles) {
            circle.update(delta);
        }
    }

    /** Play circles showing up from afar forming the cloud */
    public async playFormAnimation(duration = 1) {
        const ease = 'expo.out';

        this.alpha = 0;
        gsap.to(this, { alpha: 1, duration: 0.1, ease: 'linear' });

        for (const circle of this.circles) {
            circle.pivot.x = randomRange(-200, 200);
            circle.pivot.y = randomRange(-200, 200);
            circle.scale.set(0);
            circle.alpha = 1;
            gsap.to(circle.scale, { x: 1, y: 1, duration, ease });
            gsap.to(circle.pivot, { x: 0, y: 0, duration, ease });
        }

        this.top.pivot.y = this.top.y;
        gsap.to(this.top.pivot, { y: 0, duration, ease });

        this.bottom.pivot.y = this.bottom.y;
        gsap.to(this.bottom.pivot, { y: 0, duration, ease });

        const width = this.base.width;
        const height = this.base.height;
        this.base.width = 0;
        this.base.height = 0;
        this.base.alpha = 0;
        gsap.to(this.base, { alpha: 1, duration, ease });
        await gsap.to(this.base, { width, height, duration, ease });
    }

    /** Play circles moving out and fading away to dismiss the cloud */
    public async playDismissAnimation(duration = 1) {
        const ease = 'expo.in';
        for (const circle of this.circles) {
            gsap.to(circle.pivot, {
                x: randomRange(-500, 500),
                y: randomRange(-500, 500),
                duration,
                ease,
            });
            gsap.to(circle.scale, {
                x: 0.2,
                y: 0.2,
                duration,
                ease,
            });
            gsap.to(circle, {
                alpha: 0,
                duration,
                ease,
            });
        }
        gsap.to(this.base, { alpha: 0, duration: duration * 0.5, ease });
        await gsap.to(this.base, { duration: duration });
    }
}

/**
 * Each cloud circle that animates independently
 */
class CloudCircle extends Container {
    public step = 0;
    public size = 100;
    public speed = 1;
    public image: Sprite;

    constructor() {
        super();
        this.image = Sprite.from('circle');
        this.image.anchor.set(0.5);
        this.addChild(this.image);
    }

    public update(delta: number) {
        this.step += delta * 0.1 * this.speed;
        const size = this.size + Math.sin(this.step) * this.size * 0.25;
        this.image.width = size;
        this.image.height = size;
    }

    public get tint() {
        return Number(this.image.tint);
    }

    public set tint(v: number) {
        this.image.tint = v;
    }
}
