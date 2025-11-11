import gsap from 'gsap';
import { Container, Sprite, Text } from 'pixi.js';

import { designConfig } from '../game/designConfig';
import { device } from '../utils/device';
import { i18n } from '../utils/i18n';

/**
 * The panel that contains instructions on how to play the game.
 */
export class HelperPanel {
    /* The container instance that is the root of all visuals in this class */
    public view = new Container();

    constructor() {
        // Create the base panel
        const panel = Sprite.from('panel-small-instructions');

        panel.anchor.set(0.5);
        panel.scale.set(0.75);

        // Get the instructions text, either for desktop or mobile device
        const text = i18n.t(device.isMobileDevice() ? 'helperMobile' : 'helperDesktop');

        // Create a text object with the instructions text
        const helpText = new Text({
            text,
            style: {
                fontSize: 19,
                fontWeight: '900',
                fontFamily: 'Opensans-Semibold',
                fill: 0x000000,
                align: 'center',
            },
        });

        helpText.anchor.set(0.5);
        helpText.x = -55;
        helpText.scale.set(0.75);
        this.view.addChild(panel, helpText);
    }

    /**
     * Prepares the view container for display by setting its x-coordinate to the off-screen position.
     */
    public prepare() {
        // Set this view's position to offscreen
        this.view.x = this._offScreenPos;
    }

    /**
     * Animates the helper panel into view
     * @returns The GSAP tween of the animation.
     */
    public show() {
        return gsap.to(this.view, {
            // Since the helper panel is initially set offscreen, it just needs to return to `0`
            x: 0,
            duration: 1,
            delay: 0.5,
            ease: 'back.out(1)',
        });
    }

    /**
     * Animates the helper panel back out of view
     * @returns The GSAP tween of the animation.
     */
    public hide() {
        return gsap.to(this.view, {
            x: this._offScreenPos,
        });
    }

    /**
     * Gets the off-screen position of the view container.
     * Offscreen in this instance is the gameplay view, not the full window.
     * @returns The x-coordinate of the off-screen position.
     */
    private get _offScreenPos(): number {
        return -(designConfig.content.width * 0.5) - this.view.width * 0.5;
    }
}
