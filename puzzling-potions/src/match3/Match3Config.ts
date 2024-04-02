/** List of all valid game modes */
export const match3ValidModes = ['test', 'easy', 'normal', 'hard'] as const;

/** The game mode type */
export type Match3Mode = (typeof match3ValidModes)[number];

/**
 * Map of all available blocks for the game, ordered by game mode.
 * Each item in these lists should have a corresponding pixi texture with the same name
 */
const blocks: Record<Match3Mode | 'special', string[]> = {
    /** Test mode piece set */
    test: ['piece-dragon', 'piece-frog', 'piece-newt'],
    /** Easy mode piece set */
    easy: ['piece-dragon', 'piece-frog', 'piece-newt', 'piece-snake'],
    /** Normal mode piece set */
    normal: ['piece-dragon', 'piece-frog', 'piece-newt', 'piece-snake', 'piece-spider'],
    /** Hard mode piece set */
    hard: ['piece-dragon', 'piece-frog', 'piece-newt', 'piece-snake', 'piece-spider', 'piece-yeti'],
    /** Special types that will be added to the game regardless the mode */
    special: ['special-blast', 'special-row', 'special-column', 'special-colour'],
};

/** Default match3 configuration */
const defaultConfig = {
    /** Number of rows in the game */
    rows: 9,
    /** Number of columns in the game */
    columns: 7,
    /** The size (width & height, in pixels) of each cell in the grid */
    tileSize: 50,
    /** Validate all moves, regardless if they create a match or not */
    freeMoves: false,
    /** Gameplay duration, in seconds */
    duration: 60,
    /** Gameplay mode - affects the number of piece types in the grid */
    mode: <Match3Mode>'normal',
};

/** Match3 configuration */
export type Match3Config = typeof defaultConfig;

/** Build a config object overriding default values if suitable */
export function match3GetConfig(customConfig: Partial<Match3Config> = {}): Match3Config {
    return { ...defaultConfig, ...customConfig };
}

/** Mount a list of blocks available for given game mode */
export function match3GetBlocks(mode: Match3Mode): string[] {
    return [...blocks[mode], ...blocks.special];
}
