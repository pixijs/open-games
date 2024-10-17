import { Match3, Match3OnMatchData, Match3OnPopData } from './Match3';

/** Default gameplay stats data */
const defaultStatsData = {
    score: 0,
    matches: 0,
    pops: 0,
    specials: 0,
    grade: 0,
};

/** gameplay stats data */
export type Match3StatsData = typeof defaultStatsData;

/**
 * Computes scores and general gameplay stats during the session.
 */
export class Match3Stats {
    /** The Match3 instance */
    private match3: Match3;
    /** Current internal stats data */
    private data: Match3StatsData;

    constructor(match3: Match3) {
        this.match3 = match3;
        this.data = { ...defaultStatsData };
    }

    /**
     * Reset all stats
     */
    public reset() {
        this.data = { ...defaultStatsData };
    }

    /**
     * Update stats params based on given params
     * @param data The piece pop data
     */
    public registerPop(data: Match3OnPopData) {
        const points = data.causedBySpecial ? 3 : 1;
        this.data.score += points;
        this.data.pops += 1;
        if (data.isSpecial) {
            this.data.specials += 1;
        }
    }

    /**
     * Update stats params based on given match data
     * @param data The match data
     */
    public registerMatch(data: Match3OnMatchData) {
        for (const match of data.matches) {
            const points = match.length + data.matches.length * data.combo;
            this.data.score += points;
            this.data.matches += 1;
        }
    }

    /**
     * Calculate a grade from 0 (worst) to 3 (best) based on given score and playtime
     * @param score The score to calculated
     * @param playTime The play time (in milliseconds) of the score
     * @returns An number (0 to 3) representing the grade
     */
    public caulculateGrade(score: number, playTime: number) {
        const avgPointsPerSecond = 8;
        const gameplayTimeInSecs = playTime / 1000;
        const pointsPerSecond = score / gameplayTimeInSecs;

        let grade = 0;
        if (pointsPerSecond > avgPointsPerSecond * 2) {
            grade = 3;
        } else if (pointsPerSecond > avgPointsPerSecond) {
            grade = 2;
        } else if (pointsPerSecond > avgPointsPerSecond * 0.1) {
            grade = 1;
        }

        return grade;
    }

    public getScore() {
        return this.data.score;
    }

    /**
     * Retrieve full gameplay session performance in an object
     */
    public getGameplayPerformance() {
        const grade = this.caulculateGrade(this.data.score, this.match3.timer.getTime());
        return { ...this.data, grade };
    }
}
