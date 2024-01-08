class InstancePool<T extends new () => InstanceType<T> = new () => any> {
    /** The constructor for the type of instances this pool will store. */
    public readonly Ctor: T;
    /** The list of instances stored in this pool. */
    public readonly list: InstanceType<T>[] = [];

    /**
     * Creates a new instance of the InstancePool class.
     * @param Ctor The constructor for the type of instances this pool will store.
     */
    constructor(Ctor: T) {
        this.Ctor = Ctor;
    }

    /**
     * Retrieves an instance from the pool.
     * If the pool is empty, it creates a new instance using the constructor.
     * @returns An instance of the type stored in this pool.
     */
    public get(): InstanceType<T> {
        // If there are instances in the pool, return the last one
        // Otherwise, create a new instance using the constructor
        return this.list.pop() ?? new this.Ctor();
    }

    /**
     * Returns an instance to the pool.
     * @param item The instance to return to the pool.
     */
    public return(item: InstanceType<T>) {
        // Check if the item is already in the pool
        // If it is, don't add it again
        if (this.list.includes(item)) return;
        this.list.push(item);
    }
}

class PoolManager {
    /** A map from constructors to the corresponding InstancePool instances. */
    public readonly map: Map<new () => any, InstancePool> = new Map();

    /**
     * Retrieves an instance from the pool for the given constructor.
     * If there is no pool for this constructor, it creates one.
     * @param Ctor The constructor for the type of instance to retrieve.
     * @returns An instance of the specified type.
     */
    public get<T extends new () => InstanceType<T>>(Ctor: T): InstanceType<T> {
        // Check if there is an InstancePool for this constructor
        let pool = this.map.get(Ctor);

        // If there isn't, create a new InstancePool for this constructor
        if (!pool) {
            pool = new InstancePool(Ctor);
            this.map.set(Ctor, pool);
        }

        // Return an instance from the InstancePool
        return pool.get();
    }

    /**
     * Returns an instance to the appropriate pool.
     * @param item The instance to return to the pool.
     */
    public return(item: InstanceType<any>) {
        // Look up the InstancePool for this instance's constructor
        const pool = this.map.get(item.constructor);

        // If there is an InstancePool for this instance's constructor, return the item to it
        if (pool) pool.return(item);
    }
}

/** A singleton instance of the PoolManager class. */
export const pool = new PoolManager();
