import type { Geometry3D } from '@pixi/3d';
import { Container3D, CubeGeometry, FlatMaterial, Material3D, Mesh3D, PlaneGeometry } from '@pixi/3d';
import { Texture } from 'pixi.js';

import { skipToneCurve } from './look/toneCurve';
import { createTrackSpot } from './race/RaceRules';
import { BASE_ROUTE } from './race/route';
import { StageCameras } from './StageCameras';

/** Each place's block: its height, the metal, the colour its edges glow, its numeral's keyline and the numeral's size. */
const PLACES = [
  { height: 0.6, metal: 0xd9a531, glow: 0xffd77a, ink: '#5a3d00', numeral: 0.36 },
  { height: 0.45, metal: 0xb9c2cf, glow: 0xe4efff, ink: '#2d3442', numeral: 0.27 },
  { height: 0.32, metal: 0xb5693a, glow: 0xffa36a, ink: '#4a2010', numeral: 0.19 },
] as const;
/** The blocks' footprint: a truck stands square on one with room to spare all round. */
const WIDTH = 1.2;
const DEPTH = 1.7;
/** The chequered band round each block just under its top, and the lit rims at its top and foot. */
const BAND = 0.08;
const RIM = 0.026;
const RIM_OUT = 0.03;
/** The top rim sits this far under the block's top, so the two top faces never fight over one depth and stripe. */
const RIM_DROP = 0.005;

const _spot = createTrackSpot();

/**
 * The results' podium: gold, silver and bronze blocks on the straight past the line, each with a chequered band, lit
 * rims that bloom in the night, and its place on the front. The trucks stand on top, {@link Podium.height} up.
 * Hidden until {@link Podium.show}.
 */
export class Podium {
  public readonly root = new Container3D();

  private readonly _geometries: Geometry3D[] = [];
  private readonly _materials: (Material3D | FlatMaterial)[] = [];
  private readonly _textures: Texture[] = [];

  constructor(parent: Container3D) {
    const chequer = chequerTexture();
    const band = skipToneCurve(new FlatMaterial({ baseColor: 0xc8c8c8, baseColorTexture: chequer }));
    const bandGeometry = this._geometry(new CubeGeometry({ width: WIDTH + 0.012, height: BAND, depth: DEPTH + 0.012 }));
    const rimGeometry = this._geometry(
      new CubeGeometry({ width: WIDTH + RIM_OUT, height: RIM, depth: DEPTH + RIM_OUT }),
    );
    const numeralGeometry = this._geometry(new PlaneGeometry({ width: 1, height: 1, flipV: true }));

    this._textures.push(chequer);
    this._materials.push(band);

    for (let i = 0; i < PLACES.length; i++) {
      const place = PLACES[i];
      const block = new Container3D();
      const metal = new Material3D({
        baseColor: place.metal,
        metallic: 0.85,
        roughness: 0.3,
        emissive: { color: place.metal, strength: 0.12 },
      });
      const glow = skipToneCurve(new FlatMaterial({ baseColor: place.glow }));
      const digit = numeralTexture(i + 1, place.ink);
      const face = skipToneCurve(new FlatMaterial({ baseColorTexture: digit, alphaMode: 'mask' }));
      const body = new Mesh3D({
        geometry: this._geometry(new CubeGeometry({ width: WIDTH, height: place.height, depth: DEPTH })),
        material: metal,
        castShadow: true,
        receiveShadow: true,
      });
      const trim = new Mesh3D({ geometry: bandGeometry, material: band, castShadow: false });
      const top = new Mesh3D({ geometry: rimGeometry, material: glow, castShadow: false });
      const foot = new Mesh3D({ geometry: rimGeometry, material: glow, castShadow: false });
      const number = new Mesh3D({ geometry: numeralGeometry, material: face, castShadow: false });

      body.position.set(0, place.height / 2, 0);
      trim.position.set(0, place.height - BAND / 2 - RIM, 0);
      top.position.set(0, place.height - RIM / 2 - RIM_DROP, 0);
      foot.position.set(0, RIM / 2, 0);
      // The front faces the way its truck does, down the block's +z, centred on the metal between the foot and the band.
      number.position.set(0, (place.height - BAND) / 2, DEPTH / 2 + 0.004);
      number.scale.set(place.numeral, place.numeral, 1);
      block.addChild(body, trim, top, foot, number);

      // The top three's blocks stand on the straight after the line, the same on every track.
      StageCameras.podiumSpot(BASE_ROUTE, i + 1, _spot);
      block.position.set(_spot.x, _spot.y, _spot.z);
      block.rotation.set(0, _spot.yaw, 0);
      this.root.addChild(block);
      this._materials.push(metal, glow, face);
      this._textures.push(digit);
    }

    this.root.visible = false;
    parent.addChild(this.root);
  }

  /**
   * How high a place's truck stands.
   * @param place - 1 for the winner.
   * @returns Height of its block's top, or 0 off the podium.
   */
  public static height(place: number): number {
    return place >= 1 && place <= PLACES.length ? PLACES[place - 1].height : 0;
  }

  /**
   * Stand the podium's blocks for the first few places, or put it away: a party of two leaves no empty bronze block.
   * @param places - How many places get a block, up to 3; 0 puts the podium away.
   */
  public show(places: number): void {
    const blocks = this.root.children;

    for (let i = 0; i < blocks.length; i++) blocks[i].visible = i < places;

    this.root.visible = places > 0;
  }

  public destroy(): void {
    this.root.destroy({ children: true });

    for (const geometry of this._geometries) geometry.destroy();
    for (const material of this._materials) material.destroy();
    for (const texture of this._textures) texture.destroy(true);

    this._geometries.length = 0;
    this._materials.length = 0;
    this._textures.length = 0;
  }

  private _geometry<T extends Geometry3D>(geometry: T): T {
    this._geometries.push(geometry);

    return geometry;
  }
}

/** A two-row chequer for the band round each block. */
function chequerTexture(): Texture {
  const canvas = document.createElement('canvas');
  const cells = 24;
  const size = 16;

  canvas.width = cells * size;
  canvas.height = size * 2;

  const ctx = canvas.getContext('2d')!;

  for (let row = 0; row < 2; row++) {
    for (let cell = 0; cell < cells; cell++) {
      ctx.fillStyle = (row + cell) % 2 ? '#0d0d12' : '#f4f4f4';
      ctx.fillRect(cell * size, row * size, size, size);
    }
  }

  return Texture.from(canvas);
}

/** The place, white with a keyline in the metal's ink, on a clear ground. */
function numeralTexture(place: number, ink: string): Texture {
  const canvas = document.createElement('canvas');
  const size = 128;

  canvas.width = canvas.height = size;

  const ctx = canvas.getContext('2d')!;

  ctx.font = `italic 900 ${Math.round(size * 0.86)}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 12;
  ctx.strokeStyle = ink;
  ctx.strokeText(String(place), size / 2, size / 2 + 6);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(String(place), size / 2, size / 2 + 6);

  return Texture.from(canvas);
}
