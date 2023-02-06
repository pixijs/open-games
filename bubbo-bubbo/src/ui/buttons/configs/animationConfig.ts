/**
 * Contains common animation states to be used in the `FancyButton` class
 */
export const getAnimations = (scale: number) => ({
    default: {
        props: {
            scale: {
                x: scale,
                y: scale,
            },
        },
        duration: 100,
    },
    hover: {
        props: {
            scale: {
                x: scale * 1.1,
                y: scale * 1.1,
            },
        },
        duration: 100,
    },
    pressed: {
        props: {
            scale: {
                x: scale * 0.9,
                y: scale * 0.9,
            },
        },
        duration: 100,
    },
});
