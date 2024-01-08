import { Vector2 } from '../../utils/maths/Vector2';
import { boardConfig } from '../boardConfig';

/** Enum to represent the state of a physics body. */
export enum PhysicsState {
    /** Not affected by forces and stays in the same position unless manually moved */
    STATIC,
    /** Affected by forces and changes its position */
    DYNAMIC,
    /** Affected by forces but with a pre-defined motion */
    KINEMATIC,
}

/**
 * Class to represent the physics body of an object.
 * The physics body used to determine position in game space based on a variation of factors
 * Currently only used by `Bubble.ts`
 */
export class PhysicsBody {
    /** Gravity applied to all physics bodies. */
    public static GRAVITY: number = 9.8 * (1 / 60);
    /** Unique identifier for this physics body. */
    public UID = 0;

    // The most basic data required for physics
    /** Radius of the body, used for collision detection. */
    public readonly radius = boardConfig.bubbleSize / 2;
    /** Mass of the body. */
    public readonly mass = 20;
    /** Current position of the body. */
    public position = new Vector2();
    /** Current velocity of the body, used to apply constant force in a given direction. */
    public velocity = new Vector2();
    /** Damping applied to the velocity of the body. */
    public damping = 0.6;
    /** Number of times the body has bounced. */
    public bounces = 0;
    /** Maximum number of times the body is allowed to bounce. */
    public maxBounces = 1;

    /** Current force applied to the body. This data is stored for easy data assignment on added force. */
    private readonly _force = new Vector2();
    /** Current physics state of the body. */
    private _state: PhysicsState = PhysicsState.STATIC;

    /**
     * Applies a force to the body.
     * @param forceX X component of the force.
     * @param forceY Y component of the force.
     */
    public applyForce(forceX: number, forceY: number) {
        // Only apply force if not a static object
        if (this.state !== PhysicsState.STATIC) {
            // Set force to force object, prevents need for creating new vector each time
            this._force.set(forceX, forceY);
            // Add force divided by mass to velocity
            this.velocity.add(this._force.divideScalar(this.mass));
        }
    }

    /** Sets the velocity of the body to zero. */
    public zeroVelocity() {
        // Reset force and velocity
        this._force.setScalar(0);
        this.velocity.setScalar(0);
    }

    /** Resets the physics body to its initial state. */
    public reset() {
        // Reset main physics information
        this._force.set(0, 0);
        this.position.set(0, 0);
        this.velocity.set(0, 0);
        this.state = PhysicsState.STATIC;
        this.bounces = 0;
    }

    /**
     * Getter for the state of the body.
     * @returns The physics state
     */
    public get state() {
        return this._state;
    }

    /**
     * Setter for the state of the body.
     * @param value The new state to set.
     */
    public set state(value: number) {
        // If the body is set to static, nullify constant forces
        if (value === PhysicsState.STATIC) {
            this.zeroVelocity();
        }
        this._state = value;
    }

    /**
     * Gets the x position of the bubble.
     * @returns - The x position of the bubble.
     */
    public get x(): number {
        return this.position.x;
    }

    /**
     * Sets the x position of the bubble.
     * @param value - The new x position of the bubble.
     */
    public set x(value: number) {
        this.position.x = value;
    }

    /**
     * Gets the y position of the bubble.
     * @returns - The y position of the bubble.
     */
    public get y(): number {
        return this.position.y;
    }

    /**
     * Sets the y position of the bubble.
     * @param value - The new y position of the bubble.
     */
    public set y(value: number) {
        this.position.y = value;
    }
}
