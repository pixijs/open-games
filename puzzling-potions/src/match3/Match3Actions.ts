import { Match3 } from './Match3';
import { Match3Piece } from './Match3Piece';
import {
    Match3Position,
    match3GetPieceType,
    match3CloneGrid,
    match3SwapPieces,
    match3GetMatches,
} from './Match3Utility';

/** Interface for actions configuration */
interface Match3ActionsConfig {
    freeMoves: boolean;
}

/**
 * These are the actions player can take: move pieces (swap) or tap if they are special.
 * Action effects happens instantly, and the game will deal with whatever state the grid ends up with.
 */
export class Match3Actions {
    /** The match3 instance */
    public match3: Match3;

    /** Free all moves, meaning that they will always be valid regardles of matching results */
    public freeMoves = false;

    constructor(match3: Match3) {
        this.match3 = match3;
    }

    /**
     * Set up actions with given configuration
     * @param config Actions config params
     */
    public setup(config: Match3ActionsConfig) {
        this.freeMoves = config.freeMoves;
    }

    /**
     * Basic move action that swap two pieces in the grid. Can be disallowed and reverted if
     * the move does not involve special pieces neither create any new matches, unless free moves
     * is enabled.
     * @param from The origin grid position of the move
     * @param to The destination grid position of the move
     */
    public async actionMove(from: Match3Position, to: Match3Position) {
        if (!this.match3.isPlaying()) return;

        // Check if there are pieces on each of the 2 positions, and if they are not locked
        const pieceA = this.match3.board.getPieceByPosition(from);
        const pieceB = this.match3.board.getPieceByPosition(to);
        if (!pieceA || !pieceB || pieceA.isLocked() || pieceB.isLocked()) return;

        // Check the grid types currently involved in the move
        const typeA = this.match3.board.getTypeByPosition(from);
        const typeB = this.match3.board.getTypeByPosition(to);
        if (!typeA || !typeB) return;

        // Execute the pieces swap - might be reverted if invalid
        console.log('[Match3] ACTION! Move:', from, 'to:', to);
        await this.swapPieces(pieceA, pieceB);
        this.match3.process.start();
    }

    /**
     * Tap action only allowed for special pieces, triggering their effects in place
     * @param position The grid position of the action
     */
    public async actionTap(position: Match3Position) {
        if (!this.match3.isPlaying()) return;

        // Check the piece and type in the touched grid position
        const piece = this.match3.board.getPieceByPosition(position);
        const type = this.match3.board.getTypeByPosition(position);
        if (!piece || !this.match3.special.isSpecial(type) || piece.isLocked()) return;

        // Execute the tap action, popping the piece out which will trigger its special effects
        console.log('[Match3] ACTION! Tap:', position);
        await this.match3.board.popPiece(piece);
        this.match3.process.start();
    }

    /** Check if a move from origin to destination is valid */
    private validateMove(from: Match3Position, to: Match3Position) {
        // If free moves is on, all moves are valid
        if (this.freeMoves) return true;

        const type = match3GetPieceType(this.match3.board.grid, from);
        const specialFrom = this.match3.special.isSpecial(type);
        const specialTo = this.match3.special.isSpecial(match3GetPieceType(this.match3.board.grid, to));

        // Always allow move that either or both are special pieces
        if (specialFrom || specialTo) return true;

        // Clone current grid so we can manipulate it safely
        const tempGrid = match3CloneGrid(this.match3.board.grid);

        // Swap pieces in the temporary cloned grid
        match3SwapPieces(tempGrid, from, to);

        // Get all matches created by this move in the temporary grid
        const newMatches = match3GetMatches(tempGrid, [from, to]);

        // Only validate moves that creates new matches
        return newMatches.length >= 1;
    }

    /** Attempt to swap two pieces positions in the board, and revert the movement if disallowed */
    private async swapPieces(pieceA: Match3Piece, pieceB: Match3Piece) {
        // Get grid positions from pieces
        const positionA = pieceA.getGridPosition();
        const positionB = pieceB.getGridPosition();
        console.log('[Match3] Swap', positionA, positionB);

        // Find out view positions based on grid positions
        const viewPositionA = this.match3.board.getViewPositionByGridPosition(positionA);
        const viewPositionB = this.match3.board.getViewPositionByGridPosition(positionB);

        // Validate move if that creates any matches or if free moves is enabled
        const valid = this.validateMove(positionA, positionB);

        // Fire the callback, even if the move is invalid
        this.match3.onMove?.({
            from: positionA,
            to: positionB,
            valid,
        });

        if (valid) {
            // If move is valid, swap types in the grid and update view coordinates
            match3SwapPieces(this.match3.board.grid, positionA, positionB);
            pieceA.row = positionB.row;
            pieceA.column = positionB.column;
            pieceB.row = positionA.row;
            pieceB.column = positionA.column;
        }

        // Animate pieces to their new positions
        this.match3.board.bringToFront(pieceA);
        await Promise.all([
            pieceA.animateSwap(viewPositionB.x, viewPositionB.y),
            pieceB.animateSwap(viewPositionA.x, viewPositionA.y),
        ]);

        if (!valid) {
            // Revert pieces to their original position if move is not valid
            const viewPositionA = this.match3.board.getViewPositionByGridPosition(positionA);
            const viewPositionB = this.match3.board.getViewPositionByGridPosition(positionB);
            this.match3.board.bringToFront(pieceB);
            await Promise.all([
                pieceA.animateSwap(viewPositionA.x, viewPositionA.y),
                pieceB.animateSwap(viewPositionB.x, viewPositionB.y),
            ]);
        } else if (this.match3.special.isSpecial(match3GetPieceType(this.match3.board.grid, positionA))) {
            // Pop piece A if is special
            await this.match3.board.popPiece(positionA);
        } else if (this.match3.special.isSpecial(match3GetPieceType(this.match3.board.grid, positionB))) {
            // Pop piece B if is special
            await this.match3.board.popPiece(positionB);
        }
    }
}
