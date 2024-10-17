import { Match3 } from '../Match3';
import { Match3Position, Match3Type } from '../Match3Utility';

/**
 * Process a match list to find out horizontal matches 4 pieces long, then spawns the Column Blast piece in the middle.
 * Trigger the column blast special, popping out all pieces in its column.
 */
export class Match3SpecialColumn {
    /** The Match3 instance */
    public readonly match3: Match3;
    /** The piece type designed for this special */
    public readonly pieceType: Match3Type;

    constructor(match3: Match3, pieceType: Match3Type) {
        this.match3 = match3;
        this.pieceType = pieceType;
    }

    /**
     * Process a match list to find out horizontal matches 4 pieces long, then spawns the Column Blast piece in the middle.
     * @param matches Match list to be processed
     */
    public async process(matches: Match3Position[][]) {
        let i = matches.length;
        while (i--) {
            const match = matches[i];
            if (match.length != 4) continue;
            if (match[0].row === match[1].row) {
                const middle = Math.floor(match.length / 2);
                const middlePosition = match[middle];
                await this.match3.board.popPieces(match);
                await this.match3.board.spawnPiece(middlePosition, this.pieceType);
            }
        }
    }

    /**
     * Check piece type and trigger the column blast special, popping out all pieces in its column.
     * @param pieceType Piece type to be evaluated - the type must match for actually triggering the special
     * @param position The grid position (row & column) that is the origin of the special
     */
    public async trigger(pieceType: Match3Type, position: Match3Position) {
        // Ignore if provided piece type does not match this special type
        if (pieceType !== this.pieceType) return;

        const rows = this.match3.board.rows;
        const list: Match3Position[] = [];
        for (let i = 0; i < rows; i++) {
            list.push({ row: i, column: position.column });
        }
        await this.match3.board.popPieces(list, true);
    }
}
