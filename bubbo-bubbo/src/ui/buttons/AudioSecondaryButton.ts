import { FancyButton, Switcher } from '@pixi/ui';
import { Sprite, Text } from 'pixi.js';

import { audio, sfx } from '../../audio';
import { storage } from '../../storage';
import { i18n } from '../../utils/i18n';
import { getAnimations } from './configs/animationConfig';

/** Constant to define the default scale of the button */
const DEFAULT_SCALE = 0.75;

/** Unique button to be used to toggle audio from the pause menu.
 *
 * Uses elements from @pixi/ui.
 */
export class AudioSecondaryButton extends FancyButton {
    /**
     * A reference to an object used to display the mute state
     *
     * Switcher button from @pixi/ui. Acts similar to a html checkbox
     */
    private _switcher: Switcher;

    constructor() {
        // Check the muted state
        const isMuted = storage.getStorageItem('muted');

        const switcher = new Switcher(
            ['icon-sound-on', 'icon-sound-off'],
            [], // no trigger events, we will control switch manually
            isMuted ? 1 : 0,
        ); // Force the visual switched state to be the muted state

        // Decrease scale to fit to parent button
        switcher.scale.set(0.95);

        // Create text object to act as label
        const text = new Text({
            text: i18n.t('sound'),
            style: {
                fill: 0x000000,
                fontFamily: 'Bungee-Regular',
                fontWeight: 'bold',
                align: 'center',
                fontSize: 40,
            },
        });

        super({
            // Assign the default view
            defaultView: 'button-flat',
            // Add the switcher as an icon view for the FancyButton
            icon: switcher,
            // Offset the icon to the right
            iconOffset: {
                x: 90,
            },
            // Anchor to center
            anchor: 0.5,
            // Assign button text
            text,
            // Offset text to left
            textOffset: {
                default: {
                    x: -30,
                },
            },
            // Set animations using common scaling states based on default scale
            animations: getAnimations(DEFAULT_SCALE),
            // Set initial scale to default scale
            scale: DEFAULT_SCALE,
        });

        // Tint base asset
        (this.defaultView as Sprite).tint = 0x49c8ff;

        this._switcher = switcher;

        this.onPress.connect(() => {
            this.press();
        });
    }

    /**
     * Override function for the FancyButton, called when button is pressed
     */
    public press() {
        // Toggling the mute state of audio
        const isMuted = storage.setStorageItem('muted', !storage.getStorageItem('muted'));

        // Update the display
        this.forceSwitch(isMuted);

        // Set the actual audio state
        audio.muted(isMuted);

        // Play audio if unmuted
        if (!isMuted) sfx.play('audio/secondary-button-press.wav');
    }

    /**
     * This method updates the display of the mute state to match the provided muted value.
     * @param muted - The mute state
     */
    public forceSwitch(muted: boolean) {
        // Force the visual switched state to be the muted state
        this._switcher.forceSwitch(muted ? 1 : 0);
    }
}
