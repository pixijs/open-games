import { Match3 } from '../Match3';
import { Match3Position, Match3Type } from '../Match3Utility';

export class Match3SpecialRow {
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
            if (match[0].column === match[1].column) {
                const middle = Math.floor(match.length / 2);
                const middlePosition = match[middle];
                await this.match3.board.popPieces(match);
                await this.match3.board.spawnPiece(middlePosition, this.pieceType);
            }
        }
    }

    public async trigger(pieceType: Match3Type, position: Match3Position) {
        if (pieceType !== this.pieceType) return;
        const columns = this.match3.board.columns;
        const list: Match3Position[] = [];
        for (let i = 0; i < columns; i++) {
            list.push({ row: position.row, column: i });
        }
        await this.match3.board.popPieces(list, true);
    }
}
