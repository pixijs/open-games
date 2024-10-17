import { Container, Sprite, Texture } from 'pixi.js';
import { app } from '../main';

/**
 * The cloud that shows up on the top of the screen, during loading.
 */
export class SmokeCloud extends Container {
    /** The tint colour of this component */
    private color = 0x2c136c;
    /** Rectangular base area of the cloud */
    private base: Sprite;
    /** Container for animated cloud circles */
    private circlesContainer: Container;
    /** Pool of reusable circles */
    private circlesPool: SmokeCloudCircle[] = [];
    /** Circles currently being displayed */
    private circles: SmokeCloudCircle[] = [];

    constructor() {
        super();

        this.base = new Sprite(Texture.WHITE);
        this.base.tint = this.color;
        this.addChild(this.base);

        this.circlesContainer = new Container();
        this.addChild(this.circlesContainer);

        this.onRender = () => this.renderUpdate();
    }

    /** Get base width - the visible with is a bit larger */
    public get width() {
        return this.base.width;
    }

    /** Set base width - the visible will be a bit larger */
    public set width(value: number) {
        this.base.width = value;
        this.rebuildCircles();
    }

    /** Get base height - the visible with is a bit larger */
    public get height() {
        return this.base.height;
    }

    /** Set base height - the visible will be a bit larger */
    public set height(value: number) {
        this.base.height = value;
        this.circlesContainer.y = value;
    }

    /** Set Get a single cloud circle */
    private getCircle() {
        let circle = this.circlesPool.pop();
        if (!circle) {
            circle = new SmokeCloudCircle();
            circle.tint = this.color;
        }
        circle.step = Math.random() * 100;
        circle.speed = Math.random() * 0.5 + 0.5;
        return circle;
    }

    /** Dispose the clous circle */
    private releaseCircle(circle: SmokeCloudCircle) {
        if (!this.circlesPool.includes(circle)) {
            this.circlesPool.push(circle);
        }
    }

    /** Clear and rebuil all circles when resize the cloud, distributing them equally */
    private rebuildCircles() {
        for (const circle of this.circles) {
            this.circlesContainer.removeChild(circle);
            this.releaseCircle(circle);
        }
        this.circles.length = 0;

        const spacing = 60;
        const numCircles = Math.ceil(this.base.width / spacing) + 1;

        for (let i = 0; i < numCircles; i++) {
            const circle = this.getCircle();
            circle.x = spacing * i;
            circle.scale.x = 0.5 + Math.random() * 0.5;
            circle.scale.y = circle.scale.x;
            this.circlesContainer.addChild(circle);
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
}

/**
 * Each circle used in the smoke cloud, with its own parameters
 */
class SmokeCloudCircle extends Sprite {
    public step = 0;
    public size = 1;
    public speed = 1;

    constructor() {
        super();
        this.texture = Texture.from('circle');
        this.anchor.set(0.5);
    }

    public update(delta: number) {
        this.step += delta * 0.1 * this.speed;
        this.scale.set(Math.sin(this.step) * 0.4 + this.size);
    }
}
