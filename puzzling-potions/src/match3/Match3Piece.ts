import { Container, FederatedPointerEvent, Sprite, Texture } from 'pixi.js';
import gsap from 'gsap';
import { Match3Position } from './Match3Utility';
import { resolveAndKillTweens, registerCustomEase, pauseTweens, resumeTweens } from '../utils/animation';
import { app } from '../main';

/** Default piece options */
const defaultMatch3PieceOptions = {
    /** Piece name, must match one of the textures available */
    name: '',
    /** Attributed piece type in the grid */
    type: 0,
    /** Piece size - width & height - in pixel */
    size: 50,
    /** Set if the piece should be highlighted, like special types */
    highlight: false,
    /** Enable or disable its interactivity */
    interactive: false,
};

/** Piece configuration parameters */
export type Match3PieceOptions = typeof defaultMatch3PieceOptions;

/** Custom ease curve for y animation of falling pieces */
const easeSingleBounce = registerCustomEase(
    'M0,0,C0.14,0,0.27,0.191,0.352,0.33,0.43,0.462,0.53,0.963,0.538,1,0.546,0.985,0.672,0.83,0.778,0.83,0.888,0.83,0.993,0.983,1,1',
);

/**
 * The visual representation of a piece in the board. Pieces are the point of interaction with the board
 * because of simplicity, setting up the pointer listeners and passing them up through callbacks.
 * They also have their own set of animations and they will be locked while playing them, to avoid
 * positioning conflicts.
 */
export class Match3Piece extends Container {
    /** The interactive area of the piece */
    private readonly area: Sprite;
    /** The actual image of the piece */
    private readonly image: Sprite;
    /** The highlight sprite that can be enabled or disabled */
    private readonly highlight: Sprite;
    /** True if piece is being touched */
    private pressing = false;
    /** True if piece is being dragged */
    private dragging = false;
    /** The initial x position of the press */
    private pressX = 0;
    /** The initial y position of the press */
    private pressY = 0;
    /** True if animations are paused */
    private paused = false;
    /** The row index of the piece */
    public row = 0;
    /** The column index of the piece */
    public column = 0;
    /** The piece type in the grid */
    public type = 0;
    /** The name of the piece - must match one of the available textures */
    public name = '';
    /** Callback that fires when the player drags the piece for a move */
    public onMove?: (from: Match3Position, to: Match3Position) => void;
    /** Callback that fires when the player tap the piece */
    public onTap?: (position: Match3Position) => void;

    constructor() {
        super();
        this.highlight = Sprite.from('highlight');
        this.highlight.anchor.set(0.5);
        this.addChild(this.highlight);

        this.image = new Sprite();
        this.image.anchor.set(0.5);
        this.addChild(this.image);

        this.area = new Sprite(Texture.WHITE);
        this.area.anchor.set(0.5);
        this.area.alpha = 0;
        this.addChild(this.area);

        this.area.on('pointerdown', this.onPointerDown);
        this.area.on('pointermove', this.onPointerMove);
        this.area.on('pointerup', this.onPointerUp);
        this.area.on('pointerupoutside', this.onPointerUp);
        this.area.on('pointercancel', this.onPointerUp);

        this.onRender = () => this.renderUpdate();
    }

    /**
     * Set up the visuals. Pieces can be resused and set up with different params freely.
     * @param options The setup options
     */
    public setup(options: Partial<Match3PieceOptions> = {}) {
        const opts = { ...defaultMatch3PieceOptions, ...options };
        this.killTweens();
        this.paused = false;
        this.pressing = false;
        this.dragging = false;
        this.visible = true;
        this.alpha = 1;
        this.type = opts.type;
        this.name = opts.name;
        this.image.alpha = 1;
        this.scale.set(1);
        this.image.texture = Texture.from(opts.name);
        this.image.width = opts.size - (opts.highlight ? 2 : 8);
        this.image.height = this.image.width;
        this.highlight.visible = opts.highlight;
        this.highlight.width = opts.size;
        this.highlight.height = opts.size;
        this.highlight.alpha = 0.3;
        this.area.width = opts.size;
        this.area.height = opts.size;
        this.area.interactive = opts.interactive;
        this.area.cursor = 'pointer';
        this.unlock();
    }

    /** Interaction mouse/touch down handler */
    private onPointerDown = (e: FederatedPointerEvent) => {
        if (this.isLocked()) return;
        this.pressing = true;
        this.dragging = false;
        this.pressX = e.globalX;
        this.pressY = e.globalY;
    };

    /** Interaction mouse/touch move handler */
    private onPointerMove = (e: FederatedPointerEvent) => {
        if (!this.pressing || this.isLocked()) return;

        const moveX = e.globalX - this.pressX;
        const moveY = e.globalY - this.pressY;
        const distanceX = Math.abs(moveX);
        const distanceY = Math.abs(moveY);
        const distance = Math.sqrt(distanceX * distanceX + distanceY * distanceY);

        if (distance > 10) {
            this.dragging = true;
            const from = { row: this.row, column: this.column };
            const to = { row: this.row, column: this.column };

            if (distanceX > distanceY) {
                if (moveX < 0) {
                    // Move left
                    to.column -= 1;
                    this.onMove?.(from, to);
                } else {
                    // Move right
                    to.column += 1;
                    this.onMove?.(from, to);
                }
            } else {
                if (moveY < 0) {
                    // Move up
                    to.row -= 1;
                    this.onMove?.(from, to);
                } else {
                    // Move down
                    to.row += 1;
                    this.onMove?.(from, to);
                }
            }
            this.onPointerUp();
        }
    };

    /** Interaction mouse/touch up handler */
    private onPointerUp = () => {
        if (this.pressing && !this.dragging && !this.isLocked()) {
            const position = { row: this.row, column: this.column };
            this.onTap?.(position);
        }
        this.dragging = false;
        this.pressing = false;
    };

    /** Slide animation */
    public async animateSwap(x: number, y: number) {
        this.lock();
        resolveAndKillTweens(this);
        const duration = 0.2;
        await gsap.to(this, { x, y, duration, ease: 'quad.out' });
        this.unlock();
    }

    /** Fall to position animation */
    public async animateFall(x: number, y: number) {
        this.lock();
        resolveAndKillTweens(this.position);
        const duration = 0.5;
        await gsap.to(this.position, { x, y, duration, ease: easeSingleBounce });
        this.unlock();
    }

    /** Pop out animation */
    public async animatePop() {
        this.lock();
        resolveAndKillTweens(this.image);
        const duration = 0.1;
        await gsap.to(this.image, { alpha: 0, duration, ease: 'sine.out' });
        this.visible = false;
    }

    /** Spawn animation */
    public async animateSpawn() {
        this.lock();
        resolveAndKillTweens(this.scale);
        this.scale.set(2);
        this.visible = true;
        const duration = 0.2;
        gsap.to(this.scale, { x: 1, y: 1, duration, ease: 'back.out' });
        this.unlock();
    }

    public renderUpdate() {
        if (this.paused) return;
        if (this.highlight.visible) {
            this.highlight.rotation += app.ticker.deltaTime * 0.03;
            this.image.rotation = Math.sin(app.ticker.lastTime * 0.01) * 0.1;
        } else {
            this.image.rotation = 0;
        }
    }

    /** Resolve and kill all current tweens */
    private killTweens() {
        resolveAndKillTweens(this);
        resolveAndKillTweens(this.position);
        resolveAndKillTweens(this.scale);
        resolveAndKillTweens(this.image);
    }

    /** Pause all current tweens */
    public pause() {
        this.paused = true;
        pauseTweens(this);
        pauseTweens(this.position);
        pauseTweens(this.scale);
        pauseTweens(this.image);
    }

    /** Resume pending tweens */
    public resume() {
        this.paused = false;
        resumeTweens(this);
        resumeTweens(this.position);
        resumeTweens(this.scale);
        resumeTweens(this.image);
    }

    /** Lock piece interactivity, preventing mouse/touch events */
    public lock() {
        this.interactiveChildren = false;
        this.dragging = false;
        this.pressing = false;
    }

    /** Unlock piece interactivity, preventing mouse/touch events */
    public unlock() {
        this.interactiveChildren = true;
    }

    /** CHeck if piece is locked */
    public isLocked() {
        return !this.interactiveChildren;
    }

    /** Shortcut to get the grid position of the piece */
    public getGridPosition() {
        return { row: this.row, column: this.column };
    }
}
