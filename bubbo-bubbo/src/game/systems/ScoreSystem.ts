import { storage } from '../../storage';
import { boardConfig } from '../boardConfig';
import { Bubble } from '../entities/Bubble';
import { Game } from '../Game';
import { System } from '../SystemRunner';
import { HudSystem } from './HudSystem';
import { PhysicsSystem } from './PhysicsSystem';

/** A system that handles the score earned in the game. */
export class ScoreSystem implements System {
    /**
     * A unique identifier used by the system runner.
     * The identifier is used by the runner to differentiate between different systems.
     */
    public static SYSTEM_ID = 'score';
    /**
     * The instance of the game the system is attached to.
     * This is automatically set by the system runner when the system is added to the game.
     */
    public game!: Game;

    /** A map to hold the cluster groups, used to group up scoring. */
    private readonly _pointMap = new Map<number, number>();

    /** Called when the system is added to the game. */
    public init() {
        const hud = this.game.systems.get(HudSystem);
        const physics = this.game.systems.get(PhysicsSystem);

        let timeout: NodeJS.Timeout | null = null;

        // Connect the onBubbleBounce signal from the PhysicsSystem to the score increasing logic

        /**
         * Increase the score when a bubble has bounced.
         * @param bubble - the bubble that has bounced.
         */
        physics.signals.onBubbleBounce.connect((bubble: Bubble) => {
            // Get the group that the bubble is attached to using its assigned dropGroupId
            // If one doesn't exist on the map, create one
            const groupCount =
                this._pointMap.get(bubble.dropGroupId) ??
                this._pointMap.set(bubble.dropGroupId, 1).get(bubble.dropGroupId)!;

            const score = boardConfig.scoreIncrement * groupCount;

            // Pass the new total score and individual bubble score to the hud
            hud.updateScore(score, this.game.stats.increment('score', score), bubble);

            // Update the highscore
            if (timeout) clearTimeout(timeout);
            // timeout to prevent localstorage update spam
            timeout = setTimeout(() => {
                this.updateHighscore();
            }, 60);

            // Increase the group count within the map based on the group Id
            this._pointMap.set(bubble.dropGroupId, groupCount + 1);
        });
    }

    /** Update the highscore if the current score is lower than the current highscore. */
    public updateHighscore() {
        const stats = this.game.stats;

        if (stats.get('score') > stats.get('highscore')) {
            const score = stats.get('score');

            // Updates game stats
            stats.set('highscore', score);
            // Updates local storage
            storage.setStorageItem('highscore', score);
        }
    }

    /** Resets the state of the system back to its initial state. */
    public reset() {
        // Clear the _pointMap
        this._pointMap.clear();
    }
}
