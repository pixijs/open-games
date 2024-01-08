import { Signal } from 'typed-signals';

import { boardConfig } from '../boardConfig';
import { designConfig } from '../designConfig';
import type { Bubble } from '../entities/Bubble';
import { PhysicsBody, PhysicsState } from '../entities/PhysicsBody';
import type { Game } from '../Game';
import type { System } from '../SystemRunner';
import { CannonSystem } from './CannonSystem';
import { HudSystem } from './HudSystem';
import { LevelSystem } from './LevelSystem';

/** A system that handles the physics simulation of the game. */
export class PhysicsSystem implements System {
    /**
     * A unique identifier used by the system runner.
     * The identifier is used by the runner to differentiate between different systems.
     */
    public static SYSTEM_ID = 'physics';
    /**
     * The instance of the game the system is attached to.
     * This is automatically set by the system runner when the system is added to the game.
     */
    public game!: Game;

    /** A set of signals that other systems can access. */
    public signals = {
        /** Emitted when the shot connects to other bubbles. */
        onShotConnect: new Signal<() => void>(),
        /** Emitted when a bubble bounces on the bottom line. */
        onBubbleBounce: new Signal<(bubble: Bubble) => void>(),
        /** Emitted when a bubble crosses the bottom line after bouncing. */
        onBubbleCrossLine: new Signal<(bubble: Bubble) => void>(),
    };

    /** The map containing all PhysicsBodies in the game, mapped by their unique IDs*/
    private readonly _bodyMap = new Map<number, PhysicsBody>();

    /**
     * Called every frame.
     * The update method updates the position of all bodies based on their state
     * and checks for out of bounds or shot connect conditions.
     */
    public update() {
        // update position of all bodies based on their state
        this._bodyMap.forEach((body) => {
            if (body.state === PhysicsState.DYNAMIC) {
                // apply gravity
                body.applyForce(0, PhysicsBody.GRAVITY * body.mass);
            }
            // update position based on velocity
            body.position.add(body.velocity);

            this._checkOutOfBounds(body);
            this._checkShotConnect();
        });
    }

    /**
     * Adds a `PhysicsBody` to the bodyMap.
     * @param body - The PhysicsBody to add.
     */
    public addBody(body: PhysicsBody) {
        // Check if the body has already been added
        if (this._bodyMap.get(body.UID)) return;
        this._bodyMap.set(body.UID, body);
    }

    /**
     * Removes a `PhysicsBody` from the bodyMap.
     * @param body - The PhysicsBody to remove.
     */
    public removeBody(body: PhysicsBody) {
        // Delete the body from the body map
        this._bodyMap.delete(body.UID);
    }

    /**
     * Check if a physics body is out of the pre-defined game bounds.
     * @param body - The `PhysicsBody` being checked.
     */
    private _checkOutOfBounds(body: PhysicsBody) {
        // Get references to various systems needed in this method
        const cannon = this.game.systems.get(CannonSystem);
        const level = this.game.systems.get(LevelSystem);
        const hud = this.game.systems.get(HudSystem);
        const bubble = level.getBubbleFromBody(body)!;

        // If the body is in a static state, check if it has crossed the bounce line
        // Used to determine if the game is over
        if (body.state === PhysicsState.STATIC) {
            if (body.y + body.radius > -boardConfig.bounceLine) {
                // Emit an event if the bubble has crossed the line
                this.signals.onBubbleCrossLine.emit(bubble);
            }

            // No further actions needed for a static body
            return;
        }

        // Check if the body has gone out of bounds on the left side
        if (body.x - body.radius < -designConfig.content.width / 2) {
            // Move the body back into bounds
            body.x += body.velocity.x;
            // Reverse the x velocity
            body.velocity.x = Math.abs(body.velocity.x);
        }
        // Check if the body has gone out of bounds on the right side
        else if (body.x + body.radius > designConfig.content.width / 2) {
            // Move the body back into bounds
            body.x -= body.velocity.x;
            // Reverse the x velocity
            body.velocity.x = -Math.abs(body.velocity.x);
        }

        // Check if the body is the current projectile
        const isProjectile = body === cannon.projectile?.body;

        // Destroy bubble if it reaches the ceiling (this should be impossible)
        if (isProjectile) {
            // If the projectile goes above the ceiling, destroy it
            if (body.y < -designConfig.content.height - boardConfig.bubbleSize * 2) {
                if (cannon.projectile) {
                    // Kill the bubble if it exists
                    bubble && level.killBubble(bubble);
                }
            }

            // No further actions needed for the projectile
            return;
        }

        // Check if the body has hit the bottom and still has bounces left
        if (body.bounces < body.maxBounces && body.y > -boardConfig.bounceLine) {
            if (bubble) {
                // Bounce the bubble
                bubble.bounce();
                // Update the hud with a line impact
                hud.lineImpact();
                // Emit a bubble bounce event
                this.signals.onBubbleBounce.emit(bubble);
            }
        }
        // Check if the body has no more bounces and has gone below the bottom line
        else if (body.bounces >= body.maxBounces && body.y + body.radius > boardConfig.bubbleSize) {
            // Kill the bubble
            bubble && level.killBubble(bubble);
        }
    }

    /** Checks if the projectile bubble has connected with other bubbles in the grid. */
    private _checkShotConnect() {
        // Get references to various systems needed in this method
        const level = this.game.systems.get(LevelSystem);
        const { projectile } = this.game.systems.get(CannonSystem);

        // Return if there's no shot bubble
        if (!projectile) return;

        // Get the body component of the shot bubble
        const shotBubbleBody = projectile.body;

        // Iterate over each physics body in the _bodyMap
        this._bodyMap.forEach((body) => {
            // Return if the body is the shot bubble's body or if it's not a static body
            if (body === projectile.body || body.state !== PhysicsState.STATIC) return;

            // Calculate the horizontal distance between the shot bubble and the current body
            const xDistance = shotBubbleBody.x - body.x;

            // Calculate the vertical distance between the shot bubble and the current body
            const yDistance = shotBubbleBody.y - body.y;

            // Calculate the Euclidean distance between the two bubbles
            const distance = Math.sqrt(xDistance * xDistance + yDistance * yDistance);

            // Calculate the sum of the radii of the two bubbles
            const combinedRadius = shotBubbleBody.radius + body.radius;

            // Check if the distance between the two bubbles is less than 90% of the combined radius
            if (distance < combinedRadius * 0.9) {
                // Emit a signal indicating that the shot bubble has connected with a stationary bubble
                this.signals.onShotConnect.emit();

                // Get the Bubble instance from the current body
                const connectedBubble = level.getBubbleFromBody(body);

                // If the connected bubble exists, handle the connection
                if (connectedBubble) {
                    level.handleConnect(projectile, { i: connectedBubble.i, j: connectedBubble.j });
                }
            }
        });
    }

    /** Resets the state of the system back to its initial state. */
    public reset() {
        // Clear the _bodyMap.
        this._bodyMap.clear();
    }
}
