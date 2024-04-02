import { PointData } from 'pixi.js';

/**
 * Find the magnitude of a point.
 * @param point - The point to measure.
 * @returns The magnitude of the point.
 */
export function magnitude(point: PointData): number {
    return Math.sqrt(point.x * point.x + point.y * point.y);
}

/**
 * Find the distance between two points.
 * @param point1 - First point.
 * @param point2 - Second point.
 * @returns The distance between the two points.
 */
export function distance(point1: PointData, point2: PointData): number {
    return magnitude({ x: point1.x - point2.x, y: point1.y - point2.y });
}

/**
 * Scale a point.
 * @param point - The point to scale.
 * @param scale - The scale factor.
 * @returns The scaled point.
 */
export function scale(point: PointData, scale: number): PointData {
    return { x: point.x * scale, y: point.y * scale };
}
/**
 * Normalize a point.
 * @param point - The point to normalize.
 * @returns The normalized point.
 */
export function normalize(point: PointData): PointData {
    const mag = magnitude(point);

    return scale(point, 1 / mag);
}

/**
 * Add two points.
 * @param point1 - First point.
 * @param point2 - Second point.
 * @returns The sum of the two points.
 */
export function add(point1: PointData, point2: PointData): PointData {
    return { x: point1.x + point2.x, y: point1.y + point2.y };
}

/**
 * Subtract one point from another.
 * @param point1 - First point.
 * @param point2 - Second point.
 * @returns The difference between the two points.
 */
export function sub(point1: PointData, point2: PointData): PointData {
    return { x: point1.x - point2.x, y: point1.y - point2.y };
}

/**
 * Calculate the dot product of two points.
 * @param point1 - First point.
 * @param point2 - Second point.
 * @returns The dot product of the two points.
 */
export function dot(point1: PointData, point2: PointData): number {
    return point1.x * point2.x + point1.y * point2.y;
}

/**
 * Converts a 2D point to its corresponding angle in radians.
 * @param point - The point to convert to an angle
 * @returns The angle in radians of the point.
 */
export function pointToAngle(point: PointData): number {
    return Math.atan2(point.y, point.x);
}

/**
 * Converts an angle in radians to a 2D point.
 * @param angle - The angle in radians to convert to a point.
 * @returns The 2D point representation of the angle.
 */
export function angleToPoint(angle: number): PointData {
    return { x: Math.cos(angle), y: Math.sin(angle) };
}

/**
 * Creates a 2D point.
 * @param x - The x-coordinate of the point. Default is `0`.
 * @param y - The y-coordinate of the point. Default is `0`.
 * @returns The 2D point with the specified x and y coordinates.
 */
export function point(x = 0, y = 0): PointData {
    return { x, y };
}
