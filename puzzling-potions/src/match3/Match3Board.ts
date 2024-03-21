import { Container, Graphics } from 'pixi.js';
import { pool } from '../utils/pool';
import { Match3 } from './Match3';
import { Match3Config, match3GetBlocks } from './Match3Config';
import { Match3Piece } from './Match3Piece';
import {
    Match3Position,
    match3SetPieceType,
    match3GetPieceType,
    match3CreateGrid,
    match3ForEach,
    Match3Grid,
    Match3Type,
} from './Match3Utility';

/**
 * Holds the grid state and control its visual representation, creating and removing pieces accordingly.
 * As a convention for this game, 'grid' is usually referring to the match3 state (array of types),
 * and 'board' is its visual representation with sprites.
 */
export class Match3Board {
    /** The Match3 instance */
    public match3: Match3;
    /** The grid state, with only numbers */
    public grid: Match3Grid = [];
    /** All piece sprites currently being used in the grid */
    public pieces: Match3Piece[] = [];
    /** Mask all pieces inside board dimensions */
    public piecesMask: Graphics;
    /** A container for the pieces sprites */
    public piecesContainer: Container;
    /** Number of rows in the boaard */
    public rows = 0;
    /** Number of columns in the boaard */
    public columns = 0;
    /** The size (width & height) of each board slot */
    public tileSize = 0;
    /** List of common types available for the game */
    public commonTypes: Match3Type[] = [];
    /** Map piece types to piece names */
    public typesMap!: Record<number, string>;

    constructor(match3: Match3) {
        this.match3 = match3;

        this.piecesContainer = new Container();
        this.match3.addChild(this.piecesContainer);

        this.piecesMask = new Graphics().rect(-2, -2, 4, 4).fill({ color: 0xff0000, alpha: 0.5 });
        this.match3.addChild(this.piecesMask);
        this.piecesContainer.mask = this.piecesMask;
    }

    /**
     * Setup the initial grid state and fill up the view with pieces
     * @param config Match3 config params
     */
    public setup(config: Match3Config) {
        this.rows = config.rows;
        this.columns = config.columns;
        this.tileSize = config.tileSize;
        this.piecesMask.width = this.getWidth();
        this.piecesMask.height = this.getHeight();
        this.piecesContainer.visible = true;

        // The list of blocks (including specials) that will be used in the game
        const blocks = match3GetBlocks(config.mode);

        this.typesMap = {};

        // Organise types and set up special handlers
        // Piece types will be defined according to their positions in the string array of blocks
        // Example: If 'piece-dragon' is the 2nd in the blocks list (blocks[1]), its type will be 2
        for (let i = 0; i < blocks.length; i++) {
            const name = blocks[i];
            const type = i + 1;
            // Add a special handler the block refers to a special piece, otherwise make it a common type
            if (this.match3.special.isSpecialAvailable(name)) {
                this.match3.special.addSpecialHandler(name, type);
            } else {
                this.commonTypes.push(type);
            }
            this.typesMap[type] = name;
        }

        // Create the initial grid state
        this.grid = match3CreateGrid(this.rows, this.columns, this.commonTypes);

        // Fill up the visual board with piece sprites
        match3ForEach(this.grid, (gridPosition: Match3Position, type: Match3Type) => {
            this.createPiece(gridPosition, type);
        });
    }

    /**
     * Dispose all pieces and clean up the board
     */
    public reset() {
        let i = this.pieces.length;
        while (i--) {
            const piece = this.pieces[i];
            this.disposePiece(piece);
        }
        this.pieces.length = 0;
    }

    /**
     * Create a new piece in an specific grid position
     * @param position The grid position where the new piece will be attached
     * @param type The type of the nre piece
     */
    public createPiece(position: Match3Position, pieceType: Match3Type) {
        const name = this.typesMap[pieceType];
        const piece = pool.get(Match3Piece);
        const viewPosition = this.getViewPositionByGridPosition(position);
        piece.onMove = (from, to) => this.match3.actions.actionMove(from, to);
        piece.onTap = (position) => this.match3.actions.actionTap(position);
        piece.setup({
            name,
            type: pieceType,
            size: this.match3.config.tileSize,
            interactive: true,
            highlight: this.match3.special.isSpecial(pieceType),
        });
        piece.row = position.row;
        piece.column = position.column;
        piece.x = viewPosition.x;
        piece.y = viewPosition.y;
        this.pieces.push(piece);
        this.piecesContainer.addChild(piece);
        return piece;
    }

    /**
     * Dispose a piece, remving it from the board
     * @param piece Piece to be removed
     */
    public disposePiece(piece: Match3Piece) {
        if (this.pieces.includes(piece)) {
            this.pieces.splice(this.pieces.indexOf(piece), 1);
        }
        if (piece.parent) {
            piece.parent.removeChild(piece);
        }
        pool.giveBack(piece);
    }

    /**
     * Spawn a new piece in the board, removing the piece in the same place, if there are any
     * @param position The position where the piece should be spawned
     * @param pieceType The type of the piece to be spawned
     */
    public async spawnPiece(position: Match3Position, pieceType: Match3Type) {
        const oldPiece = this.getPieceByPosition(position);
        if (oldPiece) this.disposePiece(oldPiece);
        match3SetPieceType(this.grid, position, pieceType);
        if (!pieceType) return;
        const piece = this.createPiece(position, pieceType);
        await piece.animateSpawn();
    }

    /**
     * Pop a piece out of the board, triggering its effects if it is a special piece
     * @param position The grid position of the piece to be popped out
     * @param causedBySpecial If the pop was caused by special effect
     */
    public async popPiece(position: Match3Position, causedBySpecial = false) {
        const piece = this.getPieceByPosition(position);
        const type = match3GetPieceType(this.grid, position);
        if (!type || !piece) return;
        const isSpecial = this.match3.special.isSpecial(type);
        const combo = this.match3.process.getProcessRound();

        // Set piece position in the grid to 0 and pop it out of the board
        match3SetPieceType(this.grid, position, 0);
        const popData = { piece, type, combo, isSpecial, causedBySpecial };
        this.match3.stats.registerPop(popData);
        this.match3.onPop?.(popData);
        if (this.pieces.includes(piece)) {
            this.pieces.splice(this.pieces.indexOf(piece), 1);
        }
        await piece.animatePop();
        this.disposePiece(piece);

        // Trigger any specials related to this piece, if there is any
        await this.match3.special.trigger(type, position);
    }

    /**
     * Pop a list of pieces all together
     * @param positions List of positions to be popped out
     * @param causedBySpecial If this was caused by special effects
     */
    public async popPieces(positions: Match3Position[], causedBySpecial = false) {
        const animPromises = [];
        for (const position of positions) {
            animPromises.push(this.popPiece(position, causedBySpecial));
        }
        await Promise.all(animPromises);
    }

    /**
     * Find a piece sprite by grid position
     * @param position The grid position to look for
     * @returns
     */
    public getPieceByPosition(position: Match3Position) {
        for (const piece of this.pieces) {
            if (piece.row === position.row && piece.column === position.column) {
                return piece;
            }
        }
        return null;
    }

    /**
     * Conver grid position (row & column) to view position (x & y)
     * @param position The grid position to be converted
     * @returns The equivalet x & y position in the board
     */
    public getViewPositionByGridPosition(position: Match3Position) {
        const offsetX = ((this.columns - 1) * this.tileSize) / 2;
        const offsetY = ((this.rows - 1) * this.tileSize) / 2;
        const x = position.column * this.tileSize - offsetX;
        const y = position.row * this.tileSize - offsetY;
        return { x, y };
    }

    /**
     * Find out the piece type in a grid position
     * @param position
     * @returns The type of the piece
     */
    public getTypeByPosition(position: Match3Position) {
        return match3GetPieceType(this.grid, position);
    }

    /** Get the visual width of the board */
    public getWidth() {
        return this.tileSize * this.columns;
    }

    /** Get the visual height of the board */
    public getHeight() {
        return this.tileSize * this.rows;
    }

    /** Pause all pieces animations */
    public pause() {
        for (const piece of this.pieces) piece.pause();
    }

    /** Resule all pieces animations */
    public resume() {
        for (const piece of this.pieces) piece.resume();
    }

    /** Bring a piece in front of all others */
    public bringToFront(piece: Match3Piece) {
        this.piecesContainer.addChild(piece);
    }
}
