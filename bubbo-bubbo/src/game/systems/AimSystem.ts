import gsap from 'gsap';
import { Container, PointData, Point, Sprite } from 'pixi.js';

import { boardConfig } from '../boardConfig';
import { designConfig } from '../designConfig';
import type { Game } from '../Game';
import { pool } from '../Pool';
import type { System } from '../SystemRunner';
import { CannonSystem } from './CannonSystem';
import { HudSystem } from './HudSystem';
import { LevelSystem } from './LevelSystem';

/** A line consists of two sets of points representing its start and end positions */
class Line {
    /** The position of the start of the line */
    public startNode = new Point();
    /** The position of the end of the line */
    public endNode = new Point();
}

/** An identifier to determine if a node belongs to a line or a joint between two lines */
type VisualNodeType = 'joint' | 'line';

/** The visual representation of the node */
class VisualNode {
    /* The container instance that is the root of all visuals in this class. */
    public view: Sprite;
    /** The type of node, either 'joint' or 'line'. */
    public type!: VisualNodeType;

    constructor() {
        // Create the visuals
        this.view = Sprite.from('shot-visualiser');
        this.view.anchor.set(0.5);
        this.view.scale.set(0.25);
    }
}

/** A system that handles the visual aim line in the game. */
export class AimSystem implements System {
    /**
     * A unique identifier used by the system runner.
     * The identifier is used by the runner to differentiate between different systems.
     */
    public static SYSTEM_ID = 'aim';
    /**
     * The instance of the game the system is attached to.
     * This is automatically set by the system runner when the system is added to the game.
     */
    public game!: Game;
    /* The container instance that is the root of all visuals in this class. */
    public view = new Container();
    /* The container instance specifically stored the visual nodes. */
    public nodeContainer = new Container();

    /** An array of lines that make up the aiming trajectory. */
    private readonly _aimLines: Line[] = [];
    /** A lines representing the left wall. */
    private _leftWall!: Line;
    /** A lines representing the right wall. */
    private _rightWall!: Line;
    /** A lines representing the roof. It moves with the level grid. */
    private _roof!: Line;
    /** An array of active visual nodes. */
    private readonly _activeNodes: VisualNode[] = [];

    /** Called when the system is added to the game. */
    public init() {
        // Add the aim system's view as a child of the HudSystem's view
        this.game.systems.get(HudSystem).view.addChild(this.view);

        this.view.addChild(this.nodeContainer);

        // Calculate the wall x and y positions
        const wallX = designConfig.content.width * 0.5 - boardConfig.bubbleSize * 0.5;
        const wallY = designConfig.content.height;

        // Initialize the left wall line
        this._leftWall = new Line();
        this._leftWall.startNode.set(-wallX, 0);
        this._leftWall.endNode.set(-wallX, -wallY);

        // Initialize the right wall line
        this._rightWall = new Line();
        this._rightWall.startNode.set(wallX, 0);
        this._rightWall.endNode.set(wallX, -wallY);

        // Initialize the roof line
        this._roof = new Line();
        this._roof.startNode.set(wallX, 0);
        this._roof.endNode.set(wallX, -wallY);

        // Enable the aim line visuals
        this.enabled(false);

        // Connect to the level system's onGameReady signal
        this.game.systems.get(LevelSystem).signals.onGameReady.connect(() => {
            // Set up user interaction for the aim line
            // Update the line when the user moves the mouse or taps the screen
            this.game.hitContainer.on('pointermove', this.updateAim.bind(this));
            this.game.hitContainer.on('pointertap', this.updateAim.bind(this));
            // Disable the visuals when the pointer exists the game view
            this.game.hitContainer.on('pointerout', this.enabled.bind(this, false));
            // Enable the visuals when the pointer enters the game view
            this.game.hitContainer.on('pointerover', this.enabled.bind(this, true));

            // Enable the aim line visuals
            this.enabled(true);
        });
    }

    /** Resets the state of the system back to its initial state. */
    public reset() {
        // Clear all nodes and visuals
        this._clear();
    }

    /** Update the roof line. */
    public updateRoof() {
        // Update based on the lowest grid line's y position
        const wallX = designConfig.content.width * 0.5;
        const wallY = this.game.systems.get(LevelSystem).getLine('bottom').y;

        this._roof.startNode.set(-wallX, wallY + boardConfig.bubbleSize);
        this._roof.endNode.set(wallX, wallY + boardConfig.bubbleSize);
    }

    /** Used to destroy and recreate the aim line */
    public updateAim() {
        // Clear all nodes and visuals
        this._clear();

        const cannon = this.game.systems.get(CannonSystem);

        // Calculate the edge nodes with the cannon being the origin point,
        // and the initial angle being the cannon's rotational angle
        this._calculateEdgeNodes(cannon.cannonX, cannon.cannonY, cannon.angle);
    }

    /**
     * Show or hide the aim line.
     * @param enable - The enable state.
     */
    public enabled(enable: boolean) {
        // Kill tweens of node container
        gsap.killTweensOf(this.nodeContainer);
        // Tween the alpha in or out based on parameter
        gsap.to(this.nodeContainer, {
            alpha: enable ? 1 : 0,
            duration: 0.2,
        });
    }

    /**
     * Calculate the points on screen where the lines rebound off the walls
     * @param originX - The `x` position of the beginning of the line
     * @param originY - The `y` position of the beginning of the line
     * @param angle - The angle of the line
     * @param alreadyIntersected - Whether or not the line has already intersected the outer wall (should only be used by the function itself)
     */
    private _calculateEdgeNodes(originX: number, originY: number, angle: number, alreadyIntersected?: Line) {
        // Get a line instance from the object pool and add it to the `_aimLines` array
        const line = pool.get(Line);

        this._aimLines.push(line);

        // Set the starting point of the line
        line.startNode.set(originX, originY);

        // Calculate and set the end point of the line
        const radius = boardConfig.maxAimLinesLength;
        const endX = originX + radius * Math.cos(angle);
        const endY = originY + radius * Math.sin(angle);

        line.endNode.set(endX, endY);

        // Check if the line intersects with the roof
        const roofIntersection = this._intersection(line, this._roof);

        if (roofIntersection) {
            // If it does, set the end point of the line to the intersection point
            line.endNode.set(roofIntersection.x, roofIntersection.y);
            this._visualiseNodes();

            return;
        }

        // Check if the line intersects with the left wall
        const leftIntersectPoint = this._intersection(line, this._leftWall);

        let intersected: Line | null = null;

        if (leftIntersectPoint && (!alreadyIntersected || alreadyIntersected !== this._leftWall)) {
            // If it does, set the end point of the line to the intersection point
            line.endNode.set(leftIntersectPoint.x, leftIntersectPoint.y);
            intersected = this._leftWall;
        }

        // If the line doesn't intersect with the left wall, check if it intersects with the right wall
        if (!intersected) {
            const rightIntersectPoint = this._intersection(line, this._rightWall);

            if (rightIntersectPoint) {
                // If it does, set the end point of the line to the intersection point
                line.endNode.set(rightIntersectPoint.x, rightIntersectPoint.y);
                intersected = this._rightWall;
            }
        }

        // If the line doesn't intersect with any wall or the number of aim lines is greater than the max allowed,
        // end the function call loop and visualise the nodes
        if (!intersected || this._aimLines.length > boardConfig.maxAimLines) {
            this._visualiseNodes();
        } else {
            // If it does intersect with a wall, calculate the reflected angle and call the function again
            const reflectedAngle = -(angle - 2 * (Math.PI / 2));

            this._calculateEdgeNodes(line.endNode.x, line.endNode.y, reflectedAngle, intersected);
        }
    }

    /**
     * Check for intersection between two lines.
     * @param line1 - A line to test line intersection against.
     * @param line2 - A line to test line intersection against.
     * @returns `null` or the intersection point.
     * @see {@link https://dirask.com/posts/JavaScript-calculate-intersection-point-of-two-lines-for-given-4-points-VjvnAj Original Code}
     */
    private _intersection(line1: Line, line2: Line) {
        // Get the start and end nodes of the first line
        const { startNode, endNode } = line1;
        // Get the start and end nodes of the second line
        const { startNode: startNode2, endNode: endNode2 } = line2;

        const denominator =
            (endNode2.y - startNode2.y) * (endNode.x - startNode.x) -
            (endNode2.x - startNode2.x) * (endNode.y - startNode.y);

        // Check if the lines are parallel (denominator is 0)
        if (denominator === 0) {
            return null;
        }

        const ua =
            ((endNode2.x - startNode2.x) * (startNode.y - startNode2.y) -
                (endNode2.y - startNode2.y) * (startNode.x - startNode2.x)) /
            denominator;
        const ub =
            ((endNode.x - startNode.x) * (startNode.y - startNode2.y) -
                (endNode.y - startNode.y) * (startNode.x - startNode2.x)) /
            denominator;

        // If the intersection point is not on both lines (0 <= ua, ub <= 1)
        if (ua < 0 || ua > 1 || ub < 0 || ub > 1) {
            return null;
        }

        // Calculate the point of intersection
        const x = startNode.x + ua * (endNode.x - startNode.x);
        const y = startNode.y + ua * (endNode.y - startNode.y);

        return { x, y };
    }

    /** Clear the nodes and visuals for the aim line. */
    private _clear() {
        // Loop through all the active nodes in the scene and return them to the object pool
        this._activeNodes.forEach((node) => {
            pool.return(node);
        });

        // Reset the active nodes list
        this._activeNodes.length = 0;
        // Remove all children from the node container
        this.nodeContainer.removeChildren();

        // Loop through all the aim lines and return them to the object pool
        this._aimLines.forEach((line) => {
            pool.return(line);
        });

        // Reset the aim lines list
        this._aimLines.length = 0;
    }

    /** Use the edge nodes to calculate the points between sequential edge nodes and and visual representations of the nodes. */
    private _visualiseNodes() {
        // Helper function to calculate a set of points between two points in space
        const getPointsBetween = (start: Point, end: Point, stepSize: number) => {
            // Calculate the distance between the start and end points
            const distance = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2));

            // Calculate the number of points to generate based on the step size
            const n = Math.ceil(distance / stepSize); // rounding up

            // Initialise an array to hold the new points
            const points: PointData[] = [];

            // Calculate the step values for x and y
            const stepX = (end.x - start.x) / n;
            const stepY = (end.y - start.y) / n;

            // Loop through and calculate all the points
            for (let i = 1; i < n; i++) {
                points.push({
                    x: start.x + stepX * i,
                    y: start.y + stepY * i,
                });
            }

            return points;
        };

        // Loop through all the aim lines
        this._aimLines.forEach((line, i) => {
            // Check if this is the last line in the array
            const lastLine = i === this._aimLines.length - 1;

            if (!lastLine) {
                // If this is not the last line, get a new joint node from the object pool
                const endNode = this.getVisualNode('joint');

                // Set the position of the joint node to the end node of the line
                endNode.view.position.copyFrom(line.endNode);

                // Add the joint node to the node container
                this.nodeContainer.addChild(endNode.view);
            }

            // Calculate all the points between the start and end of the line
            const midNodeLocations = getPointsBetween(line.startNode, line.endNode, 50);

            // Loop through all the mid-point locations
            midNodeLocations.forEach((position, j) => {
                // Get a new line node from the object pool
                const midNode = this.getVisualNode('line');

                // Set the position of the line node
                midNode.view.position.copyFrom(position);

                // Add the joint node to the node container
                this.nodeContainer.addChild(midNode.view);

                // If it is the last line, fade the node's alpha based on the index position relative to the last index
                if (lastLine && j > midNodeLocations.length * 0.2) {
                    const diff = 1 - j / midNodeLocations.length;

                    // Decrease the alpha further
                    midNode.view.alpha = diff * 0.75;
                }
            });
        });
    }

    /**
     * Creates a visual representation of the node from a pool.
     * @param type - The type of node, either 'joint' or 'line'.
     * @returns The visual representation of the node.
     */
    private getVisualNode(type: VisualNodeType) {
        const node = pool.get(VisualNode);

        node.type = type;
        node.view.alpha = 1;
        this._activeNodes.push(node);

        return node;
    }
}
