// Types for check-assets.mjs (imported by test/assets.test.ts).
export interface AssetRow {
  model: string;
  bytes: number;
  /** unique vertices (GPU memory) */
  vertices: number;
  /** primitives drawn per instance (draw calls) */
  primitives: number;
  triangles: number;
  /** image uris used ("tex/<name>.png") */
  images: string[];
}

export interface CheckResult {
  ok: boolean;
  errors: string[];
  rows: AssetRow[];
  textures: { files: string[]; used: string[]; bytes: number };
}

export interface CheckOptions {
  modelsDir?: string;
  contractPath?: string;
  log?: (...args: unknown[]) => void;
}

export const ROOT: string;
export const MODELS_DIR: string;
export const CONTRACT_PATH: string;
export const MAX_TEXTURES: number;
export const PIVOT_TOLERANCE: number;

export function checkAssets(opts?: CheckOptions): CheckResult;
export function readGlb(path: string): { json: any; bin: Uint8Array | null };
export function readPngInfo(path: string): {
  width: number; height: number; bitDepth: number; colorType: number; interlace: number; chunks: string[]; bytes: number;
};
export function nodeWorldPositions(json: any): Map<string, [number, number, number]>;
