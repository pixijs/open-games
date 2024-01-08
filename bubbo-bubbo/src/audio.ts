import { PlayOptions, Sound, sound } from '@pixi/sound';
import gsap from 'gsap';

/**
 * A class to handle background music within the game.
 * It automatically loops audio and fades between tracks.
 */
class BGM {
    /** The alias so it doesn't swap audio to the same one. */
    public currentAlias?: string;
    /** The current sound instance. */
    public current?: Sound;

    /** A global volume that affects all bgm sounds. */
    private _globalVolume = 0.15;
    /** An instance volume that affects the current sound. */
    private _instanceVolume = 0.15;

    /**
     * Play background music.
     * @param alias - Name of the audio file.
     * @param options - Options to be passed to the sound instance.
     */
    public async play(alias: string, options?: PlayOptions) {
        // Do nothing if the requested music is already being played
        if (this.currentAlias === alias) return;

        // Fade out then stop current music
        if (this.current) {
            const current = this.current;

            gsap.killTweensOf(current);
            gsap.to(current, { volume: 0, duration: 1, ease: 'linear' }).then(() => {
                current.stop();
            });
        }

        // Find out the new instance to be played
        this.current = sound.find(alias);

        // Play and fade in the new music
        this.currentAlias = alias;
        this.current.play({ loop: true, ...options });
        this.current.volume = 0;
        gsap.killTweensOf(this.current);

        // Store the instance volume just in case global volume is changed
        this._instanceVolume = options?.volume ?? 1;

        gsap.to(this.current, {
            volume: this._globalVolume * this._instanceVolume,
            duration: 1,
            ease: 'linear',
        });
    }

    /**
     * Set the global volume.
     * @param v - Target volume.
     */
    public setVolume(v: number) {
        this._globalVolume = v;
        if (this.current) this.current.volume = this._globalVolume * this._instanceVolume;
    }

    /**
     * Get the global volume.
     */
    public getVolume() {
        return this._globalVolume;
    }
}

/**
 * A class to handle sound effects within the game.
 */
class SFX {
    /** A global volume that affects all sfx sounds. */
    private _volume = 0.5;

    /**
     * Play sound effects.
     * @param alias - Name of the audio file.
     * @param options - Options to be passed to the sound instance.
     */
    public play(alias: string, options?: PlayOptions) {
        const volume = this._volume * (options?.volume ?? 1);

        sound.play(alias, { ...options, volume });
    }

    /**
     * Set the global volume.
     * @param v - Target volume.
     */
    public setVolume(v: number) {
        this._volume = v;
    }

    /**
     * Get the global volume.
     */
    public getVolume() {
        return this._volume;
    }
}

/**
 * A object to hold methods that handle certain features on the global sound instance
 */
export const audio = {
    /**
     * Mute the global sound instance.
     * @param value - The audio mute state.
     */
    muted(value: boolean) {
        if (value) sound.muteAll();
        else sound.unmuteAll();
    },
    /** Get the volume of the global sound instance. */
    getMasterVolume() {
        return sound.volumeAll;
    },
    /** Set the volume of the global sound instance.
     * @param v - The target global volume.
     */
    setMasterVolume(v: number) {
        sound.volumeAll = v;
        if (!v) {
            sound.muteAll();
        } else {
            sound.unmuteAll();
        }
    },
};

/**
 * A class to handle background music within the game.
 * It automatically loops audio and fades between tracks.
 */
export const bgm = new BGM();
/**
 * A class to handle sound effects within the game.
 */
export const sfx = new SFX();
