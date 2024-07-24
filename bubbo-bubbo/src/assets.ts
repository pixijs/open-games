import {
    Assets,
    extensions,
    ExtensionType,
    Resolver,
    resolveTextureUrl,
    ResolveURLParser,
    UnresolvedAsset,
} from 'pixi.js';

import manifest from '../src/manifest.json';

export const resolveJsonUrl = {
    extension: ExtensionType.ResolveParser,
    test: (value: string): boolean => Resolver.RETINA_PREFIX.test(value) && value.endsWith('.json'),
    parse: resolveTextureUrl.parse,
} as ResolveURLParser;

extensions.add(resolveJsonUrl);

/** Initialise and start background loading of all assets */
export async function initAssets() {
    // Init PixiJS assets with this asset manifest
    await Assets.init({ manifest, basePath: 'assets' });

    // Load assets for the load screen
    await Assets.loadBundle(['preload', 'default']);

    // List all existing bundles names
    const allBundles = manifest.bundles.map((item) => item.name);

    // Start up background loading of all bundles
    Assets.backgroundLoadBundle(allBundles);
}

/**
 * Check to see if a bundle has loaded
 * @param bundle - The unique id of the bundle
 * @returns Whether or not the bundle has been loaded
 */
export function isBundleLoaded(bundle: string) {
    const bundleManifest = manifest.bundles.find((b) => b.name === bundle);

    if (!bundleManifest) {
        return false;
    }

    for (const asset of bundleManifest.assets as UnresolvedAsset[]) {
        if (!Assets.cache.has(asset.alias as string)) {
            return false;
        }
    }

    return true;
}

export function areBundlesLoaded(bundles: string[]) {
    for (const name of bundles) {
        if (!isBundleLoaded(name)) {
            return false;
        }
    }

    return true;
}
