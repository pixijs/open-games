/**
 * Retrieves the value of a specified query parameter from the current URL
 * @param param - the name of the query parameter to retrieve
 * @returns the value of the specified query parameter, or null if it does not exist
 */
export function getUrlParam(param: string) {
    const queryString = window.location.search;
    const urlParams = new URLSearchParams(queryString);

    return urlParams.get(param);
}

/**
 * Removes an item from an array if it exists
 * @param arr - array to remove from
 * @param item - item to remove
 * @returns an array with the item removed
 */
export function removeFromArray<T>(arr: T[], item: T): T[] {
    ~arr.indexOf(item) && arr.splice(arr.indexOf(item), 1);

    return arr;
}

/**
 * Removes all items from an array and calls a function for each item
 * @param arr - array to remove from
 * @param callback - a callback per item
 * @returns an empty array
 * @remarks if you just want to clear the array without the callback, use `array.length = 0` instead
 */
export function removeAllFromArray<T>(arr: T[], callback?: (item: T) => void): T[] {
    for (let i = arr.length - 1; i >= 0; --i) {
        const item = arr[i];

        callback?.(item);
        removeFromArray(arr, item);
    }

    return arr;
}
