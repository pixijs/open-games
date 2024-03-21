import { Container, Sprite, Text } from 'pixi.js';

/**
 * Class for rendering a PixiJS logo
 */
export class PixiLogo {
    /* The container instance that is the root of all visuals in this class */
    public view = new Container();

    /**
     * @param header The header text to be displayed above the logo
     */
    constructor(header?: string) {
        // Create the logo sprite from an image
        const logo = Sprite.from('pixi-logo');

        logo.anchor.set(0.5);
        this.view.addChild(logo);

        // If the header parameter is present, add the header text above the logo
        if (header) {
            const headerText = new Text({
                text: header,
                style: {
                    fontSize: 20,
                    align: 'center',
                },
            });

            headerText.anchor.set(0.5);
            headerText.y = -(logo.height * 0.5) - 15;
            this.view.addChild(headerText);
        }
    }
}
