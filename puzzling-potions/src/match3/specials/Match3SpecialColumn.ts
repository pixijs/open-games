import { Match3 } from '../Match3';
import { Match3Position, Match3Type } from '../Match3Utility';

export class Match3SpecialColumn {
    public readonly match3: Match3;
    public readonly pieceType: Match3Type;

    constructor(match3: Match3, pieceType: Match3Type) {
        this.match3 = match3;
        this.pieceType = pieceType;
    }

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

    public async trigger(pieceType: Match3Type, position: Match3Position) {
        if (pieceType !== this.pieceType) return;
        const rows = this.match3.board.rows;
        const list: Match3Position[] = [];
        for (let i = 0; i < rows; i++) {
            list.push({ row: i, column: position.column });
        }
        await this.match3.board.popPieces(list, true);
    }
}
