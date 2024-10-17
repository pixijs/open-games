import { Container, Sprite } from 'pixi.js';

/**
 * The book shelf during gameplay, as background for match3 pieces. This can be dinamically
 * rescaled to any number of rows and columns, to match the game grid size.
 */
export class Shelf extends Container {
    /** Inner container for shelf bulding blocks */
    private base: Container;
    /** Inner container for shelf shadow blocks */
    private shadow: Container;

    constructor() {
        super();

        this.shadow = new Container();
        this.shadow.y = 8;
        this.addChild(this.shadow);

        this.base = new Container();
        this.addChild(this.base);
    }

    /** Rebuild the shelf based on given rows, columns and tile size */
    public setup(options: { rows: number; columns: number; tileSize: number }) {
        this.reset();

        const rows = options.rows;
        const columns = options.columns;
        const tileSize = options.tileSize;
        const sizeDiff = 0.5; // Covers a small gap between blocks depending on the resolution
        const offsetX = ((columns - 1) * tileSize) / 2;
        const offsetY = ((rows - 1) * tileSize) / 2;

        // Build shelf inner blocks
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < columns; c++) {
                const block = Sprite.from('shelf-block');
                const x = c * tileSize - offsetX;
                const y = r * tileSize - offsetY;
                block.anchor.set(0.5);
                block.width = tileSize + sizeDiff;
                block.height = tileSize + sizeDiff;
                block.x = x;
                block.y = y;
                this.base.addChild(block);
            }
        }

        // Build left side with corners and fill up with books
        for (let r = 0; r < rows; r++) {
            const c = -1;
            const texture = r === 0 || r === rows - 1 ? 'shelf-corner' : 'shelf-block';
            const block = Sprite.from(texture);
            const x = c * tileSize - offsetX;
            const y = r * tileSize - offsetY;
            block.anchor.set(0.5);
            block.width = tileSize + sizeDiff;
            block.height = tileSize + sizeDiff;
            block.x = x;
            block.y = y;
            this.base.addChild(block);
            if (r === rows - 1) {
                block.rotation = -Math.PI * 0.5;
            }
            const books = this.getBooks(r === rows - 1 ? 4 : r);
            books.scale.x = -(tileSize / books.width);
            books.height = tileSize;
            books.x = block.x;
            books.y = block.y;
            this.base.addChild(books);
        }

        // Build right side with corners and fill up with books
        for (let r = 0; r < rows; r++) {
            const c = columns;
            const texture = r === 0 || r === rows - 1 ? 'shelf-corner' : 'shelf-block';
            const block = Sprite.from(texture);
            const x = c * tileSize - offsetX;
            const y = r * tileSize - offsetY;
            block.anchor.set(0.5);
            block.width = tileSize + sizeDiff;
            block.height = tileSize + sizeDiff;
            block.x = x;
            block.y = y;
            this.base.addChild(block);
            if (r === 0) {
                block.rotation = Math.PI * 0.5;
            }
            if (r === rows - 1) {
                block.rotation = Math.PI;
            }

            const books = this.getBooks(r === rows - 1 ? 4 : r);
            books.width = tileSize;
            books.height = tileSize;
            books.x = block.x;
            books.y = block.y;
            this.base.addChild(books);
        }

        // Build bottom line as shadow
        for (let c = -1; c <= columns; c++) {
            const r = rows - 1;
            const texture = c === -1 || c === columns ? 'shelf-corner' : 'shelf-block';
            const block = Sprite.from(texture);
            const x = c * tileSize - offsetX;
            const y = r * tileSize - offsetY;
            block.anchor.set(0.5);
            block.width = tileSize;
            block.height = tileSize;
            block.x = x;
            block.y = y;
            block.tint = 0x000000;
            block.alpha = 0.3;
            this.shadow.addChild(block);
            if (c === -1) {
                block.rotation = -Math.PI * 0.5;
            }
            if (c === columns) {
                block.rotation = Math.PI;
            }
        }
    }

    /** Remove all building blocks and clear the shelf */
    public reset() {
        this.shadow.removeChildren();
        this.base.removeChildren();
    }

    /** Helper function for creating a book sprite */
    private getBooks(index: number) {
        const list = ['books-01', 'books-02', 'books-03', 'books-04', 'books-05'];
        const name = list[index % list.length];
        const books = Sprite.from(name);
        books.anchor.set(0.5);
        return books;
    }
}
