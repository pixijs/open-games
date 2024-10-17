import { Container } from 'pixi.js';
import { Match3OnMatchData, Match3OnMoveData, Match3OnPopData } from '../match3/Match3';
import { Match3Piece } from '../match3/Match3Piece';
import { randomRange } from '../utils/random';
import gsap from 'gsap';
import { GameScreen } from '../screens/GameScreen';
import { earthquake, registerCustomEase } from '../utils/animation';
import { getDistance } from '../utils/maths';
import { pool } from '../utils/pool';
import { sfx } from '../utils/audio';
import { PopExplosion } from './PopExplosion';
import { waitFor } from '../utils/asyncUtils';
import { throttle } from '../utils/throttle';

/** Custom ease curve for x tweens of pieces flying to cauldron */
const easeJumpToCauldronX = registerCustomEase('M0,0,C0,0,0.063,-0.304,0.374,-0.27,0.748,-0.228,1,1,1,1');

/** Custom ease curve for y tweens of pieces flying to cauldron */
const easeJumpToCauldronY = registerCustomEase('M0,0 C0,0 0.326,1.247 0.662,1.29 0.898,1.32 1,1 1,1 ');

/** Custom ease curve for scale tweens of pieces flying to cauldron */
const easeJumpToCauldronScale = registerCustomEase('M0,0,C0,0,0.043,-1.694,0.356,-1.694,1.026,-1.694,1,1,1,1');

/**
 * All gameplay special effects, isolated on its own class in a way that can be changed freely, without affecting gameplay.
 * List of special effects in this class:
 * - Piece Move - Play a short sfx accordingly if the movement is allowed or not
 * - Piece Explosion - When a piece is popped out, play a little explosion animation in place
 * - Piece Pop - When a non-special piece is popped out, it flies to the cauldron
 * - Match Done - When a match happens, play sfx and "shake" the game according to the combo level
 * - Gird Explosion - Explode all pieces out of the grid, played when gameplay finishes
 */
export class GameEffects extends Container {
    /** The game screen instance */
    private game: GameScreen;

    constructor(game: GameScreen) {
        super();
        this.game = game;
        this.sortableChildren = true;
        this.onRender = () => this.renderUpdate();
    }

    /** Auto-update every frame */
    public renderUpdate() {
        // Update children z indexes to auto organise their order according
        // to their scales, to create a sort of a "3d depth" simulation
        for (const child of this.children) {
            child.zIndex = child.scale.x;
        }
    }

    /** Fired when a piece is moved */
    public async onMove(data: Match3OnMoveData) {
        if (!data.valid) {
            sfx.play('common/sfx-incorrect.wav', { volume: 0.5 });
        } else {
            sfx.play('common/sfx-correct.wav', { volume: 0.5 });
        }
    }

    /** Fired when a piece is popped out from the grid */
    public async onPop(data: Match3OnPopData) {
        const position = this.toLocal(data.piece.getGlobalPosition());
        this.playPopExplosion(position);

        if (!data.isSpecial) {
            const position = this.toLocal(data.piece.getGlobalPosition());
            const piece = pool.get(Match3Piece);
            piece.setup({
                name: data.piece.name,
                type: data.piece.type,
                size: this.game.match3.board.tileSize,
                interactive: false,
            });
            piece.position.copyFrom(position);
            this.addChild(piece);
            await this.playFlyToCauldron(piece);
            this.removeChild(piece);
            pool.giveBack(piece);
        } else {
            sfx.play('common/sfx-special.wav', { volume: 0.5 });
            earthquake(this.game.pivot, 15);
        }
    }

    /** Fired when a match is detected */
    public async onMatch(data: Match3OnMatchData) {
        const progress = 0.04;
        sfx.play('common/sfx-match.wav', { speed: 1 - progress + data.combo * progress });
        if (data.combo > 1) earthquake(this.game.pivot, Math.min(1 + data.combo * 0.5, 20));
    }

    /** Make the piece fly to cauldron with a copy of the original piece created in its place */
    public async playFlyToCauldron(piece: Match3Piece) {
        const x = this.game.cauldron.x + randomRange(-20, 20);
        const y = this.game.cauldron.y - 55;
        const to = { x, y };
        const distance = getDistance(piece.x, piece.y, x, y);
        gsap.killTweensOf(piece);
        gsap.killTweensOf(piece.scale);
        const duration = distance * 0.001 + randomRange(0.2, 0.8);

        gsap.to(piece, {
            x: to.x,
            duration: duration,
            ease: easeJumpToCauldronX,
        });

        gsap.to(piece, {
            y: to.y,
            duration: duration,
            ease: easeJumpToCauldronY,
        });

        await gsap.to(piece.scale, {
            x: 0.5,
            y: 0.5,
            duration: duration,
            ease: easeJumpToCauldronScale,
        });

        // Play cauldron splash
        sfx.play('common/sfx-bubble.wav');
        this.game.cauldron.playSplash(to.x - this.game.cauldron.x);
    }

    /** Play a short explosion effect in given position */
    private async playPopExplosion(position: { x: number; y: number }) {
        const explosion = pool.get(PopExplosion);
        explosion.x = position.x;
        explosion.y = position.y;
        this.addChild(explosion);
        await explosion.play();
        this.removeChild(explosion);
        pool.giveBack(explosion);
    }

    /** Explode piece out of the board, part of the play grid explosion animation */
    private async playPieceExplosion(piece: Match3Piece) {
        const position = this.toLocal(piece.getGlobalPosition());
        const x = position.x + piece.x * 2 + randomRange(-100, 100);
        const yUp = position.y + randomRange(-100, -200);
        const yDown = yUp + 600;
        const animatedPiece = pool.get(Match3Piece);
        const duration = randomRange(0.5, 0.8);
        gsap.killTweensOf(animatedPiece);
        gsap.killTweensOf(animatedPiece.scale);
        animatedPiece.setup({
            name: piece.name,
            type: piece.type,
            size: this.game.match3.board.tileSize,
            interactive: false,
        });
        animatedPiece.position.copyFrom(position);
        animatedPiece.alpha = 1;
        this.addChild(animatedPiece);
        await waitFor(randomRange(0, 0.3));
        throttle('pieceExplosion', 100, () => sfx.play('common/sfx-incorrect.wav', { volume: 0.5 }));
        this.playPopExplosion(position);
        const upTime = duration * 0.4;
        const downTime = duration * 0.6;
        gsap.to(animatedPiece, { y: yUp, duration: upTime, ease: 'circ.out' });
        gsap.to(animatedPiece, { y: yDown, duration: downTime, ease: 'circ.in', delay: upTime });
        gsap.to(animatedPiece, { alpha: 0, duration: 0.2, ease: 'linear', delay: duration - 0.2 });
        gsap.to(animatedPiece.scale, { x: 2, y: 2, duration, ease: 'linear' });
        await gsap.to(animatedPiece, { x, duration, ease: 'linear' });
        this.removeChild(animatedPiece);
        pool.giveBack(piece);
    }

    /** Explode all pieces out of the board, when gameplay finishes */
    public async playGridExplosion() {
        earthquake(this.game.pivot, 10);
        const animPromises: Promise<void>[] = [];
        this.game.match3.board.pieces.forEach((piece) => {
            animPromises.push(this.playPieceExplosion(piece));
        });
        this.game.match3.board.piecesContainer.visible = false;
        await Promise.all(animPromises);
    }
}
