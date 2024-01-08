import { FancyButton } from '@pixi/ui';

import { sfx } from '../../audio';
import { getAnimations } from './configs/animationConfig';

/** Constant to define the default scale of the button */
const DEFAULT_SCALE = 0.75;

/** Unique button to be used to toggle audio from the pause menu.
 *
 * Uses elements from @pixi/ui.
 */
export class IconButton extends FancyButton {
    /**
     *
     * @param icon - string ID of the icon texture
     * @param scale - Base scale of the button, defaults to `DEFAULT_SCALE` constant
     */
    constructor(icon: string, scale = DEFAULT_SCALE) {
        super({
            // Set the base's asset
            defaultView: 'button-flat-small',
            // Set the icon asset based on input
            icon,
            // Offset the icon up a little
            iconOffset: {
                y: -4,
            },
            // Anchor to center
            anchor: 0.5,
            // Set animations using common scaling states based on given scale
            animations: getAnimations(scale),
            // Set initial scale to given scale
            scale,
        });

        this.onPress.connect(() => {
            sfx.play('audio/secondary-button-press.wav', {
                speed: 1.1,
            });
        });
    }
}
