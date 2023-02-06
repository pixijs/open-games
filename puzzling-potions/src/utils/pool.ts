/**
 * Pool instances of a certain class for reusing.
 */
class Pool<T extends new () => InstanceType<T> = new () => any> {
    public readonly ctor: T;
    public readonly list: InstanceType<T>[] = [];

    constructor(ctor: T) {
        this.ctor = ctor;
    }

    public get() {
        return this.list.pop() ?? new this.ctor();
    }

    public giveBack(item: InstanceType<T>) {
        if (this.list.includes(item)) return;
        this.list.push(item);
    }
}

/**
 * Pool instances of any class, organising internal pools by constructor.
 */
class MultiPool {
    public readonly map: Map<new () => any, Pool> = new Map();

    public get<T extends new () => InstanceType<T>>(ctor: T): InstanceType<T> {
        let pool = this.map.get(ctor);
        if (!pool) {
            pool = new Pool(ctor);
            this.map.set(ctor, pool);
        }
        return pool.get();
    }

    public giveBack(item: InstanceType<any>) {
        const pool = this.map.get(item.constructor);
        if (pool) pool.giveBack(item);
    }
}

/**
 * Shared multi-class pool instance
 */
export const pool = new MultiPool();
