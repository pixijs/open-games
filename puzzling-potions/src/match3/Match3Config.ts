export const match3ValidModes = ['test', 'easy', 'normal', 'hard'] as const;

/** The game mode type */
export type Match3Mode = typeof match3ValidModes[number];

/**
 * Map of all available blocks for the game, ordered by game mode.
 * Each item in these lists should have a corresponding pixi texture with the same name
 */
const blocks: Record<Match3Mode | 'special', string[]> = {
    test: ['piece-dragon', 'piece-frog', 'piece-newt'],
    easy: ['piece-dragon', 'piece-frog', 'piece-newt', 'piece-snake'],
    normal: ['piece-dragon', 'piece-frog', 'piece-newt', 'piece-snake', 'piece-spider'],
    hard: ['piece-dragon', 'piece-frog', 'piece-newt', 'piece-snake', 'piece-spider', 'piece-yeti'],
    special: ['special-blast', 'special-row', 'special-column', 'special-colour'],
};

/** Default match3 configuration */
const defaultConfig = {
    rows: 9,
    columns: 7,
    tileSize: 50,
    freeMoves: false,
    duration: 60,
    mode: <Match3Mode>'normal',
};

export type Match3Config = typeof defaultConfig;

/** Build a config object overriding default values if suitable */
export function match3GetConfig(customConfig: Partial<Match3Config> = {}): Match3Config {
    return { ...defaultConfig, ...customConfig };
}

/** Mount a list of blocks available for given game mode */
export function match3GetBlocks(mode: Match3Mode): string[] {
    return [...blocks[mode], ...blocks.special];
}
