import { Assets, Container, Ticker } from 'pixi.js';

import { areBundlesLoaded } from './assets';
import { app } from './main';

/** Interface for app screens */
export interface AppScreen<T = any> extends Container {
    prepare?: (data?: T) => void;
    show?: () => Promise<void>;
    hide?: () => Promise<void>;
    update?: (time: Ticker) => void;
    resize?: (w: number, h: number) => void;
}

/** Interface for app screens constructors */
interface AppScreenConstructor {
    /** A unique identifier for the screen */
    readonly SCREEN_ID: string;
    readonly assetBundles?: string[];
    new (): AppScreen;
}

/** A class to handle screen and overlay navigation */
class Navigation {
    /** The view that contains the screens */
    public screenView = new Container();
    /** The view that contains the overlays */
    public overlayView = new Container();

    /** Current screen being displayed */
    private currentScreen?: AppScreen;

    /** Resize function to avoid problems with scope */
    private currentScreenResize?: () => void;

    /** Default load screen */
    private loadScreen?: AppScreen;

    /** Current overlay being displayed */
    private currentOverlay?: AppScreen;

    /** Resize function to avoid problems with scope */
    private currentOverlayResize?: () => void;

    /** The width of the screen */
    private _w!: number;
    /** The height of the screen */
    private _h!: number;

    private readonly _screenMap = new Map<string, AppScreen>();

    public init() {
        app.stage.addChild(this.screenView, this.overlayView);
    }

    /**
     * Set the default load screen.
     * @param Ctor - The constructor for the load screen.
     * */
    public setLoadScreen(Ctor: AppScreenConstructor) {
        this.loadScreen = this._getScreen(Ctor);
    }

    /**
     * Shows an overlay screen overtop of the current screen.
     * @param Ctor - The constructor for the overlay screen.
     * @param data - Data that is to be sent to the overlay.
     */
    public async showOverlay<T>(Ctor: AppScreenConstructor, data?: T) {
        // Shows a screen but designates it as an overlay
        // So it is shown above the current screen instead of replaces it
        this._showScreen(Ctor, true, data);
    }

    /**
     * Hide current screen (if there is one) and present a new screen.
     * Any class that matches AppScreen interface can be used here.
     * @param Ctor - The constructor for the screen.
     * @param data - Data that is to be sent to the screen.
     */
    public async goToScreen<T>(Ctor: AppScreenConstructor, data?: T) {
        // Shows a screen but does not designate it as an overlay
        // So it replaces the current screen
        this._showScreen(Ctor, false, data);
    }

    /** Hides the current overlay if one is active. */
    public async hideOverlay() {
        if (!this.currentOverlay) return;

        this._removeScreen(this.currentOverlay, true);
    }

    /**
     * Gets a screen instance from the screen map.
     * @param Ctor The constructor for the screen.
     * @returns The instance of the screen being requested.
     */
    private _getScreen(Ctor: AppScreenConstructor) {
        // Checks if a screen instance exists on the screen map
        let screen = this._screenMap.get(Ctor.SCREEN_ID);

        // If not, then create a new instance and assign it to the screen map
        if (!screen) {
            screen = new Ctor();
            this._screenMap.set(Ctor.SCREEN_ID, screen);
        }

        return screen;
    }

    /**
     * Add screen to the stage, link update & resize functions.
     * @param screen - The screen instance being added.
     * @param isOverlay - A flag to determine if the screen is an overlay.
     */
    private async _addScreen(screen: AppScreen, isOverlay = false) {
        // Add screen to stage
        (isOverlay ? this.overlayView : this.screenView).addChild(screen);

        // Add screen's resize handler, if available
        if (screen.resize) {
            // Encapsulate resize in another function that can be removed later, to avoi scope issues with addEventListener

            if (isOverlay) {
                this.currentOverlayResize = () => screen.resize;
            } else {
                this.currentScreenResize = () => screen.resize;
            }

            // Trigger a first resize
            screen.resize(this._w, this._h);
        }

        // Add update function if available
        if (screen.update) {
            app.ticker.add(screen.update, screen);
        }

        // Show the new screen
        if (screen.show) {
            await screen.show();
        }
    }

    /**
     * Remove screen from the stage, unlink update & resize functions.
     * @param screen - The screen instance being added.
     * @param isOverlay - A flag to determine if the screen is an overlay.
     */
    private async _removeScreen(screen: AppScreen, isOverlay = false) {
        // Hide screen if method is available
        if (screen.hide) {
            await screen.hide();
        }

        // Unlink resize handler if exists
        if (isOverlay) {
            this.currentOverlayResize && window.removeEventListener('resize', this.currentOverlayResize);
        } else {
            this.currentScreenResize && window.removeEventListener('resize', this.currentScreenResize);
        }

        // Unlink update function if method is available
        if (screen.update) {
            app.ticker.remove(screen.update, screen);
        }

        // Remove screen from its parent (usually app.stage, if not changed)
        if (screen.parent) {
            screen.parent.removeChild(screen);
        }
    }

    /**
     * Hide current screen (if there is one), load bundles and present a new screen.
     * @param Ctor - The screen instance being added.
     * @param isOverlay - A flag to determine if the screen is an overlay.
     * @param data- Data to be sent to the screen.
     */
    private async _showScreen<T>(Ctor: AppScreenConstructor, isOverlay: boolean, data: T) {
        const current = isOverlay ? this.currentOverlay : this.currentScreen;

        // If there is a screen already created, hide it
        if (current) {
            await this._removeScreen(current);
        }

        // Load assets for the new screen, if available
        if (Ctor.assetBundles && !areBundlesLoaded(Ctor.assetBundles)) {
            // If assets are not loaded yet, show loading screen, if there is one
            if (this.loadScreen) {
                this._addScreen(this.loadScreen, isOverlay);
            }

            // Load all assets required by this new screen
            await Assets.loadBundle(Ctor.assetBundles);

            // Hide loading screen, if exists
            if (this.loadScreen) {
                this._removeScreen(this.loadScreen, isOverlay);
            }
        }

        // Create the new screen and add to the stage
        if (isOverlay) {
            this.currentOverlay = this._getScreen(Ctor);
            this.currentOverlay.prepare?.(data);
            await this._addScreen(this.currentOverlay, isOverlay);
        } else {
            this.currentScreen = this._getScreen(Ctor);
            this.currentScreen.prepare?.(data);
            await this._addScreen(this.currentScreen, isOverlay);
        }
    }

    /**
     * Gets called every time the screen resizes.
     * Forwards the screen width and height to the current screen and overlay.
     * @param w - width of the screen.
     * @param h - height of the screen.
     */
    public resize(w: number, h: number) {
        this._w = w;
        this._h = h;
        this.currentScreen?.resize?.(w, h);
        this.currentOverlay?.resize?.(w, h);
    }
}

/** A class instance to handle screen and overlay navigation */
export const navigation = new Navigation();
