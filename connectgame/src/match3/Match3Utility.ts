/** Piece type on each position in the grid */
export type Match3Type = number;

/** Two-dimensional array represeinting the game board */
export type Match3Grid = Match3Type[][];

/** Pair of row & column representing grid coordinates */
export type Match3Position = { row: number; column: number };

/** Orientation for match checks */
export type Match3Orientation = 'horizontal' | 'vertical';

/**
 * Create a 2D grid matrix filled up with given types
 * Example:
 * [[1, 1, 2, 3]
 *  [3, 1, 1, 3]
 *  [1, 2, 3, 2]
 *  [2, 3, 1, 3]]
 * @param rows Number of rows
 * @param columns Number of columns
 * @param types List of types avaliable to fill up slots
 * @returns A 2D array filled up with types
 */
export function match3CreateGrid(rows = 6, columns = 6, types: Match3Type[]) {
    const grid: Match3Grid = [];

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < columns; c++) {
            let type = match3GetRandomType(types);

            // List of rejected types for this position, to prevent them to be picked again
            const excludeList: Match3Type[] = [];

            // If the new type match previous types, randomise it again, excluding rejected type
            // to avoid building the grid with pre-made matches
            while (matchPreviousTypes(grid, { row: r, column: c }, type)) {
                excludeList.push(type);
                type = match3GetRandomType(types, excludeList);
            }

            // Create the new row if not exists
            if (!grid[r]) grid[r] = [];

            // Set type for the grid position
            grid[r][c] = type;
        }
    }

    return grid as Match3Grid;
}

/**
 * Create a copy of provided grid
 * @param grid The grid to be cloned
 * @returns A copy of the original grid
 */
export function match3CloneGrid(grid: Match3Grid) {
    const clone: Match3Grid = [];
    for (const row of grid) {
        clone.push(row.slice());
    }
    return clone;
}

/** Check if given type match previous positions in the grid  */
function matchPreviousTypes(grid: Match3Grid, position: Match3Position, type: Match3Type) {
    // Check if previous horizontal positions are forming a match
    const horizontal1 = grid?.[position.row]?.[position.column - 1];
    const horizontal2 = grid?.[position.row]?.[position.column - 2];
    const horizontalMatch = type === horizontal1 && type === horizontal2;

    // Check if previous vertical positions are forming a match
    const vertical1 = grid?.[position.row - 1]?.[position.column];
    const vertical2 = grid?.[position.row - 2]?.[position.column];
    const verticalMatch = type === vertical1 && type === vertical2;

    // Return if either horizontal or vertical psoitions are forming a match
    return horizontalMatch || verticalMatch;
}

/**
 * Get a random type from the type list
 * @param types List of types available to return
 * @param exclude List of types to be excluded from the result
 * @returns A random type picked from the given list
 */
export function match3GetRandomType(types: Match3Type[], exclude?: Match3Type[]) {
    let list = [...types];

    if (exclude) {
        // If exclude list is provided, exclude them from the available list
        list = types.filter((type) => !exclude.includes(type));
    }

    const index = Math.floor(Math.random() * list.length);

    return list[index];
}

/**
 * Swap two pieces in the grid, based on their positions
 * @param grid The grid to be changed
 * @param positionA The first piece to swap
 * @param positionB The second piece to swap
 */
export function match3SwapPieces(grid: Match3Grid, positionA: Match3Position, positionB: Match3Position) {
    const typeA = match3GetPieceType(grid, positionA);
    const typeB = match3GetPieceType(grid, positionB);

    // Only swap pieces if both types are valid (not undefined)
    if (typeA !== undefined && typeB !== undefined) {
        match3SetPieceType(grid, positionA, typeB);
        match3SetPieceType(grid, positionB, typeA);
    }
}

/**
 * Set the piece type in the grid, by position
 * @param grid The grid to be changed
 * @param position The position to be changed
 * @param type The new type for given position
 */
export function match3SetPieceType(grid: Match3Grid, position: Match3Position, type: number) {
    grid[position.row][position.column] = type;
}

/**
 * Retrieve the piece type from a grid, by position
 * @param grid The grid to be looked up
 * @param position The position in the grid
 * @returns The piece type from given position, undefined if position is invalid
 */
export function match3GetPieceType(grid: Match3Grid, position: Match3Position) {
    return grid?.[position.row]?.[position.column];
}

/**
 * Check if a position is valid in the grid
 * @param grid The grid in context
 * @param position The position to be validated
 * @returns True if position exists in the grid, false if out-of-bounds
 */
export function match3IsValidPosition(grid: Match3Grid, position: Match3Position) {
    const rows = grid.length;
    const cols = grid[0].length;
    return position.row >= 0 && position.row < rows && position.column >= 0 && position.column < cols;
}

/**
 * Loop through every position in the grid
 * @param grid The grid in context
 * @param fn Callback for each position in the grid
 */
export function match3ForEach(grid: Match3Grid, fn: (position: Match3Position, type: Match3Type) => void) {
    for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r].length; c++) {
            fn({ row: r, column: c }, grid[r][c]);
        }
    }
}

/**
 * Retrieve a list of matches found in a singe orientation (horizontal or vertical)
 * @param grid The grid to be searched
 * @param matchSize The size of the match (usually 3)
 * @param orientation If the search is horizontal or vertical
 * @returns
 */
function match3GetMatchesByOrientation(grid: Match3Grid, matchSize: number, orientation: Match3Orientation) {
    const matches = [];
    const rows = grid.length;
    const columns = grid[0].length;
    let lastType = undefined;
    let currentMatch: Match3Position[] = [];

    // Define primary and secondary orientations for the loop
    const primary = orientation === 'horizontal' ? rows : columns;
    const secondary = orientation === 'horizontal' ? columns : rows;

    for (let p = 0; p < primary; p++) {
        for (let s = 0; s < secondary; s++) {
            // On horizontal 'p' is row and 's' is column, vertical is opposite
            const row = orientation === 'horizontal' ? p : s;
            const column = orientation === 'horizontal' ? s : p;
            const type = grid[row][column];

            if (type && type === lastType) {
                // Type is the same as the last type, append to the match list
                currentMatch.push({ row, column });
            } else {
                // Type is different from last - check current match length and append it to the results if suitable
                if (currentMatch.length >= matchSize) {
                    matches.push(currentMatch);
                }
                // Start a new match
                currentMatch = [{ row, column }];
                // Save last type to check in the next pass
                lastType = type;
            }
        }

        // Row (or column) finished. Append current match if suitable
        if (currentMatch.length >= matchSize) {
            matches.push(currentMatch);
        }

        // Cleanup before mmoving to the next row (or column)
        lastType = undefined;
        currentMatch = [];
    }

    return matches;
}

/**
 * Check if two positions are the same
 * @param a First position to compare
 * @param b Second position to compare
 * @returns True if position A row & column are the same of position B
 */
export function match3ComparePositions(a: Match3Position, b: Match3Position) {
    return a.row === b.row && a.column == b.column;
}

/**
 * Check if list of positions includes given position
 * @param positions List of positions to check
 * @param position The position to be checked
 * @returns True if position list contains the provided position, false otherwise
 */
export function match3IncludesPosition(positions: Match3Position[], position: Match3Position) {
    for (const p of positions) {
        if (match3ComparePositions(p, position)) return true;
    }
    return false;
}

/**
 * Get all matches in the grid, optionally filtering results that involves given positions
 * Example:
 * [[{row: 1, column: 1}, {row: 1, column: 2}, {row: 1, column: 3}]
 *  [{row: 1, column: 1}, {row: 2, column: 1}, {row: 2, column: 1}]]
 * @param grid The grid to be analysed
 * @param filter Optional list of positions that every match should have
 * @param matchSize The length of the match, defaults to 3
 * @returns A list of positions grouped by match, excluding ones not involving filter positions if provided
 */
export function match3GetMatches(grid: Match3Grid, filter?: Match3Position[], matchSize = 3) {
    const allMatches = [
        ...match3GetMatchesByOrientation(grid, matchSize, 'horizontal'),
        ...match3GetMatchesByOrientation(grid, matchSize, 'vertical'),
    ];

    if (!filter) {
        // Return all matches found if filter is not provided
        return allMatches;
    }

    // List of matches that involves positions in the provided filter
    const filteredMatches = [];

    for (const match of allMatches) {
        let valid = false;
        for (const position of match) {
            // Compare each position of the match to see if includes one of the filter positions
            for (const filterPosition of filter) {
                const same = match3ComparePositions(position, filterPosition);
                if (same) valid = true;
            }
        }

        if (valid) {
            // If match is valid (contains one of the filter positions), append that to the filtered list
            filteredMatches.push(match);
        }
    }

    return filteredMatches;
}

/**
 * Move all pieces in the grid to their next empty position, vertically
 * @param grid The grid to be changed
 * @returns All position that have been changed.
 * Ex.: [[{row: 1, column: 1}, {row: 2, column: 1}]] - That piece moved 1 row down
 */
export function match3ApplyGravity(grid: Match3Grid) {
    const rows = grid.length;
    const columns = grid[0].length;
    const changes: Match3Position[][] = [];
    for (let r = rows - 1; r >= 0; r--) {
        for (let c = 0; c < columns; c++) {
            let position = { row: r, column: c };
            const belowPosition = { row: r + 1, column: c };
            let hasChanged = false;

            // Skip this one if position below is out of bounds
            if (!match3IsValidPosition(grid, belowPosition)) continue;

            // Retrive ethe type of the position below
            let belowType = match3GetPieceType(grid, belowPosition);

            // Keep moving the piece down if position below is valid and empty
            while (match3IsValidPosition(grid, belowPosition) && belowType === 0) {
                hasChanged = true;
                match3SwapPieces(grid, position, belowPosition);
                position = { ...belowPosition };
                belowPosition.row += 1;
                belowType = match3GetPieceType(grid, belowPosition);
            }

            if (hasChanged) {
                // Append a new change if position has changed [<from>, <to>]
                changes.push([{ row: r, column: c }, position]);
            }
        }
    }

    return changes;
}

/**
 * Find out all empty spaces (type=0) in the grid
 * @param grid The grid to be verified
 * @returns A list of empty positions
 */
export function match3GetEmptyPositions(grid: Match3Grid) {
    const positions: Match3Position[] = [];
    const rows = grid.length;
    const columns = grid[0].length;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < columns; c++) {
            if (!grid[r][c]) {
                positions.push({ row: r, column: c });
            }
        }
    }
    return positions;
}

/**
 * Convert grid to a visual string representation, useful for debugging
 * @param grid The grid to be converted
 * @returns String representing the grid
 */
export function match3GridToString(grid: Match3Grid) {
    const lines: string[] = [];
    for (const row of grid) {
        const list = row.map((type) => String(type).padStart(2, '0'));
        lines.push('|' + list.join('|') + '|');
    }
    return lines.join('\n');
}

/**
 * Loop through the grid and fill up all empty positions with random types
 * @param grid The grid to be changed
 * @param types List of types available to randomise
 * @returns A list with all positions that have their types changed from empty (0) to something
 */
export function match3FillUp(grid: Match3Grid, types: Match3Type[]) {
    // Create a temp grid that will provide pieces to fill up corresponding slots
    // using the same grid creation algorithm to avoid pre-made combinations
    const tempGrid = match3CreateGrid(grid.length, grid[0].length, types);

    const rows = grid.length;
    const columns = grid[0].length;
    const newPositions: Match3Position[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < columns; c++) {
            if (!grid[r][c]) {
                grid[r][c] = tempGrid[r][c];
                newPositions.push({ row: r, column: c });
            }
        }
    }

    return newPositions.reverse();
}

/**
 * Filter out repeated positions from position list
 * @param positions List of positions to be filtered
 * @returns A new list without repeated positions
 */
export function match3FilterUniquePositions(positions: Match3Position[]) {
    const result: Match3Position[] = [];
    const register: string[] = [];

    for (const position of positions) {
        const id = position.row + ':' + position.column;
        if (!register.includes(id)) {
            register.push(id);
            result.push(position);
        }
    }

    return result;
}

/**
 * Convert a grid position to string, useful for mapping values
 * @param position The position to be stringified
 * @returns A string representation of the position. Ex.: {row: 3, column: 1} => "3:1"
 */
export function match3PositionToString(position: Match3Position) {
    return position.row + ':' + position.column;
}

/**
 * Convert back a string to grid position
 * @param str The string to be converted to a grid position
 * @returns A position object. Ex.: "3:1" => {row: 3, column: 1}
 */
export function match3StringToPosition(str: string) {
    const split = str.split(':');
    return { row: Number(split[0]), column: Number(split[1]) };
}
