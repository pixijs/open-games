/**
 * Simple local storage utility that can safely get/set number, boolean and object values too
 * not only string as in plain localStorage.
 */
class StorageWrapper {
    /** Get a string value from storage */
    public getString(key: string) {
        return localStorage.getItem(key) ?? undefined;
    }

    /** Set a string value to storage */
    public setString(key: string, value: string) {
        localStorage.setItem(key, value);
    }

    /** Get a number value from storage or undefined if value can't be converted */
    public getNumber(key: string) {
        const str = this.getString(key) ?? undefined;
        const value = Number(str);
        return isNaN(value) ? null : value;
    }

    /** Set a number value to storage */
    public setNumber(key: string, value: number) {
        this.setString(key, String(value));
    }

    /** Get a boolean value from storage or undefined if value can't be converted */
    public getBool(key: string) {
        const bool = localStorage.getItem(key);
        return bool ? Boolean(bool.toLowerCase()) : undefined;
    }

    /** Set a boolean value to storage */
    public setBool(key: string, value: boolean) {
        localStorage.setItem(key, String(value));
    }

    /** Get an object value from storage or undefined if value can't be parsed */
    public getObject(key: string) {
        const str = this.getString(key);
        if (!str) return undefined;
        try {
            return JSON.parse(str);
        } catch (e) {
            console.warn(e);
            return undefined;
        }
    }

    /** Set an object value to storage */
    public setObject(key: string, value: Record<string, unknown>) {
        this.setString(key, JSON.stringify(value));
    }
}

export const storage = new StorageWrapper();
