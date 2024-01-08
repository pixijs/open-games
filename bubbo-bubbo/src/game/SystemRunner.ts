import type { Game } from './Game';

/** Define the structure of a system which can be added to a game. */
export interface System<S extends Game = Game> {
    /** Reference to the scene the system is added to, which is automatically injected. */
    game?: S;
    /** Method called when the system is initialized. Called only once when the system is instantiated. */
    init?: () => void;
    /** Method called when the system is awakened. Called every time the game is started. */
    awake?: () => void;
    /** Method called when the system's game logic starts. Called every time the game is started. */
    start?: () => void;
    /** Method called every time the game updates, with the delta time passed as argument. Called multiple times during gameplay. */
    update?: (delta: number) => void;
    /** Method called when the system's game logic needs to end. Called every time the game has ended. */
    end?: () => void;
    /** Method called to reset the system. Called every time the game has ended. */
    reset?: () => void;
    /** Method called when the system is resized, with the new width and height passed as arguments. Called every time the screen has resized. */
    resize?: (w: number, h: number) => void;
}

/** Define a class that describes a system. */
interface SystemClass<GAME extends Game = Game, SYSTEM extends System<GAME> = System<GAME>> {
    /** A unique identifier for the system. */
    SYSTEM_ID: string;
    /** A constructor to create an instance of the system. */
    new (): SYSTEM;
}

/** A class that manages the systems and calls the appropriate methods on them */
export class SystemRunner {
    /** The instance of the game the system is attached to. */
    private readonly _game: Game;

    /** A map containing all the systems added to the game */
    public readonly allSystems: Map<string, System> = new Map();
    /** Store the current width game. */
    private readonly _width?: number;
    /** Store the current height game. */
    private readonly _height?: number;

    /**
     * Create a new instance of SystemRunner
     * @param game - the game to associate the SystemRunner with.
     */
    constructor(game: Game) {
        this._game = game;
    }

    /**
     * Add a system to the SystemRunner.
     * @param Class - a class that describes the system to be added.
     * @returns the instance of the system added to the SystemRunner.
     */
    public add<S extends System>(Class: SystemClass<Game, S>): S {
        const name = Class.SYSTEM_ID;

        // Check if the system has a name and throw an error if it doesn't
        if (!name) throw new Error('[SystemManager]: cannot add System without name');

        // If the system has already been added, return the existing instance
        if (this.allSystems.has(name)) {
            return this.allSystems.get(name) as S;
        }

        // Create a new instance of the system
        const system = new Class();

        // Set the game property of the system to the SystemRunner's game
        system.game = this._game;

        // If the width and height of the SystemRunner are already set, call resize on the system
        if (this._width && this._height) system.resize?.(this._width, this._height);

        // Add the system to the SystemRunner's allSystems map
        this.allSystems.set(Class.SYSTEM_ID, system);

        // Return the new instance of the system
        return system;
    }

    /**
     * Get an instance of a system from the SystemRunner.
     * @param Class - a class that describes the system to get.
     * @returns the instance of the system requested.
     */
    public get<S extends System>(Class: SystemClass<Game, S>): S {
        return this.allSystems.get(Class.SYSTEM_ID) as S;
    }

    /**
     * Calls the `init` method of all registered systems
     */
    public init() {
        this.allSystems.forEach((system) => system.init?.());
    }

    /**
     * Calls the `awake` method of all registered systems
     */
    public awake() {
        this.allSystems.forEach((system) => system.awake?.());
    }

    /**
     * Calls the `start` method of all registered systems
     */
    public start() {
        this.allSystems.forEach((system) => system.start?.());
    }

    /**
     * Calls the `update` method of all registered systems
     * @param delta - The time elapsed since the last update.
     */
    public update(delta: number) {
        this.allSystems.forEach((system) => system.update?.(delta));
    }

    /**
     * Calls the `end` method of all registered systems
     */
    public end() {
        this.allSystems.forEach((system) => system.end?.());
    }

    /**
     * Calls the `reset` method of all registered systems
     */
    public reset() {
        this.allSystems.forEach((system) => system.reset?.());
    }

    /**
     * Calls the `resize` method of all registered systems
     * @param {number} w - The width of the game
     * @param {number} h - The height of the game
     */
    public resize(w: number, h: number) {
        this.allSystems.forEach((system) => system.resize?.(w, h));
    }
}
