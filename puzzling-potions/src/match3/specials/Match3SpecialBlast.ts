import { Match3 } from '../Match3';
import {
    match3IncludesPosition,
    Match3Position,
    match3PositionToString,
    match3StringToPosition,
    Match3Type,
} from '../Match3Utility';

export class Match3SpecialBlast {
    public readonly match3: Match3;
    public readonly pieceType: Match3Type;

    constructor(match3: Match3, pieceType: Match3Type) {
        this.match3 = match3;
        this.pieceType = pieceType;
    }

    public async process(matches: Match3Position[][]) {
        const allPositions: Match3Position[] = [];
        const repeatedPositions: Match3Position[] = [];
        const matchesPerPosition: Record<string, Match3Position[][]> = {};
        const animPromises = [];

        // List all positions in all matches
        for (const match of matches) {
            for (const position of match) {
                allPositions.push({ ...position });
            }
        }

        // Map matches per position
        for (const position of allPositions) {
            const posStr = match3PositionToString(position);
            if (!matchesPerPosition[posStr]) {
                matchesPerPosition[posStr] = [];
            }
            for (const match of matches) {
                if (match3IncludesPosition(match, position)) {
                    matchesPerPosition[posStr].push(match);
                }
            }
        }

        // Find out matches with repeated positions (crossed matches)
        for (let posStr in matchesPerPosition) {
            // Ignore matches without repeated positions
            if (matchesPerPosition[posStr].length < 2) continue;

            // Save positions with multiple matches to spawn special pieces later
            repeatedPositions.push(match3StringToPosition(posStr));

            // Clear matches related to this position
            for (const match of matchesPerPosition[posStr]) {
                animPromises.push(this.match3.board.popPieces(match));
            }
        }

        await Promise.all(animPromises);

        // Spawn specials on rpeated positions
        for (const position of repeatedPositions) {
            await this.match3.board.spawnPiece(position, this.pieceType);
        }
    }

    public async trigger(pieceType: Match3Type, position: Match3Position) {
        if (pieceType !== this.pieceType) return;
        const list = [
            { row: position.row - 2, column: position.column },
            { row: position.row - 1, column: position.column - 1 },
            { row: position.row - 1, column: position.column },
            { row: position.row - 1, column: position.column + 1 },
            { row: position.row, column: position.column - 2 },
            { row: position.row, column: position.column - 1 },
            { row: position.row, column: position.column + 1 },
            { row: position.row, column: position.column + 2 },
            { row: position.row + 1, column: position.column - 1 },
            { row: position.row + 1, column: position.column },
            { row: position.row + 1, column: position.column + 1 },
            { row: position.row + 2, column: position.column },
        ];
        await this.match3.board.popPieces(list, true);
    }
}
