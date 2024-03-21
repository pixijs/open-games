import { Container } from 'pixi.js';
import gsap from 'gsap';
import { Spine } from '@pixi/spine-pixi';

/**
 * Spine-animated little dragon, that shows up in Home and Result screens.
 */
export class Dragon extends Container {
    /** The spine animation */
    private spine: Spine;
    /** Inner container for internal animations */
    private container: Container;

    constructor() {
        super();

        this.container = new Container();
        this.addChild(this.container);

        this.spine = Spine.from({
            skeleton: 'common/dragon-skeleton.json',
            atlas: 'common/dragon-skeleton.atlas',
        });
        // this.spine.autoUpdate = true;
        this.spine.scale.set(0.3);
        this.spine.x = -30;
        this.spine.y = 130;
        this.container.addChild(this.spine);
        this.playIdle();
    }

    /** Play dragon's idle animation, in loop */
    public playIdle() {
        this.spine.state.setAnimation(0, 'dragon-idle', true);
    }

    /** Play dragon's bubbles animation, in loop */
    public playBubbles() {
        this.spine.state.setAnimation(0, 'dragon-bubbles', true);
    }

    /** Play dragon's transition animation, in loop */
    public playTransition() {
        this.spine.state.setAnimation(0, 'dragon-transition', true);
    }

    /** Show the dragon */
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

    /** Hide the dragon */
    public async hide(animated = true) {
        gsap.killTweensOf(this.container.scale);
        if (animated) {
            await gsap.to(this.container.scale, { x: 0, y: 0, duration: 0.3, ease: 'back.in' });
        } else {
            this.container.scale.set(0);
        }
        this.visible = false;
    }
}
