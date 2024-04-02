import { Container, PointData, Sprite } from 'pixi.js';

import { device } from '../../utils/device';
import { distance } from '../../utils/maths/point';
import { randomRange } from '../../utils/maths/rand';
import { randomType } from '../boardConfig';
import { designConfig } from '../designConfig';
import { BubbleView } from '../entities/BubbleView';
import { Game } from '../Game';
import { pool } from '../Pool';

/** A class representing a background satellite decor in the game. */
class Satellite {
    /* The container instance that is the root of all visuals in this class. */
    public view = new Container();

    /** A variable used to store the current time state of animation */
    private _tick = 0;
    /** The frequency of the rotation of the satellite */
    private _frequency = 0;
    /** The range of rotation of the satellite */
    private _range = 0.5;

    constructor() {
        // Create visuals
        const satellite = Sprite.from('satellite');

        satellite.anchor.set(0.5);
        this.view.addChild(satellite);
    }

    /** Randomises initial values of the satellite */
    public changeView() {
        // Set a random scale for the satellite view
        this.view.scale.set(randomRange(0.3, 0.9, false));
        // Set a random tick value for the animation
        this._tick = randomRange(-Math.PI * 0.01, Math.PI * 0.01, false);
        // Set a random frequency for the animation speed
        this._frequency = randomRange(1, 2, false);
        // Set a random range for the animation rotation
        this._range = randomRange(-Math.PI * 0.05, Math.PI * 0.05, false);
    }

    /**
     * Called every frame
     * Maintains the rotational effect over time.
     * @param delta - The time elapsed since the last update.
     */
    public update(delta: number) {
        this._tick += delta / 60;

        // Use sine-wave maths to create rotational animation
        const calc = this._tick / this._frequency;
        const sine = this._range * Math.sin(calc);

        // Set satellite rotation to new rotation
        this.view.rotation = sine;
    }
}

/** A class representing a background planet decor in the game. */
class BubbleOrbit {
    /* The container instance that is the root of all visuals in this class. */
    public view = new Container();

    /** The main bubble that all sub-bubbles orbit around. */
    private _mainBubble!: BubbleView;
    /** An array of BubbleView instances that orbit around the main bubble. */
    private _subBubbles: BubbleView[] = [];
    /** An array of angles that describe the position of each sub-bubble along its orbit. */
    private _orbitAngles: number[] = [];
    /** An array of directions (1 or -1) that describe the direction of each sub-bubble's orbit. */
    private _orbitDirections: number[] = [];
    /** An array of radii that describe the size of each sub-bubble's orbit. */
    private _orbitRadii: number[] = [];
    /** An array of speeds that describe how fast each sub-bubble orbits around the main bubble. */
    private _orbitSpeeds: number[] = [];

    /** Changes the visual appearance of the main bubble and sub-bubbles.*/
    public changeView() {
        // If the main bubble exists, reset it to its original state.
        if (this._mainBubble) this.reset();

        // Get a BubbleView instance from the pool and set its type to a random value.
        this._mainBubble = pool.get(BubbleView);
        this._mainBubble.type = randomType();

        // Center the main bubble and add it to the view container.
        this._mainBubble.view.x = 0;
        this._mainBubble.view.y = 0;
        this._mainBubble.view.scale.set(randomRange(0.7, 2.5, false));
        this.view.addChild(this._mainBubble.view);

        // Generate a random number of sub-bubbles to orbit the main bubble.
        const numOfSubBubbles = randomRange(1, 5);

        for (let i = 0; i < numOfSubBubbles; i++) {
            // Get a BubbleView instance from the pool and set its type to a random value.
            this._subBubbles[i] = pool.get(BubbleView);
            this._subBubbles[i].type = randomType();

            // Scale the sub-bubble based on the main bubble's scale.
            this._subBubbles[i].view.scale.set(this._mainBubble.view.scale.x * randomRange(0.3, 0.7, false));

            // Initialize the orbit angle, direction, radius, and speed for this sub-bubble.
            this._orbitAngles[i] = Math.random() * Math.PI;
            this._orbitDirections[i] = Math.sign(randomRange(-1, 1, false));
            this._orbitRadii[i] = this._mainBubble.view.width * 0.5 + this._subBubbles[i].view.width * 0.5 + 10;
            this._orbitSpeeds[i] = (this._subBubbles[i].view.scale.x / this._mainBubble.view.scale.x) * 0.5;

            this.view.addChild(this._subBubbles[i].view);
        }
    }

    /**
     * Reset the current state of the class
     */
    public reset() {
        // Remove the main bubble and sub-bubbles from the view,

        this._mainBubble.view.removeFromParent();

        // Return the sub-bubbles to the object pool.
        for (let i = 0; i < this._subBubbles.length; i++) {
            this._subBubbles[i].view.removeFromParent();
            pool.return(this._subBubbles[i]);
        }

        // Reset the arrays storing sub-bubbles' information
        this._subBubbles.length = 0;
        this._orbitAngles.length = 0;
        this._orbitDirections.length = 0;
        this._orbitRadii.length = 0;
        this._orbitSpeeds.length = 0;
    }

    /**
     * Called every frame.
     * Maintain sub-bubble positions over time.
     * @param delta - The time elapsed since the last update.
     */
    public update(delta: number) {
        // Update the positions of the sub-bubbles based on their orbit information.
        // Loop through all the sub-bubbles
        for (let i = 0; i < this._subBubbles.length; i++) {
            // Update the sub-bubble's position based on its orbit angle and radius
            this._subBubbles[i].view.x = Math.cos(this._orbitAngles[i]) * this._orbitRadii[i];
            this._subBubbles[i].view.y = Math.sin(this._orbitAngles[i]) * this._orbitRadii[i];

            // Update the orbit angle based on delta time and orbit speed
            this._orbitAngles[i] += (delta / 60) * this._orbitSpeeds[i] * this._orbitDirections[i];
        }
    }
}

/** A system that handles the background decor in the game. */
export class SpaceDecorSystem {
    /**
     * A unique identifier used by the system runner.
     * The identifier is used by the runner to differentiate between different systems.
     */
    public static SYSTEM_ID = 'spaceDecor';
    /**
     * The instance of the game the system is attached to.
     * This is automatically set by the system runner when the system is added to the game.
     */
    public game!: Game;

    /* The container instance that is the root of all visuals in this class. */
    public view = new Container();
    /** A private property that stores the array of decor objects (BubbleOrbit or Satellite instances)*/
    private _decor: (BubbleOrbit | Satellite)[] = [];
    /** Store the current width game. */
    private _width!: number;
    /** Store the current height game. */
    private _height!: number;

    /** Called when the system is added to the game. */
    public init() {
        // Add the view to the bottom of the render list so it is rendered behind the rest of the game
        this.game.stage.addChildAt(this.view, 0);
    }

    /**
     * Generate a given number of random points within the bounds of the game.
     * @param numPoints - The number of points to generate.
     * @returns An array of points, each represented as an object with x and y properties.
     */
    public generateRandomPoints(numPoints: number) {
        const points = [];

        // Configuration variables for the decor objects
        const padding = designConfig.decorEdgePadding;
        const minDistance = designConfig.decorMinDistance;
        const minWidth = designConfig.content.width * 0.8;

        let tooManyTries = false;
        let count = 1000;

        // Loop until the required number of points have been generated
        while (points.length < numPoints && !tooManyTries) {
            // Generate random x and y coordinates within the screen bounds, excluding the padding
            const x = randomRange(padding, this._width - padding, false);
            const y = randomRange(padding, this._height - padding, false);

            if (count <= 0) tooManyTries = true;
            count--;

            // Check if the point is within the minimum width from the center
            if (Math.abs(x - this._width / 2) < minWidth && Math.abs(y - this._height / 2) < minWidth) {
                continue;
            }

            // Check if the point is too close to any existing points
            let tooClose = false;

            for (const point of points) {
                const dist = distance(point, { x, y });

                if (dist < minDistance) {
                    tooClose = true;
                    break;
                }
            }

            // If the point is not too close to any existing points, add it to the list
            if (!tooClose) {
                points.push({ x, y });
            }
        }

        return points;
    }

    /**
     * Called every frame.
     * The main update loop of the system, which maintains the decor over time.
     * @param delta - The time elapsed since the last update.
     */
    public update(delta: number) {
        // Loop through all the decor elements
        this._decor.forEach((decor) => {
            // Call the update method of each decor element
            // The update method is responsible for updating the position, rotation, and other properties of the decor element
            decor.update(delta);
        });
    }

    /**
     * Resizes the system whenever the window size changes.
     * @param w The new width of the window.
     * @param h The new height of the window.
     */
    public resize(w: number, h: number) {
        // Store the new width and height of the window
        this._width = w;
        this._height = h;

        // Clear any existing decor elements
        this._clear();

        // Check if the window width is greater than the minimum width for the content
        if (w > designConfig.content.width * 2) {
            // Determine the number of decor elements based on whether the device is a mobile device or not
            const decorCount = device.isMobileDevice() ? designConfig.decorCountMobile : designConfig.decorCountDesktop;

            // Generate the new decor elements
            this._createDecor(this.generateRandomPoints(decorCount));
        }
    }

    /**
     * Creates new decor elements at the specified points.
     * @param points An array of points where the new decor elements will be placed.
     */
    private _createDecor(points: PointData[]) {
        // Loop through all the points
        points.forEach((point) => {
            // Determine whether to create a BubbleOrbit or Satellite decor element
            const type = Math.random() < 0.4 ? Satellite : BubbleOrbit;

            // Get a decor element from the pool
            const decor = pool.get(type);

            // Set the position of the decor element to the point
            decor.view.position.copyFrom(point);

            // Add the decor element to the array of decor elements
            this._decor.push(decor);

            this.view.addChild(decor.view);

            // Update the decor's view
            decor.changeView();
        });
    }

    /** Clears the existing decor elements. */
    private _clear() {
        // Loop through all the decor elements
        this._decor.forEach((decor) => {
            // Remove the decor element from the display list
            decor.view.removeFromParent();

            // Return the decor element to the pool
            pool.return(decor);
        });

        // Reset the decor element array
        this._decor.length = 0;
    }
}
