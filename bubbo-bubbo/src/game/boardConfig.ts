import { randomItem } from '../utils/maths/rand';
import { designConfig } from './designConfig';

/** Constants for the types of regular bubbles. */
const BUBBLE_TYPES = ['yellow', 'green', 'red', 'blue'];
/** Constants for the types of special bubbles. */
const SPECIAL_BUBBLE_TYPES = ['bomb', 'super', 'timer'];

/** Type aliases for regular bubble types. */
export type SpecialBubbleType = (typeof SPECIAL_BUBBLE_TYPES)[number];
/** Type aliases for special bubble types. */
export type RegularBubbleType = (typeof BUBBLE_TYPES)[number];

/** Type alias for all bubble types (regular or special). */
export type BubbleType = RegularBubbleType | SpecialBubbleType;

/** The initial types of bubbles in the game. */
const INITIAL_BUBBLE_TYPES: BubbleType[] = ['red', 'green', 'blue'];

// Constants for the configuration of the bubble board
/** The maximum number of bubbles per line. */
const MAX_BUBBLES_PER_LINE = 13;
/** The overflow amount for each bubble, used to set the bubbles half way outside of screen space. */
const BUBBLE_OVERFLOW = 0.5;

/** The size of each bubble. */
const BUBBLE_SIZE = designConfig.content.width / MAX_BUBBLES_PER_LINE;

/** A Map of each regular bubble type relative to its color. */
const bubbleTypeToColor: Record<RegularBubbleType, number> = {
    yellow: 0xffca42,
    green: 0x58ff2e,
    red: 0xff5f5f,
    blue: 0x6473ff,
};

/** Object to store all configuration values for the game logic. */
export const boardConfig = {
    /** The top of the screen. */
    screenTop: -designConfig.content.height,
    /** The minimum heterogeneity value. */
    minHeterogeneity: 0.5,
    /** The increment for heterogeneity value. */
    heterogeneityIncrement: 0.01,
    /** The starting number of lines of bubbles. */
    startingLines: 10,

    /** Special bubble appears every nth line. */
    specialBubbleEvery: 3,
    /** Chance of a special bubble appearing. */
    specialBubbleChance: 0.01,

    /** The initial types of bubbles. */
    startingBubbleTypes: INITIAL_BUBBLE_TYPES,
    /** All available regular bubble types. */
    bubbleTypes: BUBBLE_TYPES,
    /** All available special bubble types. */
    specialBubbleTypes: SPECIAL_BUBBLE_TYPES,
    /** Map of regular bubble types to colors. */
    bubbleTypeToColor,
    /** Maximum number of bubbles per line. */
    bubblesPerLine: MAX_BUBBLES_PER_LINE,
    /** The size of each bubble. */
    bubbleSize: BUBBLE_SIZE,
    /** The overflow amount for each bubble, used to set the bubbles half way outside of screen space. */
    bubbleOverflow: BUBBLE_OVERFLOW,

    /** The line that determines if a bubble has reached the bottom of the game zone. */
    bounceLine: 145,

    /** The maximum length of the aim lines. */
    maxAimLinesLength: 600,
    /** The maximum number of aim lines allowed, to prevent infinite rebound aim lines. */
    maxAimLines: 2,

    newLine: {
        /** Time for the animation when a new line of bubbles is added. */
        animInTime: 3,
        /** Time for the animation in urgent cases (when the remaining number of lines is less than `urgentMinLines`). */
        urgentAnimInTime: 0.15,
        /** The minimum number of remaining lines that triggers the urgency animation. */
        urgentMinLines: 8,
        /** Decrement in time for each subsequent new line of bubbles that are added. */
        animInDecrement: 0.05,
        /** Maximum decrement in time for the animation. */
        maxDecrement: 1.5,
        /** Decrement interval for the animation. */
        decrementIn: 5,
    },

    /** The increment in score for each bubble that is popped. */
    scoreIncrement: 10,

    power: {
        /** The blast radius for the power-up "bomb". */
        blastRadius: 2,
        /** The freeze time for the power-up "timer". */
        timerFreezeTime: 5,
    },
};

/**
 * Returns a random bubble type from the given group.
 * @param group The group of bubble types to choose from ('all', 'regular', or 'special').
 * @returns A randomly selected bubble type.
. */
export function randomType(group?: 'all' | 'regular' | 'special') {
    switch (group) {
        case 'all':
            return randomItem([...boardConfig.specialBubbleTypes, ...boardConfig.bubbleTypes]);
        case 'special':
            return randomItem(boardConfig.specialBubbleTypes);
        default:
            return randomItem(boardConfig.bubbleTypes);
    }
}

/**
 * Determines if the given type is a special bubble type.
 * @param type The type of the bubble.
 * @returns True if the type is a special bubble type, false otherwise.
. */
export function isSpecialType(type: BubbleType) {
    return boardConfig.specialBubbleTypes.includes(type);
}
