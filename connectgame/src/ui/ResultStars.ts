import { Container } from 'pixi.js';
import { app } from '../main';
import { earthquake } from '../utils/animation';
import { sfx } from '../utils/audio';
import { Star } from './Star';

/**
 * The group of 3 stars in the Result screen, representing the gameplay grade.
 */
export class ResultStars extends Container {
    /** Start instance for grade 1 */
    private star1: Star;
    /** Start instance for grade 2 */
    private star2: Star;
    /** Start instance for grade 3 */
    private star3: Star;
    /** Background for star1 */
    private starSlot1: Star;
    /** Background for star2 */
    private starSlot2: Star;
    /** Background for star3 */
    private starSlot3: Star;

    constructor() {
        super();

        const x1 = -80;
        const x2 = 80;
        const x3 = 0;
        const scale1 = 0.7;
        const scale2 = 0.7;
        const scale3 = 1;
        const slotAlpha = 0.15;

        this.starSlot1 = new Star();
        this.starSlot1.x = x1;
        this.starSlot1.scale.set(scale1);
        this.starSlot1.alpha = slotAlpha;
        this.addChild(this.starSlot1);

        this.starSlot2 = new Star();
        this.starSlot2.x = x2;
        this.starSlot2.scale.set(scale2);
        this.starSlot2.alpha = slotAlpha;
        this.addChild(this.starSlot2);

        this.starSlot3 = new Star();
        this.starSlot3.x = x3;
        this.starSlot3.alpha = slotAlpha;
        this.starSlot3.scale.set(scale3);
        this.addChild(this.starSlot3);

        this.star1 = new Star();
        this.star1.x = x1;
        this.star1.scale.set(scale2);
        this.addChild(this.star1);

        this.star2 = new Star();
        this.star2.x = x2;
        this.star2.scale.set(scale2);
        this.addChild(this.star2);

        this.star3 = new Star();
        this.star3.x = x3;
        this.star3.scale.set(scale3);
        this.addChild(this.star3);
    }

    /** Show the (stars slots) not actually animating any stars */
    public async show(animated = true) {
        this.star1.hide();
        this.star2.hide();
        this.star3.hide();
        await this.showSlots(animated);
    }

    /** Hide the component */
    public async hide(animated = true) {
        this.star1.hide(animated);
        this.star2.hide(animated);
        this.star3.hide(animated);
        await this.hideSlots(animated);
    }

    /** Show the 3 stars slots */
    private async showSlots(animated = true) {
        this.starSlot1.show(animated);
        this.starSlot2.show(animated);
        await this.starSlot3.show(animated);
    }

    /** Hide the 3 stars slots */
    private async hideSlots(animated = true) {
        this.starSlot1.hide(animated);
        this.starSlot2.hide(animated);
        await this.starSlot3.hide(animated);
    }

    /** Play grade animation, showing 1, 2, or 3 stars according to the level passed */
    public async playGrade(grade: number) {
        if (grade >= 1) {
            await this.star1.playStamp();
            earthquake(app.stage.pivot, 4);
            sfx.play('common/sfx-correct.wav', { speed: 0.9 });
        }

        if (grade >= 2) {
            await this.star2.playStamp();
            earthquake(app.stage.pivot, 8);
            sfx.play('common/sfx-correct.wav', { speed: 1.0 });
        }

        if (grade >= 3) {
            await this.star3.playStamp();
            earthquake(app.stage.pivot, 16);
            sfx.play('common/sfx-correct.wav', { speed: 1.5 });
        }
    }
}
