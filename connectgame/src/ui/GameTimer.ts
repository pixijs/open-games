import { Container } from 'pixi.js';
import { Label } from './Label';

/**
 * The game timer presented during gameplay, that starts flashing red
 * once there is less than 10 seconds left.
 */
export class GameTimer extends Container {
    /** The remaining time displayed */
    private readonly messageLabel: Label;

    constructor() {
        super();
        this.messageLabel = new Label('5:00', {
            fontSize: 36,
            fill: 0xffffff,
        });
        this.addChild(this.messageLabel);
    }

    /**
     * Update the time displayed, flashing it if remaing time is less than 10 seconds
     * @param remaining Remaining time, in milliseconds
     */
    public updateTime(remaining: number) {
        // Calculate minutes from remaining time
        const minutes = Math.floor(remaining / (60 * 1000));

        // Calculate seconds from remaining time
        const seconds = Math.floor(remaining / 1000) % 60;

        // Update label text with minutes and seconds
        this.messageLabel.text = String(minutes) + ':' + String(seconds).padStart(2, '0');

        // Flash timer if it is close to finish
        if (remaining > 1 && remaining < 11000) {
            this.messageLabel.tint = Math.floor(remaining * 0.005) % 2 ? 0xff0000 : 0xffffff;
        } else {
            this.messageLabel.tint = 0xffffff;
        }
    }
}
