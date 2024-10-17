import { Match3Mode } from '../match3/Match3Config';
import { Match3StatsData } from '../match3/Match3Stats';
import { storage } from './storage';

// Keys for saved items in storage
const KEY_PREFIX_STATS = 'stats-';
const KEY_PREFIX_BEST_SCORE = 'stats-best-score-';

/**
 * Organise persistent user gameplay stats by game mode, meaning that each
 * game mode will have its own score and best score saved, also a bunch of other
 * properties that could be useful like number of matches, popped pieces, etc.
 */
export class UserStats {
    /**
     * Load last saved gameplay stats for a game mode
     * @param mode A valid game mode
     * @returns Gameplay stats of given mode
     */
    public load(mode: Match3Mode): Match3StatsData {
        const obj = storage.getObject(KEY_PREFIX_STATS + mode);
        if (!obj) {
            return {
                score: 0,
                matches: 0,
                pops: 0,
                specials: 0,
                grade: 0,
            };
        }
        return obj;
    }

    /**
     * Save gameplay stats for given gamemode.It will also update the best score
     * for the game mode, if the provided score is higher.
     * @param mode A valid game mode
     * @param data The stats data to be saved
     */
    public save(mode: Match3Mode, data: Match3StatsData) {
        if (data.score > this.loadBestScore(mode)) {
            storage.setNumber(KEY_PREFIX_BEST_SCORE + mode, data.score);
        }
        storage.setObject(KEY_PREFIX_STATS + mode, data);
    }

    /** Retrieve the saved best score for a game mode */
    public loadBestScore(mode: Match3Mode) {
        return storage.getNumber(KEY_PREFIX_BEST_SCORE + mode) ?? 0;
    }
}

/** Shared user stats instance */
export const userStats = new UserStats();
