import type { Container3D } from '@pixi/3d';
import { FlatMaterial, Geometry3D, Mesh3D } from '@pixi/3d';
import { Buffer, BufferUsage } from 'pixi.js';

import { skipToneCurve } from '../toneCurve';
import { lightTrailBit } from './lightBits';

/**
 * Light-trail ribbons, all in one mesh and one draw call, rebuilt from scratch every frame.
 *
 * Each ribbon is a run of samples along a centreline, head first. Write every sample with {@link LightTrails.set},
 * then {@link LightTrails.upload} works out each sample's direction and sends the frame's ribbons to the GPU. The
 * shader turns each pair of vertices to face the camera, so the CPU never needs the camera. A sample with zero width
 * collapses its quads, which is how a ribbon is switched off.
 */
export class LightTrails {
  /** Samples per ribbon. */
  public readonly samples: number;

  private readonly _ribbons: number;
  private readonly _mesh: Mesh3D;
  private readonly _positions: Float32Array;
  private readonly _directions: Float32Array;
  private readonly _shape: Float32Array;
  private readonly _colors: Float32Array;
  private readonly _positionsBuffer: Buffer;
  private readonly _directionsBuffer: Buffer;
  private readonly _shapeBuffer: Buffer;
  private readonly _colorsBuffer: Buffer;

  /**
   * @param parent - Where the mesh goes; it must sit at the world origin, since samples are world positions.
   * @param ribbons - How many ribbons.
   * @param samples - Samples per ribbon, at least 2.
   */
  constructor(parent: Container3D, ribbons: number, samples: number) {
    this.samples = samples;
    this._ribbons = ribbons;

    const vertices = ribbons * samples * 2;

    this._positions = new Float32Array(vertices * 3);
    this._directions = new Float32Array(vertices * 3);
    this._shape = new Float32Array(vertices * 2);
    this._colors = new Float32Array(vertices * 4);

    // The side of each vertex never changes; the half width beside it is written per frame.
    for (let v = 0; v < vertices; v++) this._shape[v * 2] = v % 2 === 0 ? -1 : 1;

    const indices = new Uint16Array(ribbons * (samples - 1) * 6);
    let i = 0;

    for (let r = 0; r < ribbons; r++) {
      for (let k = 0; k < samples - 1; k++) {
        const a = (r * samples + k) * 2;

        indices[i++] = a;
        indices[i++] = a + 1;
        indices[i++] = a + 2;
        indices[i++] = a + 1;
        indices[i++] = a + 3;
        indices[i++] = a + 2;
      }
    }

    this._positionsBuffer = vertexBuffer(this._positions, 'lightTrails-positions');
    this._directionsBuffer = vertexBuffer(this._directions, 'lightTrails-directions');
    this._shapeBuffer = vertexBuffer(this._shape, 'lightTrails-shape');
    this._colorsBuffer = vertexBuffer(this._colors, 'lightTrails-colors');

    const geometry = new Geometry3D({
      attributes: {
        aPosition: { buffer: this._positionsBuffer, format: 'float32x3', stride: 12, offset: 0 },
        aNormal: { buffer: this._directionsBuffer, format: 'float32x3', stride: 12, offset: 0 },
        aUV: { buffer: this._shapeBuffer, format: 'float32x2', stride: 8, offset: 0 },
        aColor: { buffer: this._colorsBuffer, format: 'float32x4', stride: 16, offset: 0 },
      },
      indices,
      dynamic: true,
    });

    const material = skipToneCurve(
      new FlatMaterial({
        alphaMode: 'blend',
        doubleSided: true,
        fog: false,
        extraBits: [lightTrailBit],
      }),
    );

    material.vertexColors = true;
    material.state.blendMode = 'add';

    this._mesh = new Mesh3D({ geometry, material, castShadow: false, receiveShadow: false });
    this._mesh.label = 'scene-light-trails';
    parent.addChild(this._mesh);
  }

  /**
   * Write one sample of a ribbon.
   * @param ribbon - Which ribbon.
   * @param k - Sample index, 0 at the head.
   * @param x - Centreline x.
   * @param y - Centreline y.
   * @param z - Centreline z.
   * @param halfWidth - Half the ribbon's width here; 0 hides it.
   * @param r - Linear red.
   * @param g - Linear green.
   * @param b - Linear blue.
   * @param a - Brightness of the additive glow.
   */
  public set(
    ribbon: number,
    k: number,
    x: number,
    y: number,
    z: number,
    halfWidth: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    const v = (ribbon * this.samples + k) * 2;
    const p = v * 3;
    const s = v * 2;
    const c = v * 4;
    const positions = this._positions;
    const colors = this._colors;

    positions[p] = positions[p + 3] = x;
    positions[p + 1] = positions[p + 4] = y;
    positions[p + 2] = positions[p + 5] = z;
    this._shape[s + 1] = this._shape[s + 3] = halfWidth;
    colors[c] = colors[c + 4] = r;
    colors[c + 1] = colors[c + 5] = g;
    colors[c + 2] = colors[c + 6] = b;
    colors[c + 3] = colors[c + 7] = a;
  }

  /**
   * Hide a ribbon this frame.
   * @param ribbon - Which ribbon.
   */
  public hide(ribbon: number): void {
    const from = ribbon * this.samples * 2;

    for (let v = from; v < from + this.samples * 2; v++) this._shape[v * 2 + 1] = 0;
  }

  /** Work out every sample's direction along its ribbon and upload the frame. Call once a frame, after writing. */
  public upload(): void {
    const n = this.samples;
    const positions = this._positions;
    const directions = this._directions;

    for (let r = 0; r < this._ribbons; r++) {
      for (let k = 0; k < n; k++) {
        // Central differences, one-sided at the ends; always tail to head, so the side never flips along a ribbon.
        const ahead = (r * n + Math.max(k - 1, 0)) * 2 * 3;
        const behind = (r * n + Math.min(k + 1, n - 1)) * 2 * 3;
        const d = (r * n + k) * 2 * 3;
        const dx = positions[ahead] - positions[behind];
        const dy = positions[ahead + 1] - positions[behind + 1];
        const dz = positions[ahead + 2] - positions[behind + 2];

        directions[d] = directions[d + 3] = dx;
        directions[d + 1] = directions[d + 4] = dy;
        directions[d + 2] = directions[d + 5] = dz;
      }
    }

    this._positionsBuffer.update();
    this._directionsBuffer.update();
    this._shapeBuffer.update();
    this._colorsBuffer.update();
  }

  /** Release the mesh with its geometry, buffers and material. */
  public destroy(): void {
    this._mesh.destroy({ geometry: true, material: true });
  }
}

function vertexBuffer(data: Float32Array, label: string): Buffer {
  return new Buffer({ data, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST, label, shrinkToFit: false });
}
