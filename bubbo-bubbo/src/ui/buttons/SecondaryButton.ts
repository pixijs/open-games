import type { ButtonOptions } from '@pixi/ui';
import { FancyButton } from '@pixi/ui';
import type { TextStyle } from 'pixi.js';
import { Sprite, Text } from 'pixi.js';

import { sfx } from '../../audio';
import { getAnimations } from './configs/animationConfig';

/**
 * Options for the secondary button.
 */
export interface SecondaryButtonOptions {
    /** The text displayed on the button. */
    text: string;
    /** The tint color applied to the button. */
    tint?: number;
    /** Style properties for the text displayed on the button. */
    textStyle?: Partial<TextStyle>;
    /** Options for the underlying button component. */
    buttonOptions?: ButtonOptions;
}

/** Constant to define the default scale of the button */
const DEFAULT_SCALE = 0.75;

/** Common button that can be used throughout the game.
 *
 * Uses elements from @pixi/ui.
 */
export class SecondaryButton extends FancyButton {
    /**
     * @param options - Options for the secondary button.
     */
    constructor(options?: SecondaryButtonOptions) {
        // Create text object to act as label
        const text = new Text({
            text: options?.text ?? '',
            style: {
                // Predefine text styles that can be overwritten
                fill: 0x000000,
                fontFamily: 'Bungee-Regular',
                fontWeight: 'bold',
                align: 'center',
                fontSize: 40,
                // Allow custom text style to overwrite predefined options
                ...options?.textStyle,
            },
        });

        super({
            // Assign the default view
            defaultView: 'button-flat',
            // Anchor to center
            anchor: 0.5,
            // Assign button text
            text,
            // Set animations using common scaling states based on default scale
            animations: getAnimations(DEFAULT_SCALE),
            // Set initial scale to default scale
            scale: DEFAULT_SCALE,
            // Allow custom button options to overwrite predefined options
            ...options?.buttonOptions,
        });

        if (options?.tint) {
            // Tint base asset if tint defined in options
            (this.defaultView as Sprite).tint = options.tint;
        }
        this.onPress.connect(() => sfx.play('audio/secondary-button-press.wav'));
    }
}
