import { Match3 } from '../Match3';
import { Match3Position, Match3Type } from '../Match3Utility';

/**
 * Process a match list to find out vertical matches 4 pieces long, then spawns the Row Blast piece in the middle.
 * Trigger the row blast special, popping out all pieces in its row.
 */
export class Match3SpecialRow {
    /** The Match3 instance */
    public readonly match3: Match3;
    /** The piece type designed for this special */
    public readonly pieceType: Match3Type;

    constructor(match3: Match3, pieceType: Match3Type) {
        this.match3 = match3;
        this.pieceType = pieceType;
    }

    /**
     * Process a match list to find out vertical matches 4 pieces long, then spawns the Row Blast piece in the middle.
     * @param matches Match list to be processed
     */
    public async process(matches: Match3Position[][]) {
        let i = matches.length;
        while (i--) {
            const match = matches[i];
            if (match.length != 4) continue;
            if (match[0].column === match[1].column) {
                const middle = Math.floor(match.length / 2);
                const middlePosition = match[middle];
                await this.match3.board.popPieces(match);
                await this.match3.board.spawnPiece(middlePosition, this.pieceType);
            }
        }
    }

    /**
     * Check piece type and trigger the row blast special, popping out all pieces in its row.
     * @param pieceType Piece type to be evaluated - the type must match for actually triggering the special
     * @param position The grid position (row & column) that is the origin of the special
     */
    public async trigger(pieceType: Match3Type, position: Match3Position) {
        // Ignore if provided piece type does not match this special type
        if (pieceType !== this.pieceType) return;

        const columns = this.match3.board.columns;
        const list: Match3Position[] = [];
        for (let i = 0; i < columns; i++) {
            list.push({ row: position.row, column: i });
        }
        await this.match3.board.popPieces(list, true);
    }
}
