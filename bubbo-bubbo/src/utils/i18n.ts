/**
 * Import the dictionary of English i18n strings.
 */
import { i18nDict } from './i18n-en';

/**
 * Type that defines the structure of the i18n dictionary.
 */
export type I18nDictionary = typeof i18nDict;

/**
 * Type that defines the keys for the i18n dictionary.
 */
export type I18nKey = keyof typeof i18nDict;

/**
 * Type that defines the parameters for the i18n strings.
 */
export type I18nParams = Record<string, string | number>;

/**
 * Class that provides methods for internationalization.
 */
export class I18n {
    /**
     * Property that stores the i18n dictionary.
     */
    public readonly dict: I18nDictionary = i18nDict;

    /**
     * Method that returns the translated string for a given key and parameters.
     * @param k - The key of the i18n string to be translated.
     * @param params - The parameters to replace placeholders in the i18n string.
     * @returns The translated string.
     */
    public t(k: I18nKey, params?: I18nParams) {
        let str = this.dict[k];

        if (params) {
            if (typeof params.variation === 'number') {
                const match = /\[(.*?)\]/.exec(str);

                if (match) {
                    /**
                     * Split the string by the "|" character to get an array of variations.
                     */
                    const items = match[1].split('|');

                    /**
                     * Get the selected variation based on the "variation" param.
                     */
                    const selected = items[params.variation];

                    /**
                     * Replace the original string with the selected variation.
                     */
                    str = str.replace(match[0], selected);
                }
            }

            /**
             * Iterate over all params to replace placeholders in the string.
             */
            for (const f in params) {
                /**
                 * Create a regular expression to match the placeholder for the current param.
                 */
                const re = new RegExp(`{${f}}`, 'g');

                /**
                 * Replace all occurences of the placeholder with the value of the param.
                 */
                str = str.replace(re, String(params[f]));
            }
        }

        /**
         * Return the final translated string.
         */
        return str;
    }
}

/**
 * Singleton instance of the I18n class.
 */
export const i18n = new I18n();
