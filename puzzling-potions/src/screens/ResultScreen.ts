import { Container, NineSliceSprite, Sprite, Texture } from 'pixi.js';
import gsap from 'gsap';
import { Label } from '../ui/Label';
import { i18n } from '../utils/i18n';
import { ResultStars } from '../ui/ResultStars';
import { Dragon } from '../ui/Dragon';
import { LargeButton } from '../ui/LargeButton';
import { GameScreen } from './GameScreen';
import { navigation } from '../utils/navigation';
import { CloudLabel } from '../ui/CloudLabel';
import { ResultScore } from '../ui/ResultScore';
import { RippleButton } from '../ui/RippleButton';
import { SettingsPopup } from '../popups/SettingsPopup';
import { bgm, sfx } from '../utils/audio';
import { userSettings } from '../utils/userSettings';
import { waitFor } from '../utils/asyncUtils';
import { MaskTransition } from '../ui/MaskTransition';
import { userStats } from '../utils/userStats';

/** APpears after gameplay ends, displaying scores and grade */
export class ResultScreen extends Container {
    /** Assets bundles required by this screen */
    public static assetBundles = ['result', 'common'];
    /** The centered box area containing the results */
    private panel: Container;
    /** Animated dragon */
    private dragon: Dragon;
    /** The panel background */
    private panelBase: Sprite;
    /** The screen title */
    private title: Label;
    /** The current game mode label */
    private mode: Label;
    /** The static white cauldron */
    private cauldron: Sprite;
    /** The performance message, according to grade */
    private message: CloudLabel;
    /** The gameplay final score in current game mode */
    private score: ResultScore;
    /** The best score in current game mode */
    private bestScore: ResultScore;
    /** The animated stars that represent the grade */
    private stars: ResultStars;
    /** The footer base */
    private bottomBase: NineSliceSprite;
    /** Button that goes back to the game to play again */
    private continueButton: LargeButton;
    /** Button that opens the settings panel */
    private settingsButton: RippleButton;
    /** A special transition that temporarely masks the entire screen */
    private maskTransition?: MaskTransition;

    constructor() {
        super();

        this.settingsButton = new RippleButton({
            image: 'icon-settings',
            ripple: 'icon-settings-stroke',
        });
        this.settingsButton.onPress.connect(() => navigation.presentPopup(SettingsPopup));
        this.addChild(this.settingsButton);

        this.dragon = new Dragon();
        this.dragon.playTransition();
        this.addChild(this.dragon);

        this.panel = new Container();
        this.addChild(this.panel);

        this.panelBase = Sprite.from('result-base');
        this.panelBase.anchor.set(0.5);
        this.panel.addChild(this.panelBase);

        this.title = new Label('', { fill: 0xffffff });
        this.title.y = -160;
        this.panel.addChild(this.title);

        this.mode = new Label('', { fill: 0xffffff, fontSize: 12 });
        this.mode.y = -140;
        this.mode.alpha = 0.5;
        this.panel.addChild(this.mode);

        this.cauldron = Sprite.from('white-cauldron');
        this.cauldron.anchor.set(0.5);
        this.cauldron.y = 145;
        this.panel.addChild(this.cauldron);

        this.message = new CloudLabel({ color: 0xffffff, labelColor: 0x2c136c });
        this.message.y = -95;
        this.panel.addChild(this.message);

        this.score = new ResultScore();
        this.score.y = 60;
        this.panel.addChild(this.score);

        this.bestScore = new ResultScore(0xffd579);
        this.bestScore.y = 90;
        this.bestScore.scale.set(0.7);
        this.panel.addChild(this.bestScore);

        this.stars = new ResultStars();
        this.stars.y = -10;
        this.panel.addChild(this.stars);

        this.bottomBase = new NineSliceSprite({
            texture: Texture.from('rounded-rectangle'),
            leftWidth: 32,
            topHeight: 32,
            rightWidth: 32,
            bottomHeight: 32,
        });
        this.bottomBase.tint = 0x2c136c;
        this.bottomBase.height = 200;
        this.addChild(this.bottomBase);

        this.continueButton = new LargeButton({ text: i18n.resultPlay });
        this.addChild(this.continueButton);
        this.continueButton.onPress.connect(() => navigation.showScreen(GameScreen));

        this.maskTransition = new MaskTransition();
    }

    /** Prepare the screen just before showing */
    public prepare() {
        this.bottomBase.visible = false;
        this.continueButton.visible = false;
        this.panel.visible = false;
        this.dragon.visible = false;
        this.score.visible = false;
        this.bestScore.visible = false;
        this.message.hide(false);
        this.stars.hide(false);

        this.title.text = `${i18n.resultTitle}`;
        const mode = userSettings.getGameMode();
        const readableMode = (i18n as any)[mode + 'Mode'];
        this.mode.text = `${readableMode}`;
    }

    /** Resize the screen, fired whenever window size changes */
    public resize(width: number, height: number) {
        this.dragon.x = width * 0.5 + 20;
        this.dragon.y = height * 0.5 - 210;
        this.panel.x = width * 0.5;
        this.panel.y = height * 0.5;
        this.continueButton.x = width * 0.5;
        this.continueButton.y = height - 90;
        this.bottomBase.width = width;
        this.bottomBase.y = height - 100;
        this.settingsButton.x = width - 30;
        this.settingsButton.y = 30;
    }

    /** Show screen with animations */
    public async show() {
        bgm.play('common/bgm-main.mp3', { volume: 0.5 });
        // GameScreen hide to a flat colour covering the viewport, which gets replaced
        // by this transition, revealing this screen
        this.maskTransition?.playTransitionIn();

        // Wait a little bit before showing all screen components
        await waitFor(0.5);
        const mode = userSettings.getGameMode();
        const performance = userStats.load(mode);
        this.showDragon();
        await this.showPanel();
        this.animateGradeStars(performance.grade);
        await this.animatePoints(performance.score);
        await this.animateGradeMessage(performance.grade);
        this.showBottom();
    }

    /** Hide screen with animations */
    public async hide() {
        this.hideBottom();
        await this.hideDragon();
        await this.hidePanel();
    }

    /** Reveal the animated dragon behind the panel */
    private async showDragon() {
        gsap.killTweensOf(this.dragon.scale);
        gsap.killTweensOf(this.dragon.pivot);
        this.dragon.visible = true;
        this.dragon.scale.set(0);
        this.dragon.pivot.y = -300;
        gsap.to(this.dragon.pivot, {
            y: 0,
            duration: 0.7,
            ease: 'back.out',
            delay: 0.1,
        });
        await gsap.to(this.dragon.scale, {
            x: 1,
            y: 1,
            duration: 0.3,
            ease: 'back.out',
            delay: 0.2,
        });
    }

    /** Hide the animated dragon behind the panel */
    private async hideDragon() {
        gsap.killTweensOf(this.dragon.pivot);
        await gsap.to(this.dragon.pivot, {
            y: -100,
            duration: 0.2,
            ease: 'back.in',
        });
        this.dragon.scale.set(0);
    }

    /** Show the container box panel animated */
    private async showPanel() {
        gsap.killTweensOf(this.panel.scale);
        this.panel.visible = true;
        this.panel.scale.set(0);
        await gsap.to(this.panel.scale, {
            x: 1,
            y: 1,
            duration: 0.4,
            ease: 'back.out',
        });
    }

    /** Hide the container box panel animated */
    private async hidePanel() {
        gsap.killTweensOf(this.panel.scale);
        await gsap.to(this.panel.scale, {
            x: 0,
            y: 0,
            duration: 0.3,
            ease: 'back.in',
        });
    }

    /** Show footer items (purple base + playbutton) animated */
    private async showBottom() {
        this.bottomBase.visible = true;
        this.continueButton.visible = true;
        gsap.killTweensOf(this.bottomBase);
        this.bottomBase.pivot.y = -200;
        gsap.killTweensOf(this.continueButton.pivot);
        this.continueButton.pivot.y = -200;

        gsap.to(this.bottomBase.pivot, {
            y: 0,
            duration: 0.3,
            ease: 'back.out',
            delay: 0.3,
        });

        await gsap.to(this.continueButton.pivot, {
            y: 0,
            duration: 0.4,
            ease: 'back.out',
            delay: 0.4,
        });
    }

    /** Hide footer items (purple base + playbutton) animated */
    private async hideBottom() {
        gsap.killTweensOf(this.bottomBase);
        gsap.killTweensOf(this.continueButton.pivot);

        gsap.to(this.bottomBase.pivot, {
            y: -200,
            duration: 0.3,
            ease: 'back.in',
        });

        await gsap.to(this.continueButton.pivot, {
            y: -200,
            duration: 0.4,
            ease: 'back.in',
        });
    }

    /** Play points and best score animation */
    private async animatePoints(points: number) {
        await this.score.show();
        await this.score.playScore(points);

        if (!points) return;

        const mode = userSettings.getGameMode();
        const bestScore = userStats.loadBestScore(mode);

        this.bestScore.show();
        if (points >= bestScore) {
            this.bestScore.setText(i18n.newBestScore);
        } else {
            this.bestScore.setText(i18n.bestScorePrefix + bestScore);
        }
    }

    /** Play grade stars animation */
    private async animateGradeStars(grade: number) {
        await this.stars.show();
        await this.stars.playGrade(grade);
    }

    /** Play grade payoff message */
    private async animateGradeMessage(grade: number) {
        await waitFor(0.1);
        const messages = i18n as Record<string, string>;
        const message = 'grade' + grade;
        this.message.text = messages[message];
        if (grade < 1) {
            sfx.play('common/sfx-incorrect.wav');
        } else {
            sfx.play('common/sfx-special.wav');
        }
        await this.message.show();
    }
}
