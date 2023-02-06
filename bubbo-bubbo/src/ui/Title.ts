import { Container, Text } from 'pixi.js';

import { randomType } from '../game/boardConfig';
import { BubbleView } from '../game/entities/BubbleView';
import { i18n } from '../utils/i18n';

/**
 * Class to render the game's title
 */
export class Title
{
    /* The container instance that is the root of all visuals in this class */
    public view = new Container();

    constructor()
    {
        // Create main header

        // Add top part of the title
        const bubboText = i18n.t('gameTitle');
        
        const titleTop = new Text(bubboText, {
            fontSize: 90,
            fontWeight: '900',
            fontFamily: 'Bungee Regular',
        });
        
        titleTop.anchor.set(0.5);
        this.view.addChild(titleTop);
        
        // Assign a random type to the top title's bubble
        const bubbleTop = new BubbleView(randomType());
        
        bubbleTop.view.position.set(titleTop.width * 0.5 - 33.5, 7);
        bubbleTop.view.scale.set(1.6);
        titleTop.addChild(bubbleTop.view);
        
        // Add bottom part of the title
        const titleBottom = new Text(bubboText, {
            fontSize: 90,
            fontWeight: '900',
            fontFamily: 'Bungee Regular',
        });

        titleBottom.y = titleTop.height - 20;

        titleBottom.anchor.set(0.5);
        this.view.addChild(titleBottom);

        // Assign a random type to the bottom title's bubble
        const bubbleBottom = new BubbleView(randomType());

        bubbleBottom.view.position.set(titleBottom.width * 0.5 - 33.5, 7);
        bubbleBottom.view.scale.set(1.6);
        titleBottom.addChild(bubbleBottom.view);

        // Create sub header
        const subtitle = new Text(i18n.t('gameSubtitle'), {
            fontSize: 32,
            fontWeight: '900',
            fontFamily: 'Bungee Regular',
        });

        subtitle.anchor.set(0.5);
        subtitle.y = titleBottom.y + titleBottom.height - 30;
        this.view.addChild(subtitle);
    }
}
