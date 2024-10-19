# Bubbo Bubbo

Welcome to the Bubbo Bubbo open source game! This project was created to help developers learn how a professional makes games using the PixiJS library. The goal of this project is to provide a comprehensive guide and example of game development in PixiJS.

This project utilises multiple pixi based libraries including;
- [PixiJS](https://github.com/pixijs/pixijs) a rendering library built for the web.
- [Sound](https://github.com/pixijs/sound) a WebAudio API playback library, with filters. 
- [UI](https://github.com/pixijs/ui) for ease creation of commonly used UI components in PixiJS.
- [AssetPack](https://github.com/pixijs/assetpack) that optimises assets for the web!

# Features
- Simple, yet comprehensive example of a PixiJS game,
- Clear and concise code explanations,
- Includes essential game development concepts such as stat management, systems, game loops, and user input etc.
- Designed to be easily understandable and expandable for further learning and development

# Prerequisites
To run this project, you need to have `Node.js` and `npm` installed on your system.

# Setup and run the game
```sh
# Clone the repository
git clone https://github.com/pixijs/open-games

# Clone the repository
cd ./bubbo-bubbo

# Install dependencies
npm install

# Start the project
npm run start
```

# Building the game
```sh
# Compile the game into a bundle, which can be found in `dist/`
npm run build
```
# Known issues
- Asset bundles aren't currently watched, so any assets being added or removed would mean you have to run `npm run build-assets` again
- It may take a while for vite to launch the game on localhost

# Open Source Figma Design
### View the Figma file [here](https://www.figma.com/file/XhYGrHOi4txWYHjfG1n4lj/Bubbo-Bubbo?node-id=0%3A1)

In addition to making the code for this game open source, we are also making the Figma design file used to create the game available to the community. It contains all the design elements, assets, and layouts used in the game.

By making the file open source, we hope to provide an even more comprehensive learning experience for developers. You can use this as a reference for your own design projects or to see how a professional designs games.

> Please note that the design file is only available as a read-only version. This means you can view and inspect the file, but you cannot make changes or use any of the assets for your own projects.

# Usage
Feel free to use this project as a reference for your own game development. Use the code comments to understand how the game works and experiment by making changes to the code to see how it affects the game. This project is designed to be a starting point for your own learning and development journey with PixiJS.

# Contributions
We encourage you to fork the repository and improve the game in any way you see fit. Share your improvements with the community by submitting pull requests to the original repository.

# License
This project is licensed under the [MIT License](https://opensource.org/licenses/MIT).

## GSAP

This game uses GSAP for its animations. You can use the free version of GSAP for some commercial projects. However please check the licensing options from [GreenSock](https://greensock.com/licensing/).

---
> Author [@AshsHub](https://github.com/AshsHub)