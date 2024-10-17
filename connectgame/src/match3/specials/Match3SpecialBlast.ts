import { Match3 } from '../Match3';
import {
    match3IncludesPosition,
    Match3Position,
    match3PositionToString,
    match3StringToPosition,
    Match3Type,
} from '../Match3Utility';

/**
 * Process a match list to find out crossed matches, then spawns the Blast piece in crossing point.
 * Trigger the blast special, popping out surrounding pieces in a grid position.
 */
export class Match3SpecialBlast {
    /** The Match3 instance */
    public readonly match3: Match3;
    /** The piece type designed for this special */
    public readonly pieceType: Match3Type;

    constructor(match3: Match3, pieceType: Match3Type) {
        this.match3 = match3;
        this.pieceType = pieceType;
    }

    /**
     * Process a match list to find out crossed matches, then spawns the Blast piece in crossing point.
     * @param matches Match list to be processed
     */
    public async process(matches: Match3Position[][]) {
        const allPositions: Match3Position[] = [];
        const repeatedPositions: Match3Position[] = [];
        const matchesPerPosition: Record<string, Match3Position[][]> = {};
        const animPromises = [];

        /*
        Look for matches that crosses:
        ....|X|....
        ..|X|X|X|..
        ....|X|....
        Or:
        ..|X|X|X|..
        ....|X|....
        ....|X|....
        */

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
        for (const posStr in matchesPerPosition) {
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

    /**
     * Check piece type and trigger the blast special, popping out surrounding pieces in given grid position.
     * @param pieceType Piece type to be evaluated - the type must match for actually triggering the special
     * @param position The grid position (row & column) that is the origin of the special
     */
    public async trigger(pieceType: Match3Type, position: Match3Position) {
        // Ignore if provided piece type does not match this special type
        if (pieceType !== this.pieceType) return;

        /*
        Description of the explosion pattern:
        ....|X|....
        ..|X|X|X|..
        |X|X|X|X|X|
        ..|X|X|X|..
        ....|X|....
        */
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

        // Pop all pieces in the list
        await this.match3.board.popPieces(list, true);
    }
}
