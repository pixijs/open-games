/** Get url parameter by name */
export function getUrlParam(param: string) {
    const queryString = window.location.search;
    const urlParams = new URLSearchParams(queryString);
    return urlParams.get(param);
}

/** Get url parameter by name and ensure value as number, if that can be converted, or null otherwise */
export function getUrlParamNumber(param: string) {
    const value = getUrlParam(param);
    if (!value) return null;
    const valueNumber = Number(value);
    if (isNaN(valueNumber)) return null;
    return valueNumber;
}
