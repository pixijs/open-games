import type { ButtonOptions } from '@pixi/ui';
import { FancyButton } from '@pixi/ui';
import type { TextStyle } from 'pixi.js';
import { Text } from 'pixi.js';

import { sfx } from '../../audio';

/**
 * Options for the primary button.
 */
export interface PrimaryButtonOptions {
    /** The text displayed on the button. */
    text: string;
    /** Style properties for the text displayed on the button. */
    textStyle?: Partial<TextStyle>;
    /** Options for the underlying button component. */
    buttonOptions?: ButtonOptions;
}

/** Constant to define the default scale of the button */
const DEFAULT_SCALE = 0.6;

export class PrimaryButton extends FancyButton {
    /**
     * @param options - Options for the primary button.
     */
    constructor(options: PrimaryButtonOptions) {
        // Create text object to act as label
        const text = new Text({
            text: options?.text ?? '',
            style: {
                // Predefine text styles that can be overwritten
                fill: 0x49c8ff,
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
            defaultView: 'play-btn-up',
            // Assign the pressed view
            pressedView: 'play-btn-down',
            // Assign button text
            text,
            // Offset the button text
            textOffset: {
                default: {
                    y: -30,
                },
                pressed: {
                    y: -15,
                },
            },
            // Anchor to the center-bottom
            anchorX: 0.5,
            anchorY: 1,
            // Set initial scale to default scale
            scale: DEFAULT_SCALE,
            // Allow custom button options to overwrite predefined options
            ...options.buttonOptions,
        });

        this.onPress.connect(() => {
            sfx.play('audio/primary-button-press.wav');
        });
    }
}
