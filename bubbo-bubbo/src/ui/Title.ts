import { Container, Text } from 'pixi.js';

import { randomType } from '../game/boardConfig';
import { BubbleView } from '../game/entities/BubbleView';
import { i18n } from '../utils/i18n';

/**
 * Class to render the game's title
 */
export class Title {
    /* The container instance that is the root of all visuals in this class */
    public view = new Container();

    constructor() {
        // Create main header

        // Add top part of the title
        const bubboText = i18n.t('gameTitle');

        const topWrapper = new Container();
        const titleTop = new Text({
            text: bubboText,
            style: {
                fontSize: 90,
                fontWeight: '900',
                fontFamily: 'Bungee-Regular',
            },
        });

        titleTop.anchor.set(0.5);
        topWrapper.addChild(titleTop);
        this.view.addChild(topWrapper);

        // Assign a random type to the top title's bubble
        const bubbleTop = new BubbleView(randomType());

        bubbleTop.view.position.set(titleTop.width * 0.5 - 33.5, 7);
        bubbleTop.view.scale.set(1.6);
        topWrapper.addChild(bubbleTop.view);

        const bottomWrapper = new Container();
        // Add bottom part of the title
        const titleBottom = new Text({
            text: bubboText,
            style: {
                fontSize: 90,
                fontWeight: '900',
                fontFamily: 'Bungee-Regular',
            },
        });

        bottomWrapper.y = titleTop.height - 20;

        titleBottom.anchor.set(0.5);
        bottomWrapper.addChild(titleBottom);
        this.view.addChild(bottomWrapper);

        // Assign a random type to the bottom title's bubble
        const bubbleBottom = new BubbleView(randomType());

        bubbleBottom.view.position.set(titleBottom.width * 0.5 - 33.5, 7);
        bubbleBottom.view.scale.set(1.6);
        bottomWrapper.addChild(bubbleBottom.view);

        // Create sub header
        const subtitle = new Text({
            text: i18n.t('gameSubtitle'),
            style: {
                fontSize: 32,
                fontWeight: '900',
                fontFamily: 'Bungee-Regular',
            },
        });

        subtitle.anchor.set(0.5);
        subtitle.y = bottomWrapper.y + bottomWrapper.height - 30;
        this.view.addChild(subtitle);
    }
}
