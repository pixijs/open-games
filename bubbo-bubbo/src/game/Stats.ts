import { storage } from '../storage';

/**
 * The default stats of a user, used to create fully defined initial stats,
 * as well as reset values. The stats reset every game.
 */
const DEFAULT_STATS = {
    /** Player's total score. */
    score: 0,
    /** Player's highscore. */
    highscore: 0,
    /** How many bubbles the player has dislodged from the level */
    bubblesPopped: 0,
    /** Highest amount of `bubblesPopped` per player shot */
    bestCombo: 0,
    /** How many powerups have been triggered */
    powerupsUsed: 0,
};

/** Type defined from the default data. */
export type StatType = typeof DEFAULT_STATS;
/** Keys defined from the default data. */
export type StatKey = keyof StatType;

/** A class that deals with user specific stats. */
export class Stats {
    /**
     * An object containing the user's stats,
     * defaults to `DEFAULT_STATS` on instantiation.
     * Uses object spread operator to prevent overwrite of default data.
     */
    private _stats = { ...DEFAULT_STATS };

    constructor() {
        // Sets the stat highscore to be the stored highscore
        this.set('highscore', storage.getStorageItem('highscore'));
    }

    /**
     * Sets a value on the designated stat.
     * @param stat - The key of the stat.
     * @param value - The value to be set.
     * @returns The same value put in.
     */
    public set<T extends StatKey>(stat: T, value: StatType[T]) {
        this._stats[stat] = value;

        return this.get(stat);
    }

    /**
     * Gets the designated stat.
     * @param stat - The key of the stat.
     * @return The value of the designated stat.
     */
    public get<T extends StatKey>(stat: T): StatType[T];
    /**
     * Gets all the available stats.
     * @return The full stat object.
     */
    public get(): StatType;
    public get<T extends StatKey>(stat?: T): StatType[T] | StatType {
        if (stat) {
            return this._stats[stat];
        }

        return this._stats;
    }

    /**
     * Incremenets a stat based on the value provided.
     * If none is provided, defaults to `1`.
     * @param stat - The key of the stat.
     * @param value - The value to be incremented.
     * @returns The incremented stat.
     */
    public increment<T extends StatKey>(stat: T, value: StatType[T] = 1) {
        if (typeof this._stats[stat] === 'number') {
            (this._stats[stat] as number) += value as number;
        } else {
            console.warn(`Cannot increment non-number stat: ${stat}`);
        }

        return this.get(stat);
    }

    /** Resets the player stats. The stats reset every game. */
    public reset() {
        this._stats = { ...DEFAULT_STATS };
    }
}
