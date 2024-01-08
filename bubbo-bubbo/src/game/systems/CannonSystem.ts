import type { FederatedPointerEvent } from 'pixi.js';
import { Container, Point } from 'pixi.js';
import { Signal } from 'typed-signals';

import { sfx } from '../../audio';
import { throttle } from '../../utils/throttle';
import type { BubbleType } from '../boardConfig';
import { boardConfig } from '../boardConfig';
import type { Bubble } from '../entities/Bubble';
import { BubbleReserve } from '../entities/BubbleReserve';
import { Cannon } from '../entities/Cannon';
import { PhysicsState } from '../entities/PhysicsBody';
import type { Game } from '../Game';
import type { System } from '../SystemRunner';
import { HudSystem } from './HudSystem';
import { LevelSystem } from './LevelSystem';
import { PhysicsSystem } from './PhysicsSystem';

/** A system that handles the cannon interactions in the game. */
export class CannonSystem implements System {
    /**
     * A unique identifier used by the system runner.
     * The identifier is used by the runner to differentiate between different systems.
     */
    public static SYSTEM_ID = 'cannon';
    /**
     * The instance of the game the system is attached to.
     * This is automatically set by the system runner when the system is added to the game.
     */
    public game!: Game;
    /* The container instance that is the root of all visuals in this class. */
    public view = new Container();
    /** The game's main cannon instance. */
    public cannon!: Cannon;
    /** An array of bubble reserves. */
    public bubbleReserves: BubbleReserve[] = [];
    /**  An array of bubble types relative to the bubble reserves. */
    public reserveBubbleTypes: BubbleType[] = [];
    /** The type of the bubble currently in the cannon. */
    public currentBubbleType!: BubbleType;

    /** A set of signals that other systems can access. */
    public signals = {
        /**
         * Emitted when the cannon has been fired
         * @param isFirst - Whether or not it is the first time being fired in the current game cycle
         */
        onCannonFire: new Signal<(isFirst: boolean) => void>(),
    };

    /** The angle at which the cannon is aimed. */
    private _aimAngle = 0;
    /** The current projectile in the air (null if there is none). */
    private _projectile!: Bubble | null;
    /** A point in game space relative to the direction that the cannon is facing */
    private readonly _cannonForward = new Point();
    /** The number of shot projectiles. */
    private _shotProjectiles = 0;

    /** Called when the system is added to the game. */
    public init() {
        // Add the view container to the HudSystem's cannon container
        this.game.systems.get(HudSystem).cannonContainer.addChild(this.view);

        /**
         * Helper function to create a new cannon reserve instance
         * @returns `BubbleReserve` instance
         */
        const createCannon = () => {
            const reserve = new BubbleReserve();

            this.view.addChild(reserve.view);

            return reserve;
        };

        // Add two reserve cannons to the array
        this.bubbleReserves.push(createCannon());
        this.bubbleReserves.push(createCannon());

        // Create the main cannon instance
        this.cannon = new Cannon();
        this.cannon.view.scale.set(0.5);
        this.view.addChild(this.cannon.view);

        // Equalise the bubble type array relative to the reserve array
        this.reserveBubbleTypes.length = this.bubbleReserves.length;

        // Connect to the level system's onGameReady signal
        this.game.systems.get(LevelSystem).signals.onGameReady.connect(() => {
            // Set up user interaction for the cannon
            this.game.hitContainer.on('pointermove', this._calculateAngle.bind(this));
            this.game.hitContainer.on('pointertap', this._fire.bind(this));

            // Update the cannon and reserves' bubble type
            this._loadNextShot();
        });

        // Nullify the projectile once the current one has connected to the grid
        this.game.systems.get(PhysicsSystem).signals.onShotConnect.connect(() => {
            this._projectile = null;
        });

        // Set the cannon position to bellow the pre-defined bounce line
        this.cannon.view.y = -boardConfig.bounceLine + 75;

        // Position each of the bubble reserves relative to the cannon and each other
        this.bubbleReserves.forEach((reserve, index) => {
            reserve.view.x = (this.bubbleReserves[index - 1]?.view?.x ?? -5) - 75;

            reserve.view.y = this.cannon.view.y;
        });
    }

    /** Called prior to the `start` function at the beginning of the game. */
    public awake() {
        this._emptyShots();
    }

    /** Resets the state of the system back to its initial state. */
    public reset() {
        // Reset rotation of cannon and reset projectile shot count
        this.cannon.rotation = 0;
        this._shotProjectiles = 0;
        this._projectile = null;
    }

    /** The x-position of the cannon in game space. */
    public get cannonX(): number {
        return this.cannon.view.x;
    }

    /** The y-position of the cannon in game space. */
    public get cannonY(): number {
        return this.cannon.view.y;
    }

    /**
     * The current projectile that was shot.
     * Will be `null` while there is no active bubble in the game.
     */
    public get projectile(): Bubble | null {
        return this._projectile;
    }

    /** Get the forward position of the cannon based on its rotation. */
    public get forward(): Point {
        return this._cannonForward;
    }

    /** Get the rotational angle of the cannon. */
    public get angle(): number {
        return this._aimAngle;
    }

    /**
     * Create and shoot a projectile from the cannon.
     * @param e - The event data sent from the event listener.
     */
    private _fire(e: FederatedPointerEvent) {
        // If a projectile already exists, return and do not fire another
        if (this._projectile) return;

        // Play audio at reduced speed to simulate a different sound, easy way to get multiple sfx out of one file
        sfx.play('audio/bubble-land-sfx.wav', {
            speed: 0.25,
        });

        // Calculate the angle of the shot based on the position of the user's pointer
        this._calculateAngle(e);

        // Emit the `onCannonFire` signal and pass in `this._shotProjectiles === 0` to indicate if this is the first shot or not
        this.signals.onCannonFire.emit(this._shotProjectiles === 0);

        // Increment the number of shots fired
        this._shotProjectiles++;

        // Create a bubble instance from the LevelSystem
        const bubble = this.game.systems.get(LevelSystem).createBubble();

        // Set the type of the bubble to the current stored bubble type
        bubble.type = this.currentBubbleType;

        this.game.addToGame(bubble.view);

        // Get the forward vector of the cannon
        const { x, y } = this.forward;

        // Set the position of the bubble
        bubble.x = x;
        bubble.y = y;

        // Set the body state of the bubble to KINEMATIC
        bubble.body.state = PhysicsState.KINEMATIC;

        // Set the magnitude of the shot force, this modifies the overall movement speed
        const magnitude = 3;

        // Apply the shot force to the bubble
        bubble.body.applyForce((x - this.cannonX) * magnitude, (y - this.cannonY) * magnitude);

        // Add the bubble body to the PhysicsSystem
        this.game.systems.get(PhysicsSystem).addBody(bubble.body);

        // Set the current projectile to the fired bubble
        this._projectile = bubble;

        // Load the next shot into the cannon
        this._loadNextShot();
    }

    /** Remove bubbles from the cannon and bubble reserves. */
    private _emptyShots() {
        // Set all the bubble reserves to be "empty"
        for (let i = 0; i < this.reserveBubbleTypes.length; i++) {
            this.bubbleReserves[i].type = 'empty';
        }

        // Set the type of the cannon to be empty
        this.currentBubbleType = 'empty';

        this.cannon.type = this.currentBubbleType;
    }

    /**
     * Update the cannon and bubble reserve's bubble type.
     * The cannon will take the first reserves type and the reserves with sequentially take their neighbours one
     */
    private _loadNextShot() {
        // Set the current selected bubble type to the first reserve type or create a new bubble if the array is empty
        this.currentBubbleType = this.reserveBubbleTypes[0] ?? this._newBubble();

        // Get a reference to the `reserveBubbleTypes` array
        const res = this.reserveBubbleTypes;

        // Shift the elements of the `reserveBubbleTypes` array to the left, creating a new bubble type if the array becomes empty
        for (let i = 0; i < res.length; i++) {
            res[i] = res[i + 1] ?? this._newBubble();
            this.bubbleReserves[i].type = res[i];
        }

        // Set the type of the cannon to the current selected bubble type
        this.cannon.type = this.currentBubbleType;
    }

    /**
     * Calculate the angle of the shot based on the position of the user's pointer.
     * @param e - The event data sent from the event listener.
     * @param playAudio - A Flag to determine if audio should be played.
     */
    private _calculateAngle(e: FederatedPointerEvent) {
        // Get global cannon position and calculate the angle in radians using the global mouse position
        const globalPos = this.cannon.view.getGlobalPosition();
        const angleRadians = Math.atan2(e.global.y - globalPos.y, e.global.x - globalPos.x);

        // Checks if the cannon has rotated enough to warrant an audio response
        // this prevents audio spam on minor movement
        if (Math.abs(this._aimAngle - angleRadians) > Math.PI * 0.0002) {
            // Attempt to play audio, the throttle will prevent audio spam
            // Can only play audio every N milliseconds
            throttle('cannon-audio', 150, () => {
                sfx.play('audio/cannon-move.wav', {
                    volume: 0.2,
                });
            });
        }

        // Assign cannon rotation based on calculated angle, plus rotational offset
        this._aimAngle = angleRadians;
        this.cannon.rotation = angleRadians + Math.PI * 0.5;

        // Calculate the cannon's forward position using the angle of rotation and arbitrary radius
        this._cannonForward.set(
            80 * Math.cos(this._aimAngle) + this.cannonX,
            80 * Math.sin(this._aimAngle) + this.cannonY,
        );
    }

    /**
     * Generate a new bubble type based on the chances of each type from the LevelSystem's countPerType map.
     * @returns The generated bubble type.
     */
    private _newBubble() {
        const levelSystem = this.game.systems.get(LevelSystem);

        // Create a new instance of a map and copy the level system's countPerType map
        const chancesPerType = new Map(levelSystem.countPerType);

        if (this.currentBubbleType !== undefined) {
            // Making sure the player always have choice between 2 different bubbles
            chancesPerType.set(this.currentBubbleType, 0);
        }

        let totalChance = 0;

        // Determine the change based on the sum of all current bubble type
        chancesPerType.forEach((v) => {
            totalChance += v;
        });

        // Select a type based on the calculated chances
        const selection = levelSystem.getChanceSelection(totalChance, chancesPerType);
        const type = boardConfig.bubbleTypes[selection];

        return type;
    }
}
