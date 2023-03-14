# Puzzling Potions

Open-source Match-3 game done in PixiJS. The goal of this project is to provide a simple and comprehensive example of professional game development using PixiJS technologies.

This project is built on top of the following PixiJS-based libraries:

-   [PixiJS](https://github.com/pixijs/pixijs) A rendering library built for the web.
-   [PixiJS Sound](https://github.com/pixijs/sound) A WebAudio API playback library, with filters.
-   [PixiJS UI](https://github.com/pixijs/ui) For commonly used UI components in PixiJS.
-   [PixiJS AssetPack](https://github.com/pixijs/assetpack) Compile and optimise assets for the web.
-   [PixiJS Spine](https://github.com/pixijs/spine) Spine animation support for PixiJS

# Features

-   A simple Match-3 game with special powers and effects
-   Basic navigation system to organise screens and popups
-   Asset loading management using PixiJS assets bundles
-   Persistent user settings for sound volume and game mode
-   Save & load scores and best scores
-   Animations, transitions and visual effects
-   Desktop & mobile compatible

# Prerequisites

-   NodeJS - https://nodejs.org/
-   NPM - Comes with NodeJS, for package management

# Setup & Run The Game

```sh
# Clone the repository
git clone https://github.com/pixijs/open-games

# Enter the project folder
cd ./puzzling-potions

# Install dependencies
npm install

# Start the project for development
npm run start
```

# Building The Game

```sh
# Compile the game for publishing, outputs to `dist/`
npm run build

# Build the game for publishing and preview it locally
npm run preview
```

# Compiling Assets

Assets are compiled whenever you start or build the project, but they are not 'watched' (yet) like regular code while developing. If you add/modify/remove any assets while developing, you have to run `npm run assets` manually to recompile them and make the changes to take effect.

# Project Structure

### `./src/main.ts` file

Where everything starts. Sets up the PixiJS app and initialise navigation.

### `./src/screens` folder

All screens displayed by the app.

### `./src/popups` folder

Modal panels that shows up on top of screens.

### `./src/match3` folder

The game itself, with all Match-3 related code featuring gameplay logic and piece visuals.

### `./src/ui` folder

All UI components shared across screens.

### `./src/utils` folder

All the shared utility code.

### `./raw-assets` folder

Uncompiled assets grouped in folders that will be translated into assets bundles for loading.

# Open Source Figma Design

### View the Figma file [here](https://www.figma.com/file/Oqq2dAyNGL1g3Li0DGjnH2/Match-3?node-id=0%3A1&t=6fHhwUzb0b1PGGkJ-0)

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

> Author [Mauro](https://github.com/maurodetarso)

---
