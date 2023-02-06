/** Minimum screen width before the resizing function shrinks the view. */
const minWidth = 428;
/** Minimum screen height before the resizing function shrinks the view. */
const minHeight = 925;

/** Object to store all configuration values for the out of gameplay design logic. */
export const designConfig = {
    content: {
        width: minWidth,
        height: minHeight,
    },
    /** Enable to be able to see the collision bodies of the bubbles. */
    debugBody: false,
    /** Tile scale for the background elements found in each screen. */
    backgroundTileScale: 2,
    /** To prevent the background decor visuals from spawning too close to the sides of the screen. */
    decorEdgePadding: 100,
    /** To prevent the background decor visuals from spawning too close to one another. */
    decorMinDistance: 150,
    /** How many background decor visuals are allowed to be created on desktop. */
    decorCountDesktop: 6,
    /** How many background decor visuals are allowed to be created on mobile. */
    decorCountMobile: 3,
    /** The url used to redirect the user to the open games github page */
    forkMeURL: 'https://github.com/pixijs/open-games',
};
