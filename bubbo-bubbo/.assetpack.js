import { pixiPipes } from '@assetpack/core/pixi';

export default {
    entry: './raw-assets',
    output: './public/assets/',
    cache: true,
    pipes: [
        ...pixiPipes({
            cacheBust: false,
            texturePacker: {
                texturePacker: {
                    removeFileExtension: true,
                },
            },
            manifest: {
                output: './src/manifest.json',
            },
        }),
    ],
};
