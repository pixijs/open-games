import gsap from 'gsap';
import { Container } from 'pixi.js';
import { Signal } from 'typed-signals';

import { sfx } from '../../audio';
import { normalize, scale, sub } from '../../utils/maths/point';
import { randomRange } from '../../utils/maths/rand';
import { boardConfig, BubbleType, isSpecialType, randomType, SpecialBubbleType } from '../boardConfig';
import { designConfig } from '../designConfig';
import { Bubble, SpoofBubble } from '../entities/Bubble';
import { BubbleLine, MAX_BUBBLE_INDEX } from '../entities/BubbleLine';
import type { PhysicsBody } from '../entities/PhysicsBody';
import type { Game } from '../Game';
import { pool } from '../Pool';
import type { System } from '../SystemRunner';
import { AimSystem } from './AimSystem';
import { EffectsSystem } from './EffectsSystem';
import { PauseSystem, Tween } from './PauseSystem';
import { PhysicsSystem } from './PhysicsSystem';
import { PowerSystem } from './PowerSystem';

export class LevelSystem implements System {
    /**
     * A unique identifier used by the system runner.
     * The identifier is used by the runner to differentiate between different systems.
     */
    public static SYSTEM_ID = 'level';
    /**
     * The instance of the game the system is attached to.
     * This is automatically set by the system runner when the system is added to the game.
     */
    public game!: Game;

    /** A map containing how many times each bubble colour has been used. */
    public countPerType = new Map<BubbleType, number>();
    /** An array containing all the lines in the grid. */
    public readonly lines: BubbleLine[] = [];

    /** A set of signals that other systems can access. */
    public signals = {
        /** Emitted when the initial bubble animation has been completed. */
        onGameReady: new Signal<() => void>(),
    };

    // Coefficient determining the likelihood of generating a bubble of a different type than its directly neighouring bubbles.
    // Low heterogeneity implies an homogenous board will be generated.
    // High heterogeneity implies an heterogeneous board will be generated.
    // The coefficient is used as part of a difficulty mechanism
    // and will increase over time to increase difficulty.
    // Has to be in range ]0,+oo[
    private _heterogeneity = boardConfig.minHeterogeneity;
    /** How many lines the grid starts off with. */
    private readonly startingLines = boardConfig.startingLines;
    /** A display container that holds all the bubbles in the grid. */
    private _gridContainer = new Container();
    /** A map containing all the bubbles in the grid. */
    private readonly _bubbleMap = new Map<number, Bubble>();
    /** A fake non-visual bubble that is used to help with calculations. */
    private readonly _spoofBubble = new SpoofBubble();
    /** A value to track how many bubbles have been created directly to the grid. */
    private _spawnBubbleCount = 0;
    /** A ratio to help position lines of the grid in the game space. */
    private _animOffsetRatio = 0;
    /** An incrementing value that groups bubble clusters. */
    private _dropGroupIndex = 0;
    /** Determined if a new line can be added, sets to false on game start and over. */
    private _allowNewLine = false;
    /** A stored tween for when a new line is added to the grid. */
    private _newLineTween!: Tween;
    /** A stored value that helps speed up the game over time. */
    private _newLineSpeedDecrement = 0;
    /** A value that notes how many new lines have been created from the level generation. */
    private _newLineCount = 0;

    /** Called when the system is added to the game. */
    public init() {
        // Add grid container to game
        this.game.addToGame(this._gridContainer);

        // Connect to physics system signal to determine if the grid has passed the threshold for gameover
        this.game.systems.get(PhysicsSystem).signals.onBubbleCrossLine.connect(() => {
            // If it passed the threshold, prevent any new lines from being created
            this._allowNewLine = false;

            // Tell the game that it is gameover
            if (!this.game.isGameOver) this.game.gameOver();
        });

        // Connect to the power system to be able to pause the new line creation
        this.game.systems
            .get(PowerSystem)
            .signals.onPowerUsed.connect((power: SpecialBubbleType, hasEnded: boolean) => {
                if (power === 'timer') {
                    // If the power is a timer, pause or resume the level generation animation
                    // based on if the power has started or ended respectively
                    if (!hasEnded) this._newLineTween.pause();
                    else this._newLineTween.resume();
                }
            });
    }

    /** Called at the start of the game. */
    public start() {
        // Create the entire initial grid
        this.createLevel();
        // Update the aim system's roof
        this.game.systems.get(AimSystem).updateRoof();
        // Show the grid container
        this._gridContainer.alpha = 1;

        // Animate the grid onto screen, add the tween to the pause system
        this.game.systems.get(PauseSystem).addTween(
            gsap.to(this._gridContainer, {
                y: 0,
                duration: 2,
                ease: 'back.out(1)',
                delay: 1,
                onComplete: () => {
                    // Emit the game ready signal on animation complete
                    this.signals.onGameReady.emit();
                },
            }),
        );
    }

    /** Resets the state of the system back to its initial state. */
    public reset() {
        this._newLineSpeedDecrement = 0;
        this._dropGroupIndex = 0;
        this._newLineCount = 0;

        // Prevent a new line before the game is ready
        this._allowNewLine = false;

        // Clear grid data
        this.clearLevel();
    }

    /**
     * Get all bubbles left in the grid
     * @returns An array containing all bubbles still in the grid.
     */
    public getAttachedBubbles() {
        const bubbles: Bubble[] = [];

        // Filter lines so it only returns instances of `Bubble`
        this.lines.forEach((line) => {
            bubbles.push(...(line.bubbles.filter((bubble) => bubble !== undefined) as Bubble[]));
        });

        return bubbles;
    }

    /**
     * Called every frame.
     * The update method updates the position of all bubbles based
     */
    public update() {
        this._bubbleMap.forEach((bubble) => {
            // Update bubble
            bubble.update();
        });
    }

    /** Clear all data related to the grid */
    public clearLevel() {
        // Loop through all the bubbles and kill them
        this._bubbleMap.forEach((bubble) => {
            this.killBubble(bubble);
        });

        // Clear the bubble map
        this._bubbleMap.clear();

        // Clear the bubble type count map
        this.countPerType.clear();

        // Add all the starting bubble types back into the count map
        for (let i = 0; i < boardConfig.startingBubbleTypes.length; i++) {
            this.countPerType.set(boardConfig.startingBubbleTypes[i], 0);
        }

        // Empty the lines array
        this.lines.length = 0;
        // Reset the spawned bubble count
        this._spawnBubbleCount = 0;
    }

    /** Create the initial bubble grid */
    public createLevel() {
        // Populating grid
        const count = this.startingLines;

        // Add multiple new lines
        for (let l = 0; l < count; l++) {
            this.addLine();
        }

        // Hide the grid container and move it above, out of view
        this._gridContainer.alpha = 0;
        this._gridContainer.y = -count * boardConfig.bubbleSize;

        // Loop through the new lines and reset their position ratio
        this.lines.forEach((line) => {
            line.updatePosRatio(1);
        });
    }

    /**
     * Retrieve the bubble at the specified grid location.
     * @param gridI The grid column index.
     * @param gridJ The grid row index.
     * @returns The Bubble instance at the specified grid location or undefined if no bubble exists.
     */
    public getBubbleAt(gridI: number, gridJ: number) {
        // Retrieve the Line instance at the specified grid row
        const line = this.lines[gridJ];

        // Retrieve the Bubble instance at the specified grid column from the Line instance
        const bubble = line?.getBubbleAt(gridI);

        // Return the Bubble instance
        return bubble;
    }

    /**
     * Calculate the `x` position of a bubble in screen space.
     * @param bubble - The bubble to calculate the position with.
     * @returns The calculated X position.
     */
    public calculateBubbleX(bubble: Bubble) {
        return -designConfig.content.width / 2 + bubble.defaultX;
    }

    /**
     * Calculate the `y` position of a bubble in screen space.
     * @param bubble - The bubble to calculate the position with.
     * @returns The calculated `y` position.
     */
    public calculateBubbleY(bubble: Bubble) {
        return boardConfig.screenTop + boardConfig.bubbleSize * bubble.j;
    }

    /** Adds a new line of bubbles to the top of the grid. */
    public addLineToGridTop() {
        // The number of new lines is incremented by 1
        this._newLineCount++;

        const { urgentMinLines, animInTime, urgentAnimInTime, maxDecrement, decrementIn, animInDecrement } =
            boardConfig.newLine;

        // Determine urgency based on the amount of lines in the grid
        const isUrgent = this.lines.length < urgentMinLines;
        // The duration of the animation for adding a new line is calculated based on the current number of lines in the grid
        // and some configuration parameters from boardConfig
        const duration = isUrgent ? urgentAnimInTime : animInTime - this._newLineSpeedDecrement;

        // Add the new line
        this.addLine(true, duration, () => {
            this._heterogeneity += boardConfig.heterogeneityIncrement;
            // If the _allowNewLine property is set to true, another line is added to the top of the grid by calling the addLineToGridTop method recursively.
            if (this._allowNewLine) this.addLineToGridTop();
        });

        /*
        If the number of new lines is a multiple of the decrementIn configuration parameter,
        the duration of adding new lines is decremented by the animInDecrement configuration parameter.
        This decrement is capped by the maxDecrement configuration parameter
        */
        if (this._newLineCount % decrementIn === 0) {
            this._newLineSpeedDecrement = Math.min(this._newLineSpeedDecrement + animInDecrement, maxDecrement);
        }
    }

    /**
     * Create a new BubbleLine and add it to the list of lines.
     * @param setOnTop - A flag that determines whether the new line should be set on top of the grid, defaults to `true`.
     * @param duration - A number that represents the animation duration, defaults to `0`.
     * @param onComplete - A callback function that is executed once the animation is complete.
     * @returns The newly created line.
     */
    public addLine(setOnTop = true, duration = 0, onComplete?: () => void) {
        let line: BubbleLine;

        // Check if setOnTop is true and if it is, it initializes a new line and sets it on the top of the grid
        if (setOnTop) {
            const j = 0;

            // Loop through existing lines and increase the `j` value of every line in the grid by `1`
            this.lines.forEach((l) => {
                l.j++;
                l.bubbles.forEach((b) => {
                    if (!b) return;
                    b.j = l.j;
                });
            });

            // Determining if the line is even or odd by checking the previous lines in the grid
            const even = this.lines.length > 0 ? !this.lines[0].isEven : true;

            // Get a BubbleLine from the pool and initialise it with the j value, game object, and even/odd status
            line = pool.get(BubbleLine);
            line.init(j, this.game, even);

            // Add the new line to the top of the lines array
            this.lines.unshift(line);

            // Determine the starting index by whether or not it is an even line
            const startingI = even ? 0 : 1;

            // Spawning bubbles in the line by
            for (let i = startingI; i <= MAX_BUBBLE_INDEX; i += 2) {
                // Increase bubble spawn count
                this._spawnBubbleCount++;

                // Select a bubble type
                const bubbleType = this._selectBubbleType(i, j);

                // Create a new Bubble object and adding it to the grid container
                const bubble = this._createGridBubble(bubbleType, i, j);

                // Add the newly created bubble to the BubbleLine object
                line.addBubble(bubble, this.calculateBubbleX(bubble));
                this._gridContainer.addChild(bubble.view);
            }
            // Set the `y` value of the new line
            line.y = boardConfig.screenTop - boardConfig.bubbleSize;
            // Animate the grid down by one line, speed is determined outside of this function
            this.pushLevelDown(duration, onComplete);
        } else {
            // Get the bottom most line
            const bottomLine = this.getLine('bottom');

            // Determining if the line is even or odd by checking the last line in the grid
            const even = this.lines.length > 0 ? !bottomLine.isEven : true;

            // Get the index of the new line
            const newJ = bottomLine.j + 1;

            // Get a BubbleLine from the pool and initialise it with the j value, game object, and even/odd status
            line = pool.get(BubbleLine);
            line.init(newJ, this.game, even);

            line.y = boardConfig.screenTop + boardConfig.bubbleSize * line.j;

            // Set the `y` value of the new line
            this.lines.push(line);
        }

        return line;
    }

    /**
     * Retrieve a line based on the given row index.
     * @param j - The grid row index, 'top' or 'bottom'.
     * @returns - The line on the provided row index.
     */
    public getLine(j: number | 'top' | 'bottom') {
        // Return the first element of the array
        if (j === 'top') return this.lines[0];
        // Return the last element of the array
        else if (j === 'bottom') return this.lines[this.lines.length - 1];

        // Return a specific element based on the index
        return this.lines[j];
    }

    /**
     * Push the grid level down by one line.
     * @param duration - Duration of the animation.
     * @param onComplete - Callback for when the animation ends.
     */
    public pushLevelDown(duration: number, onComplete?: () => void) {
        // Get a reference to the pause system
        const pause = this.game.systems.get(PauseSystem);

        // Reset the animation ratio, to be animated to 1
        this._animOffsetRatio = 0;

        // Animate the ratio to 1
        // Add the tween the pause system
        this._newLineTween = pause.addTween(
            gsap.to(this, {
                _animOffsetRatio: 1,
                ease: 'none',
                duration,
                onUpdate: () => {
                    // Update the lines with the new ratio
                    this.lines.forEach((line) => {
                        line.updatePosRatio(this._animOffsetRatio);
                    });
                },
                onComplete,
            }),
        );
    }

    /**
     * Create a new bubble from the pool and add it to the bubble map.
     * @returns - The newly created bubble.
     */
    public createBubble() {
        // Get Bubble from pool
        const bubble = pool.get(Bubble);

        // Reset the bubble
        bubble.reset();

        // Add the bubble to the bubble map using it's unique ID
        this._bubbleMap.set(bubble.UID, bubble);

        // Return the new bubble
        return bubble;
    }

    /**
     * Selects a random type of bubble from a list of available bubble types based on the provided chance distribution of each type.
     * @param totalChance - Total sum of the chances assigned to each bubble type.
     * @param chancePerType - A map representing the chance distribution of each type of bubble.
     * @returns The index of the selected bubble type in the list of available bubble types.
     */
    public getChanceSelection(totalChance: number, chancePerType: Map<BubbleType, number>) {
        let selection = 0;

        // Set the amount of total chance remaining after subtracting the chance of previous selected bubble types in a random selection process
        let remainingChance = Math.random() * totalChance - chancePerType.get(boardConfig.bubbleTypes[0])!;

        while (selection < boardConfig.bubbleTypes.length && remainingChance > 0) {
            // Increment selection
            selection += 1;

            // Get next bubble type
            const type = boardConfig.bubbleTypes[selection];

            // If chance per type exists for the selected bubble type
            if (chancePerType.has(type)) {
                // subtract the chance per type of the selected bubble type from remaining chance
                remainingChance -= chancePerType.get(type)!;
            }
        }

        // check if the final value of selection is less than the length of bubble types
        if (selection >= boardConfig.bubbleTypes.length) {
            // Due to rounding errors it might possible to end up in this situation
            // if that's the case, set selection to the last bubble type
            selection = boardConfig.bubbleTypes.length - 1;
        }

        // return the selected type
        return selection;
    }

    /**
     * Set a bubble into the grid in a specific location, gridI and gridJ.
     * @param bubble - The bubble being set.
     * @param gridI - The grid column index.
     * @param gridJ - The grid row index.
     */
    public setBubble(bubble: Bubble, gridI: number, gridJ: number) {
        // Play audio
        sfx.play('audio/bubble-land-sfx.wav', {
            speed: randomRange(0.8, 1.1, false),
        });

        // Remove the bubble from its parent
        bubble.view.removeFromParent();
        // Add the bubble's view to the grid container
        this._gridContainer.addChild(bubble.view);

        // If the gridJ is one more than the bottom line, then a new line is added
        // Otherwise, the bubble is placed on the existing line gridJ.
        const line: BubbleLine = gridJ === this.getLine('bottom').j + 1 ? this.addLine(false) : this.lines[gridJ];

        // Connecting the bubble to the grid location (gridI and line.j).
        bubble.connect(gridI, line.j);

        // Check if the line is even or odd and that it matches the expected parity based on the gridI.
        const gridExpectedEven = gridI % 2 === 0;

        if (gridExpectedEven !== line.isEven) {
            console.error(`Trying to set even = ${gridExpectedEven} where line is even = ${line.isEven}`);
        }

        // Add bubble to the line, set its x position
        line.addBubble(bubble, this.calculateBubbleX(bubble));

        // Find the cluster of bubbles that the newly placed bubble is a part of.
        // Match the type (including special bubbles)
        const cluster = this._getClusterAt(gridI, gridJ === -1 ? 0 : gridJ, true);

        // Filter out the special types to be used later
        const specials = cluster.filter((b) => isSpecialType(b.type));
        // Determine if the cluster includes a special type
        const hasSpecial = specials?.length > 0;

        // Start a shimmer animation for the newly placed bubble
        const tween = bubble.bubbleView.shimmer();

        // Determine if the cluster is valid based on size
        const isCluster = cluster.length > 2;

        // Get reference to pause system
        const pause = this.game.systems.get(PauseSystem);

        if (!isCluster) {
            // If the cluster is small enough, set off the bounce animation on the neighbors.
            this.getNeighbours(gridI, line.j).forEach((neighbour) => {
                // Calculate the direction of the bounce based on relative positions
                const direction = scale(
                    normalize(sub(neighbour, bubble.body.position)),
                    // Scale down the animation intensity
                    boardConfig.bubbleSize * 0.1,
                );

                // Start the impact animation and add the tween to the pause system
                pause.addTween(neighbour.impact(direction));
            });
        } else {
            // Increase drop group index only if it is a valid cluster
            this._dropGroupIndex++;
        }

        // Wait for the shimmer effect to end
        tween.then(() => {
            // Remove the entire cluster if it a valid size
            cluster.forEach((b) => {
                // Make sure not to drop the bubble if the new bubble hits a special
                // If need be, it can be removed as a floating bubble later
                if ((hasSpecial && b === bubble) || (!isCluster && !hasSpecial)) return;
                // Remove bubble
                // If it is a special bubble, just destroy it, don't drop it
                this.removeBubble(b, !isSpecialType(b.type));
            });

            // If the cluster has special bubbles, the function uses the corresponding power.
            specials.forEach((s) => this.game.systems.get(PowerSystem).usePower(s.type, s.i, s.j));

            // Removes floating bubbles and retrieves how many floating bubbles there were
            const floatCount = this.removeFloatingBubbles();

            const { x, y } = bubble.view;

            // Calculate the combo count based on cluster size and floating bubbles count
            const comboCount = cluster.length + floatCount;

            // Update the combo stats if necessary.
            if (comboCount > this.game.stats.get('bestCombo')) {
                this.game.stats.set('bestCombo', comboCount);
            }

            // Add a shockwave effect if the cluster is not empty or has special bubbles
            if (isCluster || hasSpecial) {
                this.game.systems.get(EffectsSystem).shockwave(x, y, hasSpecial);
            }
        });

        // Add the shimmer tween to the pause system
        pause.addTween(tween);

        // Start adding new lines once the first bubble has connected
        if (!this._allowNewLine) {
            this._allowNewLine = true;
            this.addLineToGridTop();
        }

        // Prevents new bubbles from floating at next position when time is stopped
        line.updatePosRatio(this._animOffsetRatio);
    }

    /**
     * Remove a bubble from the grid.
     * @param bubble - The bubble to be removed.
     * @param drop - Whether it will be dropped or just destroyed.
     */
    public async removeBubble(bubble: Bubble, drop = true) {
        // Increment how many bubbles have been removed from the grid
        this.game.stats.increment('bubblesPopped');
        // Remove the bubble using the bubble's index
        this.removeBubbleAt(bubble.i, bubble.j, drop);
        // Set the bubble's drop id to be the current drop group ID
        bubble.dropGroupId = this._dropGroupIndex;
    }

    /**
     * Remove a bubble from the grid using specific grid positions.
     * @param gridI - The grid column index.
     * @param gridJ - The grid row index.
     * @param drop - Whether it will be dropped or just destroyed.
     */
    public removeBubbleAt(gridI: number, gridJ: number, drop = true) {
        // Get the line based on the row index
        const line = this.lines[gridJ];
        // Get the bubble based on the column index
        const bubble = line?.getBubbleAt(gridI);

        // If no bubble exists, return with error
        if (!bubble) {
            console.error('Trying to remove a bubble that doesnt exist at ', gridI, gridJ);

            return;
        }

        // Get the parent's bubble
        const parent = bubble.view.parent!;

        // If drop, add bubble to top of grid container
        if (drop) parent.addChild(parent.removeChild(bubble.view));
        // Else immediately destroy it
        else this.killBubble(bubble);

        // Remove bubble from line
        line.removeBubble(bubble, drop);
    }

    /**
     * Remove all bubbles not attached to the grid, either directly or indirectly
     * @returns How many floating bubbles there were
     */
    public removeFloatingBubbles() {
        // Use a Set to store the bubbles that are floating
        const floatingBubbles: Set<Bubble> = new Set();
        // Use a Map to track if a bubble has already been visited or not
        const visited: Map<Bubble, boolean> = new Map();

        this.getAttachedBubbles().forEach((bubble: Bubble) => {
            // No need to visit bubbles that were already visited.
            if (visited.has(bubble)) {
                return;
            }

            // Get the cluster of every attached bubble
            // No need to type match
            const cluster = this._getClusterAt(bubble.i, bubble.j, false);

            cluster.forEach((bubble: Bubble) => {
                // Add every bubble in the cluster to the visited map
                visited.set(bubble, true);
            });

            // Check if there's a bubble connected to the roof.
            if (!cluster.some((b) => b.j === 0)) {
                cluster.forEach((y) => {
                    // If they are not connected, they are considered floating
                    floatingBubbles.add(y);
                });
            }
        });

        // Remove floating bubbles.
        const floating = Array.from(floatingBubbles.values());

        floating.map(async (bubble) => {
            this.removeBubble(bubble);
        });

        // Remove empty lines created from removing bubbles
        this.garbageCollectLines();

        // Return how many floating bubbles there were
        return floating.length;
    }

    public garbageCollectLines() {
        // Garbage collecting the lines
        while (this.lines.length > 0 && this.getLine('bottom').bubbleCount === 0) {
            // While there are empty lines, remove the last line
            pool.return(this.lines.pop());
        }

        // Update the aim system's roof
        this.game.systems.get(AimSystem).updateRoof();
    }

    /**
     * Completely destroy the bubble and remove it from its parent
     * @param bubble - The bubble to kill.
     */
    public killBubble(bubble: Bubble) {
        // Return the bubble to the pool
        pool.return(bubble);
        // Remove bubble from parent
        bubble.view.removeFromParent();
        // Delete bubble from the map
        this._bubbleMap.delete(bubble.UID);
        // Remove the bubble's body from the physics system
        this.game.systems.get(PhysicsSystem).removeBody(bubble.body);
    }

    /**
     * Determine the new grid position of the projectile bubble.
     * @param projectile - A `Bubble` object representing the bubble that is going to be connected.
     * @param gridHit - An object that holds the coordinates of the bubble that the projectile hit.
     * @param prioritiseSide - A string value either "left" or "right" which represents the side that should be prioritized to connect the projectile (should only be used by the function).
     */
    public handleConnect(projectile: Bubble, gridHit: { i: number; j: number }, prioritiseSide?: 'left' | 'right') {
        // Get the line holding the bubble that has been hit
        const hitLine = this.lines[gridHit.j];
        // Get the neighbouring coordinates of that hit bubble
        const neighbours = this._getNeighboursCoord(gridHit.i, hitLine.j);

        // Initialise an array that will hold the distance of the projectile to each neighboring bubble.
        let distances: { i: number; j: number; distance: number }[] = [];

        // Use the projectile's last position as the test position
        const projectileX = projectile.x - projectile.body.velocity.x;
        const projectileY = projectile.y - projectile.body.velocity.y;

        // Get a reference to the fake bubble that will be used to calculate the best possible grid position
        const spoof = this._spoofBubble as Bubble;

        // Assign the spoof bubble the column index of the bubble that was hit
        spoof.i = gridHit.i;

        // Determine which side the project hit
        const side: typeof prioritiseSide = projectileX < this.calculateBubbleX(spoof) ? 'left' : 'right';

        neighbours.forEach((coords) => {
            spoof.i = coords.i;
            spoof.j = coords.j;

            // The function then iterates over the neighbours and calculates the estimated X and Y positions of each neighboring coordinates,
            // along with its distance from the projectile.
            const estimatedPosX = this.calculateBubbleX(spoof);
            const estimatedPosY = this.calculateBubbleY(spoof);

            const relativeSide = projectileX < estimatedPosX ? 'left' : 'right';

            // If prioritiseSide is defined, it filters the neighboring bubbles to only include those on the specified side.
            if (prioritiseSide && prioritiseSide !== relativeSide) return;

            const dist = Math.sqrt(Math.pow(projectileX - estimatedPosX, 2) + Math.pow(projectileY - estimatedPosY, 2));

            distances.push({
                i: coords.i,
                j: coords.j,
                distance: dist,
            });
        });

        // The function sorts the distances array by distance,
        distances.sort((a, b) => a.distance - b.distance);

        // Create a backup just in case there are no valid grid positions
        const backup = distances[0];

        // Choose the closest three neighboring bubbles.
        distances = distances
            .splice(0, 3)
            // Filter this list again to only include valid grid positions (where there is no bubble yet and it is within the grid bounds).
            .filter((value) => this.isValidGrid(value.i, value.j, true) && !this.getBubbleAt(value.i, value.j));

        // If there are no valid positions left, the function calls itself again with the closest neighboring bubble (backup) and the prioritized side.
        if (distances.length === 0 && backup) {
            this.handleConnect(projectile, backup, prioritiseSide ?? side);
        }
        // Otherwise, the function sets the projectile in the nearest valid position.
        else {
            this.setBubble(projectile, distances[0].i, distances[0].j);
        }
    }

    /**
     * Get a Bubble instance based on a physics body.
     * @param body - The `PhysicsBody` being checked.
     * @returns Either a `Bubble` that the body is attached to, or `undefined`.
     */
    public getBubbleFromBody(body: PhysicsBody): Bubble | undefined {
        return this._bubbleMap.get(body.UID);
    }

    /**
     * Return an array of neighboring bubbles in a given hexagonal grid.
     * @param gridI - The grid column index.
     * @param gridJ - The grid row index.
     * @param distance - The distance to consider as neighbors, a value of 1 means the immediate neighbors, defaults to `1`.
     * @returns Array of neighbouring bubbles.
     */
    public getNeighbours(gridI: number, gridJ: number, distance = 1) {
        // Initialise an empty array to store the neighboring bubbles
        const neighbours: Bubble[] = [];

        // Use nested for loops to iterate over all the rows
        // (from j - distance to j + distance) and columns (from i - distance * 2 + diff to i + distance * 2 - diff) in the grid within the distance from the given bubble.
        for (let row = gridJ - distance; row <= gridJ + distance; row++) {
            const realRow = row;

            // Check if row index is within allowed range
            if (realRow < 0 || realRow > this.lines.length - 1) continue;

            const diff = Math.abs(row - gridJ);

            // For each iteration, it checks if the index is within the distance from the given bubble
            for (let col = gridI - distance * 2 + diff; col <= gridI + distance * 2 - diff; col++) {
                // Check if column index is within allowed range
                if (col < 0 || col > this.lines[realRow].bubbles.length - 1) continue;

                // If so, it adds the bubble at that position to the neighbours array, unless it is the given bubble.
                if (col !== gridI || row !== gridJ) {
                    const bubble = this.lines[realRow].bubbles[col];

                    bubble && neighbours.push(bubble);
                }
            }
        }

        // Return list of neighbours
        return neighbours;
    }

    /**
     * Returns the coordinates of the neighbours for a given bubble at the grid coordinates `gridI` and `gridJ`.
     * @param gridI - The grid column index.
     * @param gridJ - The grid row index.
     * @returns An array of objects representing the coordinates of the neighbouring bubbles.
     */
    private _getNeighboursCoord(gridI: number, gridJ: number) {
        const neighbours: { i: number; j: number }[] = [];

        const lineIndex = gridJ;

        // Helper function to fetch closests neighbours
        const get = (i: number, j: number) => {
            neighbours.push({ i, j });
        };

        // Neighbours to the left and right on the same line
        get(gridI - 2, lineIndex);
        get(gridI + 2, lineIndex);

        // Neighbours above on the next line
        const indexAbove = lineIndex + 1;

        get(gridI - 1, indexAbove);
        get(gridI + 1, indexAbove);

        // Neighbours below on the previous line
        const indexBelow = lineIndex - 1;

        get(gridI - 1, indexBelow);
        get(gridI + 1, indexBelow);

        return neighbours;
    }

    /**
     * Get the cluster of bubbles at a specific position.
     * @param gridI - The grid column index.
     * @param gridJ - The grid row index.
     * @param matchType - A flag to indicate if the cluster should only include bubbles with the same type as the initial bubble.
     * @returns An array of bubbles in the cluster.
     */
    private _getClusterAt(gridI: number, gridJ: number, matchType: boolean) {
        // Get the initial bubble at the specified position
        const initialBubble = this.getBubbleAt(gridI, gridJ);

        // Return an empty array if there is no bubble at the position
        if (!initialBubble) {
            return [];
        }

        // Set the type of the bubble that the cluster should match
        const typeToMatch = initialBubble.type;

        // Arrays to store the bubbles in the cluster and the bubbles that have been visited
        const cluster: Bubble[] = [];
        const visited: Bubble[] = [];

        // An array to store the bubbles that need to be visited
        const toVisit: Bubble[] = [initialBubble];

        // A function to check if a bubble is a special type
        const isSpecial = (type: BubbleType) => isSpecialType(type);

        // Continuously visit the next bubble in the toVisit array until it's empty
        while (toVisit.length) {
            // Get the next bubble to visit
            const current = toVisit.pop()!;

            // Continue to the next iteration if the bubble has already been visited
            if (visited.includes(current)) {
                continue;
            }

            // Continue to the next iteration if the bubble is not attached to the grid
            if (!this.isValidGrid(current.i, current.j)) {
                continue;
            }

            // Add the bubble to the visited array
            visited.push(current);

            // Add the current bubble to the cluster if it matches the type or if matchType is false
            const currentSpecial = isSpecial(current.type);

            if (!matchType || current.type === typeToMatch || currentSpecial) {
                cluster.push(current);

                // Don't add neighbours if the current bubble is special and matchType is true
                if (matchType && currentSpecial) continue;

                // Get the neighbours of the current bubble
                const neighbours = this.getNeighbours(current.i, current.j, 1);

                // Add the unvisited neighbours that match the type or if matchType is false
                const toAdd = neighbours.filter(
                    (n) => n && !visited.includes(n) && (!matchType || !isSpecial(n.type) || initialBubble === current),
                )!;

                toVisit.push(...toAdd);
            }
        }

        // Return the array of bubbles in the cluster
        return cluster;
    }

    /**
     * Check if the given grid positions are within range of the min/max row and column count.
     * @param gridI - The grid column index.
     * @param gridJ - The grid row index.
     * @param allowNewLine - If it can accept a grid position that is lower than the existing grid.
     * @returns If the given grid positions are valid.
     */
    public isValidGrid(gridI: number, gridJ: number, allowNewLine?: boolean) {
        // Get the last line in the grid
        const bottomJ = this.getLine('bottom').j;

        // Check if the given gridJ is one lower than the bottom line's index
        const lineOverflowed = gridJ === bottomJ + 1;

        // If overflow but not allowed a new line, return false
        if (lineOverflowed && !allowNewLine) return false;

        // If lineOverflowed, check the last line, else get the expected line
        const line = this.lines[lineOverflowed ? bottomJ : gridJ];

        // Check if the line is even
        const isEven = lineOverflowed ? !line.isEven : line.isEven;

        // Check if the column index is within left bounds, the bounds shifts depending on if it is an odd or even line
        const isLeftInBounds = (isEven && gridI > -1) || (!isEven && gridI > 0);
        // Check if the column index is within right bounds, the bounds shifts depending on if it is an odd or even line
        const isRightInBounds =
            (isEven && gridI < boardConfig.bubblesPerLine * 2 - 1) ||
            (!isEven && gridI < boardConfig.bubblesPerLine * 2 - 2);

        // Returns true if the line exists and it is within both bounds
        return line && isLeftInBounds && isRightInBounds;
    }

    /**
     * Create a bubble to be specifically added directly to the grid.
     * @param bubbleType - The type of bubble
     * @param gridI - The grid column index.
     * @param gridJ - The grid row index.
     * @returns The new bubble entity.
     */
    private _createGridBubble(bubbleType: BubbleType, gridI: number, gridJ: number) {
        // Retrieve the bubble count of type bubbleType from the countPerType map, or sets it to 0 if it doesn't exist in the map.
        const count = this.countPerType.get(bubbleType) ?? 0;

        // Increment the count of the bubbles of type bubbleType by 1
        this.countPerType.set(bubbleType, 1 + count);

        // Gets a bubble entity
        const entity = this.createBubble();

        // Assign the given type
        entity.type = bubbleType;
        // Connect it directly to the grid
        entity.connect(gridI, gridJ);

        // Return the new entity
        return entity;
    }

    /**
     * Determine the type of bubble that should be created in a specific grid position in the game board.
     * @param gridI - The grid column index.
     * @param gridJ - The grid row index.
     * @returns A bubble type
     */
    private _selectBubbleType(gridI: number, gridJ: number) {
        // Check if there is a special bubble type
        const special = this._getSpecialType();

        // If a special bubble type exists, return it
        if (special) return special;

        // Running a roulette wheel selection algorithm
        // https://en.wikipedia.org/wiki/Fitness_proportionate_selection for reference

        // Get the neighbors of the current grid cell
        const neighbours = this.getNeighbours(gridI, gridJ);

        // Initialize the total chance with the length of the bubble types multiplied by the heterogeneity
        let totalChance = boardConfig.bubbleTypes.length * this._heterogeneity;

        // Initialize a map of chance per type with each type having a chance of heterogeneity
        const chancePerType = boardConfig.bubbleTypes.reduce(
            (map, b) => map.set(b, this._heterogeneity),
            new Map<BubbleType, number>(),
        );

        // Loop through all neighbors
        for (let n = 0; n < neighbours.length; n += 1) {
            // Get the current neighbor
            const neighbour = neighbours[n];

            // Get the type of the current neighbor
            const type = neighbour.type;

            // Initialize the amount to 1
            let amount = 1;

            if (!chancePerType.has(type)) {
                // If the type doesn't exist in the chance per type map increase the amount by the heterogeneity
                amount += this._heterogeneity;
            } else {
                // Increase the amount by the current chance in the map
                amount += chancePerType.get(type)!;
            }

            // Set the new chance in the map
            chancePerType.set(type, amount);
            // Increase the total chance
            totalChance += 1;
        }

        // Get the selection from the roulette wheel selection algorithm
        const selection = this.getChanceSelection(totalChance, chancePerType);

        // Return the selected bubble type
        return boardConfig.bubbleTypes[selection];
    }

    /**
     * Return a special bubble type based on a probability defined by
     * the `specialBubbleChance` and `specialBubbleEvery` configuration variables.
     * @returns A special bubble type if one is to be generated, or `null` if none should be generated.
     */
    private _getSpecialType() {
        const bubblesEvery = boardConfig.specialBubbleEvery;
        const bubblesChance = boardConfig.specialBubbleChance;

        const mod = this._spawnBubbleCount % bubblesEvery;

        // Check if the current spawn count is a multiple of the special bubble frequency
        // and if a random number is less than the special bubble chance.
        if (mod === 0 && Math.random() < bubblesChance) {
            // If the conditions are met, return a random special bubble type.
            return randomType('special');
        }

        // Otherwise return null.
        return null;
    }
}
