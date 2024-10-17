/**
 * Pool instances of a certain class for reusing.
 */
class Pool<T extends new () => InstanceType<T> = new () => any> {
    /** The constructor for new instances */
    public readonly ctor: T;
    /** List of idle instances ready to be reused */
    public readonly list: InstanceType<T>[] = [];

    constructor(ctor: T) {
        this.ctor = ctor;
    }

    /** Get an idle instance from the pool, or create a new one if there is none available */
    public get() {
        return this.list.pop() ?? new this.ctor();
    }

    /** Return an instance to the pool, making it available to be reused */
    public giveBack(item: InstanceType<T>) {
        if (this.list.includes(item)) return;
        this.list.push(item);
    }
}

/**
 * Pool instances of any class, organising internal pools by constructor.
 */
class MultiPool {
    /** Map of pools per class */
    public readonly map: Map<new () => any, Pool> = new Map();

    /** Get an idle instance of given class, or create a new one if there is none available */
    public get<T extends new () => InstanceType<T>>(ctor: T): InstanceType<T> {
        let pool = this.map.get(ctor);
        if (!pool) {
            pool = new Pool(ctor);
            this.map.set(ctor, pool);
        }
        return pool.get();
    }

    /** Return an instance to its pool, making it available to be reused */
    public giveBack(item: InstanceType<any>) {
        const pool = this.map.get(item.constructor);
        if (pool) pool.giveBack(item);
    }
}

/**
 * Shared multi-class pool instance
 */
export const pool = new MultiPool();
