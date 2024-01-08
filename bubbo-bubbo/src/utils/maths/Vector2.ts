/* eslint-disable @typescript-eslint/no-use-before-define */
/* eslint-disable no-use-before-define */

/**

Class representing a 2-dimensional vector.
*/
export class Vector2 {
    public x: number;
    public y: number;

    /**
     * Constructs a new Vector2 object.
     * @param x - X-coordinate of the vector. Defaults to `0`.
     * @param y - Y-coordinate of the vector. Defaults to `0`.
     */
    constructor(x?: number, y?: number) {
        this.x = x || 0;
        this.y = y || 0;
    }

    /**
     * Getter for the width of the vector.
     * @returns The x-coordinate of the vector.
     */
    public get width(): number {
        return this.x;
    }

    /**
     * Setter for the width of the vector.
     * @param value - The value to set the width to.
     */
    public set width(value: number) {
        this.x = value;
    }

    /**
     * Getter for the height of the vector.
     * @returns The y-coordinate of the vector.
     */
    public get height(): number {
        return this.y;
    }

    /**
     * Setter for the height of the vector.
     * @param value - The value to set the height to.
     */
    public set height(value: number) {
        this.y = value;
    }

    /**
     * Sets the x and y coordinates of the vector.
     * @param x - The x-coordinate to set.
     * @param y - The y-coordinate to set.
     * @returns The updated Vector2 object.
     */
    public set(x: number, y: number): this {
        this.x = x;
        this.y = y;

        return this;
    }

    /**
     * Sets the x and y coordinates of the vector to the same scalar value.
     * @param scalar - The scalar value to set.
     * @returns The updated Vector2 object.
     */
    public setScalar(scalar: number): this {
        this.x = scalar;
        this.y = scalar;

        return this;
    }

    /**
     * Sets the x-coordinate of the vector.
     * @param x - The x-coordinate to set.
     * @returns The updated Vector2 object.
     */
    public setX(x: number): this {
        this.x = x;

        return this;
    }

    /**
     * Sets the y-coordinate of the vector.
     * @param y - The y-coordinate to set.
     * @returns The updated Vector2 object.
     */
    public setY(y: number): this {
        this.y = y;

        return this;
    }

    /**
     * Creates a new instance of a vector and assigns it the x and y of the current vector.
     * @returns A new instance of a Vector2 with the current x and y values.
     */
    public clone(): Vector2 {
        return new Vector2(this.x, this.y);
    }

    /**
     * Copies the values of another vector to this vector.
     *
     * @param {Vector2} v - The vector to copy values from.
     * @returns {this} Returns this vector.
     */
    public copy(v: Vector2): this {
        this.x = v.x;
        this.y = v.y;

        return this;
    }

    /**
     * Adds another vector to this vector.
     *
     * @param {Vector2} v - The vector to add to this vector.
     * @returns {this} Returns this vector.
     */
    public add(v: Vector2): this {
        this.x += v.x;
        this.y += v.y;

        return this;
    }

    /**
     * Adds a scalar value to this vector.
     *
     * @param {number} s - The scalar value to add.
     * @returns {this} Returns this vector.
     */
    public addScalar(s: number): this {
        this.x += s;
        this.y += s;

        return this;
    }

    /**
     * Adds two vectors and stores the result in this vector.
     *
     * @param {Vector2} a - The first vector to add.
     * @param {Vector2} b - The second vector to add.
     * @returns {this} Returns this vector.
     */
    public addVectors(a: Vector2, b: Vector2): this {
        this.x = a.x + b.x;
        this.y = a.y + b.y;

        return this;
    }

    /**
     * Adds a scaled vector to this vector.
     *
     * @param {Vector2} v - The vector to scale and add.
     * @param {number} s - The scale factor.
     * @returns {this} Returns this vector.
     */
    public addScaledVector(v: Vector2, s: number): this {
        this.x += v.x * s;
        this.y += v.y * s;

        return this;
    }

    /**
     * Subtracts another vector from this vector.
     *
     * @param {Vector2} v - The vector to subtract from this vector.
     * @returns {this} Returns this vector.
     */
    public sub(v: Vector2): this {
        this.x -= v.x;
        this.y -= v.y;

        return this;
    }

    /**
     * Subtracts a scalar from the vector.
     * @param scalar - The scalar to subtract from the vector.
     * @returns The vector with the subtracted scalar.
     */
    public subScalar(scalar: number): this {
        this.x -= scalar;
        this.y -= scalar;

        return this;
    }

    /**
     * Subtracts two vectors and sets the current vector to the result.
     * @param a - The first vector.
     * @param b - The second vector.
     * @returns The current vector set to the result of the subtraction of `a` and `b`.
     */
    public subVectors(a: Vector2, b: Vector2): this {
        this.x = a.x - b.x;
        this.y = a.y - b.y;

        return this;
    }

    /**
     * Multiplies the current vector by another vector.
     * @param v - The vector to multiply by.
     * @returns The current vector multiplied by `v`.
     */
    public multiply(v: Vector2): this {
        this.x *= v.x;
        this.y *= v.y;

        return this;
    }

    /**
     * Multiplies the current vector by a scalar.
     * @param scalar - The scalar to multiply the vector by.
     * @returns The current vector multiplied by the scalar.
     */
    public multiplyScalar(scalar: number): this {
        this.x *= scalar;
        this.y *= scalar;

        return this;
    }

    /**
     * Divides the current vector by another vector.
     * @param v - The vector to divide by.
     * @returns The current vector divided by `v`.
     */
    public divide(v: Vector2): this {
        this.x /= v.x;
        this.y /= v.y;

        return this;
    }

    /**
     * Divides the current vector by a scalar.
     * @param scalar - The scalar to divide the vector by.
     * @returns The current vector divided by the scalar.
     */
    public divideScalar(scalar: number): this {
        return this.multiplyScalar(1 / scalar);
    }

    /**
     * Sets the current vector to the minimum values of itself and another vector.
     * @param v - The vector to compare to.
     * @returns The current vector set to the minimum values.
     */
    public min(v: Vector2): this {
        this.x = Math.min(this.x, v.x);
        this.y = Math.min(this.y, v.y);

        return this;
    }

    /**
     * Sets the current vector to the maximum values of itself and another vector.
     * @param v - The vector to compare to.
     * @returns The current vector set to the maximum values.
     */
    public max(v: Vector2): this {
        this.x = Math.max(this.x, v.x);
        this.y = Math.max(this.y, v.y);

        return this;
    }

    /**
     * Clamps the vector based on the given min and max vectors.
     * Always assumes min < max, component-wise
     * @param min - The minimum clamp.
     * @param max - The maximum clamp.
     * @return The current clamped vector.
     */
    public clamp(min: Vector2, max: Vector2): this {
        this.x = Math.max(min.x, Math.min(max.x, this.x));
        this.y = Math.max(min.y, Math.min(max.y, this.y));

        return this;
    }

    /**
     * Clamps the vector's components to a specified minimum and maximum value.
     * @param minVal - Minimum value to clamp to.
     * @param maxVal - Maximum value to clamp to.
     * @returns The current clamped vector.
     */
    public clampScalar(minVal: number, maxVal: number): this {
        min.set(minVal, minVal);
        max.set(maxVal, maxVal);

        return this.clamp(min, max);
    }

    /**
     * Clamps the vector's length to a specified minimum and maximum value.
     * @param min - Minimum value to clamp to.
     * @param max - Maximum value to clamp to.
     * @returns The current clamped vector.
     */
    public clampLength(min: number, max: number): this {
        const length = this.length();

        return this.divideScalar(length || 1).multiplyScalar(Math.max(min, Math.min(max, length)));
    }

    /**
     * Floors the vector's components to the nearest integer less than or equal to the value.
     * @returns The current floored vector.
     */
    public floor(): this {
        this.x = Math.floor(this.x);
        this.y = Math.floor(this.y);

        return this;
    }

    /**
     * Ceils the vector's components to the nearest integer greater than or equal to the value.
     * @returns The current ceiling-ed vector.
     */
    public ceil(): this {
        this.x = Math.ceil(this.x);
        this.y = Math.ceil(this.y);

        return this;
    }

    /**
     * Rounds the vector's components to the nearest integer.
     * @returns The current rounded vector.
     */
    public round(): this {
        this.x = Math.round(this.x);
        this.y = Math.round(this.y);

        return this;
    }

    /**
     * Rounds the vector's components towards zero.
     * @returns The current rounded vector.
     */
    public roundToZero(): this {
        this.x = this.x < 0 ? Math.ceil(this.x) : Math.floor(this.x);
        this.y = this.y < 0 ? Math.ceil(this.y) : Math.floor(this.y);

        return this;
    }

    /**
     * Negates the vector's components.
     * @returns The current negated vector.
     */
    public negate(): this {
        this.x = -this.x;
        this.y = -this.y;

        return this;
    }

    /**
     * Computes the dot product of the vector with another vector.
     * @param v - The vector being calculated against.
     * @returns The dot products between the given and current vectors
     */
    public dot(v: Vector2): number {
        return this.x * v.x + this.y * v.y;
    }

    /**
     * Computes the cross product of the vector with another vector.
     * @param v - The vector being calculated against.
     * @returns The cross products between the given and current vectors
     */
    public cross(v: Vector2): number {
        return this.x * v.y - this.y * v.x;
    }

    /**
     * Computes the square of the length of the vector.
     * @returns The squared length of the vector.
     */
    public lengthSq(): number {
        return this.x * this.x + this.y * this.y;
    }

    public length(): number {
        return Math.sqrt(this.x * this.x + this.y * this.y);
    }

    public manhattanLength(): number {
        return Math.abs(this.x) + Math.abs(this.y);
    }

    public normalize(): this {
        return this.divideScalar(this.length() || 1);
    }

    public angle(): number {
        // computes the angle in radians with respect to the positive x-axis

        let angle = Math.atan2(this.y, this.x);

        if (angle < 0) angle += 2 * Math.PI;

        return angle;
    }

    public distanceTo(v: Vector2): number {
        return Math.sqrt(this.distanceToSquared(v));
    }

    public distanceToSquared(v: Vector2): number {
        const dx = this.x - v.x;
        const dy = this.y - v.y;

        return dx * dx + dy * dy;
    }

    public manhattanDistanceTo(v: Vector2): number {
        return Math.abs(this.x - v.x) + Math.abs(this.y - v.y);
    }

    public setLength(length: number): this {
        return this.normalize().multiplyScalar(length);
    }

    public lerp(v: Vector2, alpha: number): this {
        this.x += (v.x - this.x) * alpha;
        this.y += (v.y - this.y) * alpha;

        return this;
    }

    public lerpVectors(v1: Vector2, v2: Vector2, alpha: number): this {
        return this.subVectors(v2, v1).multiplyScalar(alpha).add(v1);
    }

    public equals(v: Vector2): boolean {
        return v.x === this.x && v.y === this.y;
    }

    public fromArray(array: number[] | Float32Array, offset?: number): this {
        if (offset === undefined) offset = 0;

        this.x = array[offset];
        this.y = array[offset + 1];

        return this;
    }

    public toArray(array: number[] | Float32Array, offset?: number): number[] | Float32Array {
        if (array === undefined) array = [];
        if (offset === undefined) offset = 0;

        array[offset] = this.x;
        array[offset + 1] = this.y;

        return array;
    }

    public rotateAround(center: Vector2, angle: number): this {
        const c = Math.cos(angle);
        const s = Math.sin(angle);

        const x = this.x - center.x;
        const y = this.y - center.y;

        this.x = x * c - y * s + center.x;
        this.y = x * s + y * c + center.y;

        return this;
    }
}

const min = new Vector2();
const max = new Vector2();
