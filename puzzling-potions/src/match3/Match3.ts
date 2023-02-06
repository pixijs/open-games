import { Container } from 'pixi.js';
import { Match3Actions } from './Match3Actions';
import { Match3Board } from './Match3Board';
import { Match3Config, match3GetConfig } from './Match3Config';
import { Match3Piece } from './Match3Piece';
import { Match3Process } from './Match3Process';
import { Match3Special } from './Match3Special';
import { Match3Stats } from './Match3Stats';
import { Match3Timer } from './Match3Timer';
import { Match3Position, Match3Type } from './Match3Utility';

export interface Match3OnMatchData {
    matches: Match3Position[][];
    combo: number;
}

export interface Match3OnPopData {
    type: Match3Type;
    piece: Match3Piece;
    combo: number;
    isSpecial: boolean;
    causedBySpecial: boolean;
}

export interface Match3OnMoveData {
    from: Match3Position;
    to: Match3Position;
    valid: boolean;
}

/**
 * The main match3 class that sets up game's sub-systems and provide some useful callbacks
 */
export class Match3 extends Container {
    public config: Match3Config;

    // Match3 sub-systems
    public timer: Match3Timer;
    public stats: Match3Stats;
    public board: Match3Board;
    public actions: Match3Actions;
    public process: Match3Process;
    public special: Match3Special;

    // All game events, as plain callbacks for simplicity
    public onMove?: (data: Match3OnMoveData) => void;
    public onMatch?: (data: Match3OnMatchData) => void;
    public onPop?: (data: Match3OnPopData) => void;
    public onProcessStart?: () => void;
    public onProcessComplete?: () => void;
    public onTimesUp?: () => void;

    constructor() {
        super();

        // Match3 game basic configuration
        this.config = match3GetConfig();

        // Counts the gameplay time
        this.timer = new Match3Timer(this);

        // Compute score, grade, number of matches
        this.stats = new Match3Stats(this);

        // Holds the grid state and display
        this.board = new Match3Board(this);

        // Sort out actions that the player can take
        this.actions = new Match3Actions(this);

        // Process matches and fills up the grid
        this.process = new Match3Process(this);

        // Handles pieces with special powers
        this.special = new Match3Special(this);
    }

    /**
     * Sets up a new match3 game with pieces, rows, columns, duration, etc.
     * @param config The config object in which the game will be based on
     */
    public setup(config: Match3Config) {
        this.config = config;
        this.reset();
        this.actions.setup(config);
        this.board.setup(config);
        this.timer.setup(config.duration * 1000);
    }

    /** Fully reset the game */
    public reset() {
        this.interactiveChildren = false;
        this.timer.reset();
        this.stats.reset();
        this.board.reset();
        this.special.reset();
        this.process.reset();
    }

    /** Start the timer and enable interaction */
    public startPlaying() {
        this.interactiveChildren = true;
        this.timer.start();
    }

    /** Stop the timer and disable interaction */
    public stopPlaying() {
        this.interactiveChildren = false;
        this.timer.stop();
    }

    /** Check if the game is still playing */
    public isPlaying() {
        return this.interactiveChildren;
    }

    /** Pause the game */
    public pause() {
        this.timer.pause();
        this.board.pause();
        this.process.pause();
    }

    /** Resume the game */
    public resume() {
        this.timer.resume();
        this.board.resume();
        this.process.resume();
    }

    /** Update the timer */
    public update(detlaMs: number) {
        this.timer.update(detlaMs);
    }
}
