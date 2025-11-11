const DEFAULT_STORAGE = {
    /**
     * Indicates if the audio is muted
     */
    muted: false,
    /**
     * The highest score achieved by the player
     */
    highscore: 0,
};

export type StorageData = typeof DEFAULT_STORAGE;

/**
 * The ID of the local storage where the data is stored.
 */
const STORAGE_ID = 'bubbo-bubbo';

export const storage = {
    /**
     * Initializes the storage data to the default if not already set.
     */
    readyStorage() {
        if (!localStorage.getItem(STORAGE_ID)) this.setStorage(DEFAULT_STORAGE);
    },
    /**
     * Retrieves the storage data.
     * @returns The storage data if it exists, undefined otherwise.
     */
    getStorage(): StorageData | undefined {
        const data = localStorage.getItem(STORAGE_ID);

        return data ? JSON.parse(data) : undefined;
    },
    /**
     * Retrieves a specific value from the storage data.
     * @param key - The key of the value to retrieve.
     * @returns The retrieved value.
     */
    getStorageItem<T extends keyof StorageData>(key: T): StorageData[T] {
        const data = this.getStorage()!;

        return data[key];
    },
    /**
     * Sets a specific value in the storage data.
     * @param key - The key of the value to set.
     * @param value - The value to set.
     * @returns The set value.
     */
    setStorageItem<T extends keyof StorageData>(key: T, value: StorageData[T]): StorageData[T] {
        const data = this.getStorage()!;

        // Check if storage and intended item exists
        if (data && key in data) {
            data[key] = value;

            // Replace local storage
            this.setStorage(data);
        }

        return data[key];
    },
    /**
     * Sets the entire storage data.
     * @param data - The data to set.
     * @returns The set data.
     */
    setStorage(data: StorageData) {
        return localStorage.setItem(STORAGE_ID, JSON.stringify(data, undefined, 2));
    },
};
