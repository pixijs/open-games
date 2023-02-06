import { Match3 } from '../Match3';
import { match3ForEach, Match3Position, Match3Type } from '../Match3Utility';

export class Match3SpecialColour {
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
            if (match.length < 5) continue;
            const middle = Math.floor(match.length / 2);
            const middlePosition = match[middle];
            await this.match3.board.popPieces(match);
            await this.match3.board.spawnPiece(middlePosition, this.pieceType);
        }
    }

    public async trigger(pieceType: Match3Type) {
        if (pieceType !== this.pieceType) return;

        // Find out which piece type has most positions in the grid
        const numPiecesPerType: Record<number, number> = {};
        let selectedType = 0;
        let selectedTypeCount = 0;
        match3ForEach(this.match3.board.grid, (_, type) => {
            if (!this.match3.board.commonTypes.includes(type)) return;
            if (!numPiecesPerType[type]) numPiecesPerType[type] = 0;
            numPiecesPerType[type] += 1;
            if (numPiecesPerType[type] >= selectedTypeCount) {
                selectedTypeCount = numPiecesPerType[type];
                selectedType = type;
            }
        });

        // Find out all positions of the selected type
        const positions: Match3Position[] = [];
        match3ForEach(this.match3.board.grid, (position, type) => {
            if (type === selectedType) {
                positions.push(position);
            }
        });

        // Pop out all positions found
        await this.match3.board.popPieces(positions, true);
    }
}
