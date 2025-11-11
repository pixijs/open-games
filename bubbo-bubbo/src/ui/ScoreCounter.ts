import { Container, Sprite, Text } from 'pixi.js';

/**
 * Class to render the in-game score with a background
 */
export class ScoreCounter {
    /* The container instance that is the root of all visuals in this class. */
    public view = new Container();

    /** The background to the text. */
    private readonly _base: Sprite;
    private readonly _scoreText: Text;

    constructor() {
        // Create the background
        this._base = Sprite.from('info-bg');
        this._base.anchor.y = 0.5;
        this._base.scale.set(0.75);
        this.view.addChild(this._base);

        this._scoreText = new Text({
            style: {
                fontSize: 40,
                fontWeight: '900',
                fontFamily: 'Bungee-Regular',
                fill: 0x000000,
                stroke: {
                    color: 0xffffff,
                    width: 5,
                },
                align: 'left',
            },
        });

        // Offset text
        this._scoreText.x = 20;
        this._scoreText.anchor.y = 0.5;
        this._scoreText.scale.set(0.75);
        this.view.addChild(this._scoreText);

        // Set the score to 0
        this.setScore(0);
    }

    /**
     * Set the value of the text.
     * @param score - The score value.
     */
    public async setScore(score: number) {
        // Set text to be equal to score
        // Uses `toLocaleString` to add commas into the string
        this._scoreText.text = score.toLocaleString();

        // Sets score to be default size
        this._scoreText.style.fontSize = 30;

        // While the score is bigger than the expected size, reduce the font size
        while (this._scoreText.width > this._base.width) {
            this._scoreText.style.fontSize--;
        }
    }
}
