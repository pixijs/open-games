import { Container, Ticker } from 'pixi.js';
import { areBundlesLoaded, loadBundles } from './assets';
import { app } from '../main';
import { pool } from './pool';

/** Interface for app screens */
interface AppScreen extends Container {
    /** Show the screen */
    show?(): Promise<void>;
    /** Hide the screen */
    hide?(): Promise<void>;
    /** Pause the screen */
    pause?(): Promise<void>;
    /** Resume the screen */
    resume?(): Promise<void>;
    /** Prepare screen, before showing */
    prepare?(): void;
    /** Reset screen, after hidden */
    reset?(): void;
    /** Update the screen, passing delta time/step */
    update?(time: Ticker): void;
    /** Resize the screen */
    resize?(width: number, height: number): void;
    /** Blur the screen */
    blur?(): void;
    /** Focus the screen */
    focus?(): void;
}

/** Interface for app screens constructors */
interface AppScreenConstructor {
    new (): AppScreen;
    /** List of assets bundles required by the screen */
    assetBundles?: string[];
}

class Navigation {
    /** Container for screens */
    public container = new Container();

    /** Application width */
    public width = 0;

    /** Application height */
    public height = 0;

    /** Constant background view for all screens */
    public background?: AppScreen;

    /** Current screen being displayed */
    public currentScreen?: AppScreen;

    /** Current popup being displayed */
    public currentPopup?: AppScreen;

    /** Set the  default load screen */
    public setBackground(ctor: AppScreenConstructor) {
        this.background = new ctor();
        this.addAndShowScreen(this.background);
    }

    /** Add screen to the stage, link update & resize functions */
    private async addAndShowScreen(screen: AppScreen) {
        // Add navigation container to stage if it does not have a parent yet
        if (!this.container.parent) {
            app.stage.addChild(this.container);
        }

        // Add screen to stage
        this.container.addChild(screen);

        // Setup things and pre-organise screen before showing
        if (screen.prepare) {
            screen.prepare();
        }

        // Add screen's resize handler, if available
        if (screen.resize) {
            // Trigger a first resize
            screen.resize(this.width, this.height);
        }

        // Add update function if available
        if (screen.update) {
            app.ticker.add(screen.update, screen);
        }

        // Show the new screen
        if (screen.show) {
            screen.interactiveChildren = false;
            await screen.show();
            screen.interactiveChildren = true;
        }
    }

    /** Remove screen from the stage, unlink update & resize functions */
    private async hideAndRemoveScreen(screen: AppScreen) {
        // Prevent interaction in the screen
        screen.interactiveChildren = false;

        // Hide screen if method is available
        if (screen.hide) {
            await screen.hide();
        }

        // Unlink update function if method is available
        if (screen.update) {
            app.ticker.remove(screen.update, screen);
        }

        // Remove screen from its parent (usually app.stage, if not changed)
        if (screen.parent) {
            screen.parent.removeChild(screen);
        }

        // Clean up the screen so that instance can be reused again later
        if (screen.reset) {
            screen.reset();
        }
    }

    /**
     * Hide current screen (if there is one) and present a new screen.
     * Any class that matches AppScreen interface can be used here.
     */
    public async showScreen(ctor: AppScreenConstructor) {
        // Block interactivity in current screen
        if (this.currentScreen) {
            this.currentScreen.interactiveChildren = false;
        }

        // Load assets for the new screen, if available
        if (ctor.assetBundles && !areBundlesLoaded(ctor.assetBundles)) {
            // Load all assets required by this new screen
            await loadBundles(ctor.assetBundles);
        }

        // If there is a screen already created, hide and destroy it
        if (this.currentScreen) {
            await this.hideAndRemoveScreen(this.currentScreen);
        }

        // Create the new screen and add that to the stage
        this.currentScreen = pool.get(ctor);
        await this.addAndShowScreen(this.currentScreen);
    }

    /**
     * Resize screens
     * @param width Viewport width
     * @param height Viewport height
     */
    public resize(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.currentScreen?.resize?.(width, height);
        this.currentPopup?.resize?.(width, height);
        this.background?.resize?.(width, height);
    }

    /**
     * Show up a popup over current screen
     */
    public async presentPopup(ctor: AppScreenConstructor) {
        if (this.currentScreen) {
            this.currentScreen.interactiveChildren = false;
            await this.currentScreen.pause?.();
        }

        if (this.currentPopup) {
            await this.hideAndRemoveScreen(this.currentPopup);
        }

        this.currentPopup = new ctor();
        await this.addAndShowScreen(this.currentPopup);
    }

    /**
     * Dismiss current popup, if there is one
     */
    public async dismissPopup() {
        if (!this.currentPopup) return;
        const popup = this.currentPopup;
        this.currentPopup = undefined;
        await this.hideAndRemoveScreen(popup);
        if (this.currentScreen) {
            this.currentScreen.interactiveChildren = true;
            this.currentScreen.resume?.();
        }
    }

    /**
     * Blur screens when lose focus
     */
    public blur() {
        this.currentScreen?.blur?.();
        this.currentPopup?.blur?.();
        this.background?.blur?.();
    }

    /**
     * Focus screens
     */
    public focus() {
        this.currentScreen?.focus?.();
        this.currentPopup?.focus?.();
        this.background?.focus?.();
    }
}

/** Shared navigation instance */
export const navigation = new Navigation();
