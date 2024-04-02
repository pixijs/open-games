import { Container, Ticker } from 'pixi.js';
import gsap from 'gsap';
import { Match3, Match3OnMatchData, Match3OnMoveData, Match3OnPopData } from '../match3/Match3';
import { Shelf } from '../ui/Shelf';
import { getUrlParam, getUrlParamNumber } from '../utils/getUrlParams';
import { GameTimer } from '../ui/GameTimer';
import { navigation } from '../utils/navigation';
import { ResultScreen } from './ResultScreen';
import { GameScore } from '../ui/GameScore';
import { CloudLabel } from '../ui/CloudLabel';
import { i18n } from '../utils/i18n';
import { Cauldron } from '../ui/Cauldron';
import { RippleButton } from '../ui/RippleButton';
import { SettingsPopup } from '../popups/SettingsPopup';
import { PausePopup } from '../popups/PausePopup';
import { GameCountdown } from '../ui/GameCountdown';
import { GameEffects } from '../ui/GameEffects';
import { bgm } from '../utils/audio';
import { userSettings } from '../utils/userSettings';
import { GameTimesUp } from '../ui/GameTimesUp';
import { GameOvertime } from '../ui/GameOvertime';
import { waitFor } from '../utils/asyncUtils';
import { match3GetConfig, Match3Mode } from '../match3/Match3Config';
import { userStats } from '../utils/userStats';

/** The screen tha holds the Match3 game */
export class GameScreen extends Container {
    /** Assets bundles required by this screen */
    public static assetBundles = ['game', 'common'];
    /** The Math3 game */
    public readonly match3: Match3;
    /** Animated cauldron */
    public readonly cauldron: Cauldron;
    /** Inner container for the match3 */
    public readonly gameContainer: Container;
    /** The gameplay timer display */
    public readonly timer: GameTimer;
    /** The game score display */
    public readonly score: GameScore;
    /** Combo message displayed when combo-ing */
    public readonly comboMessage: CloudLabel;
    /** Combo level displayed when combo-ing */
    public readonly comboLevel: CloudLabel;
    /** Button for pausing the game */
    public readonly pauseButton: RippleButton;
    /** Button that opens the settings panel */
    public readonly settingsButton: RippleButton;
    /** Countdown displayed before actual gameplay starts */
    public readonly countdown: GameCountdown;
    /** Countdown displayed when the gameplay is about to finish */
    public readonly overtime: GameOvertime;
    /** The time's up message that shows up when gameplay finishes */
    public readonly timesUp: GameTimesUp;
    /** The match3 book shelf background */
    public readonly shelf?: Shelf;
    /** The special effects layer for the match3 */
    public readonly vfx?: GameEffects;
    /** Set to true when gameplay is finished */
    private finished = false;

    constructor() {
        super();

        this.pauseButton = new RippleButton({
            image: 'icon-pause',
            ripple: 'icon-pause-stroke',
        });
        this.pauseButton.onPress.connect(() => navigation.presentPopup(PausePopup));
        this.addChild(this.pauseButton);

        this.settingsButton = new RippleButton({
            image: 'icon-settings',
            ripple: 'icon-settings-stroke',
        });
        this.settingsButton.onPress.connect(() => navigation.presentPopup(SettingsPopup));
        this.addChild(this.settingsButton);

        this.gameContainer = new Container();
        this.addChild(this.gameContainer);

        this.shelf = new Shelf();
        this.gameContainer.addChild(this.shelf);

        this.match3 = new Match3();
        this.match3.onMove = this.onMove.bind(this);
        this.match3.onMatch = this.onMatch.bind(this);
        this.match3.onPop = this.onPop.bind(this);
        this.match3.onProcessComplete = this.onProcessComplete.bind(this);
        this.match3.onTimesUp = this.onTimesUp.bind(this);
        this.gameContainer.addChild(this.match3);

        this.score = new GameScore();
        this.addChild(this.score);

        this.comboMessage = new CloudLabel({ color: 0x2c136c, labelColor: 0xffffff });
        this.comboMessage.text = i18n.comboMessage;
        this.comboMessage.hide(false);
        this.addChild(this.comboMessage);

        this.comboLevel = new CloudLabel({ color: 0x2c136c, labelColor: 0xffffff });
        this.comboLevel.text = 'x8';
        this.comboLevel.hide(false);
        this.addChild(this.comboLevel);

        this.cauldron = new Cauldron(true);
        this.addChild(this.cauldron);

        this.timer = new GameTimer();
        this.cauldron.addContent(this.timer);

        this.vfx = new GameEffects(this);
        this.addChild(this.vfx);

        this.countdown = new GameCountdown();
        this.addChild(this.countdown);

        this.overtime = new GameOvertime();
        this.addChild(this.overtime);

        this.timesUp = new GameTimesUp();
        this.addChild(this.timesUp);
    }

    /** Prepare the screen just before showing */
    public prepare() {
        const match3Config = match3GetConfig({
            rows: getUrlParamNumber('rows') ?? 9,
            columns: getUrlParamNumber('columns') ?? 7,
            tileSize: getUrlParamNumber('tileSize') ?? 50,
            freeMoves: getUrlParam('freeMoves') !== null,
            duration: getUrlParamNumber('duration') ?? 60,
            mode: (getUrlParam('mode') as Match3Mode) ?? userSettings.getGameMode(),
        });

        this.finished = false;
        this.shelf?.setup(match3Config);
        this.match3.setup(match3Config);
        this.pauseButton.hide(false);
        this.cauldron.hide(false);
        this.score.hide(false);
        gsap.killTweensOf(this.gameContainer.pivot);
        this.gameContainer.pivot.y = -navigation.height * 0.7;
        gsap.killTweensOf(this.timer.scale);
    }

    /** Update the screen */
    public update(time: Ticker) {
        this.match3.update(time.deltaMS);
        this.timer.updateTime(this.match3.timer.getTimeRemaining());
        this.overtime.updateTime(this.match3.timer.getTimeRemaining());
        this.score.setScore(this.match3.stats.getScore());
    }

    /** Pause gameplay - automatically fired when a popup is presented */
    public async pause() {
        this.gameContainer.interactiveChildren = false;
        this.match3.pause();
    }

    /** Resume gameplay */
    public async resume() {
        this.gameContainer.interactiveChildren = true;
        this.match3.resume();
    }

    /** Fully reset the game, clearing all pieces and shelf blocks */
    public reset() {
        this.shelf?.reset();
        this.match3.reset();
    }

    /** Resize the screen, fired whenever window size changes */
    public resize(width: number, height: number) {
        const div = height * 0.3;
        const centerX = width * 0.5;
        const centerY = height * 0.5;

        this.gameContainer.x = centerX;
        this.gameContainer.y = div + this.match3.board.getHeight() * 0.5 + 20;
        this.score.x = centerX;
        this.score.y = 10;
        this.comboMessage.x = centerX - 150;
        this.comboMessage.y = div - 50;
        this.comboLevel.x = centerX + 150;
        this.comboLevel.y = div - 50;
        this.cauldron.x = centerX;
        this.cauldron.y = div - 60;
        this.pauseButton.x = 30;
        this.pauseButton.y = 30;
        this.settingsButton.x = width - 30;
        this.settingsButton.y = 30;
        this.countdown.x = centerX;
        this.countdown.y = centerY;
        this.timesUp.x = centerX;
        this.timesUp.y = centerY;
        this.overtime.x = this.gameContainer.x;
        this.overtime.y = this.gameContainer.y;
    }

    /** Show screen with animations */
    public async show() {
        bgm.play('common/bgm-game.mp3', { volume: 0.5 });
        await gsap.to(this.gameContainer.pivot, { y: 0, duration: 0.5, ease: 'back.out' });
        await this.countdown.show();
        await this.cauldron.show();
        await this.countdown.hide();
        this.score.show();
        this.pauseButton.show();
        this.match3.startPlaying();
    }

    /** Hide screen with animations */
    public async hide() {
        this.overtime.hide();
        this.vfx?.playGridExplosion();
        await waitFor(0.3);
        await this.timesUp.playRevealAnimation();
        await this.timesUp.playExpandAnimation();
    }

    /** Fired when the player moves a piece */
    private onMove(data: Match3OnMoveData) {
        this.vfx?.onMove(data);
    }

    /** Fired when match3 detects one or more matches in the grid */
    private onMatch(data: Match3OnMatchData) {
        if (data.combo > 1) {
            this.comboMessage.show();
            this.comboLevel.show();
            this.comboLevel.text = 'x' + data.combo;
        }

        this.vfx?.onMatch(data);
    }

    /** Fired when a piece is poped out fro the board */
    private onPop(data: Match3OnPopData) {
        this.vfx?.onPop(data);
    }

    /** Fires when the match3 grid finishes auto-processing */
    private onProcessComplete() {
        this.comboMessage.hide();
        this.comboLevel.hide();
        // Only finishes the game if timer already ended
        if (!this.match3.timer.isRunning()) this.finish();
    }

    /** Fires when the game timer ends */
    private onTimesUp() {
        this.pauseButton.hide();
        this.match3.stopPlaying();
        // Only finishes the game if match 3 is not auto-processing the grid
        if (!this.match3.process.isProcessing()) this.finish();
    }

    /** Finish the gameplay, save stats and go to the results */
    private async finish() {
        if (this.finished) return;
        this.finished = true;
        this.match3.stopPlaying();
        const performance = this.match3.stats.getGameplayPerformance();
        userStats.save(this.match3.config.mode, performance);
        navigation.showScreen(ResultScreen);
    }

    /** Auto pause the game when window go out of focus */
    public blur() {
        if (!navigation.currentPopup && this.match3.isPlaying()) {
            navigation.presentPopup(PausePopup);
        }
    }
}
