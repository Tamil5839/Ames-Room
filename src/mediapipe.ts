import { ImageSegmenter } from '@mediapipe/tasks-vision';
import { MASK_SIZE, maskStats, personLuminance, resampleMask, sameRoi, smoothMask, toUint8, type MaskStats, type Roi } from './maskproc';

/**
 * MediaPipe ImageSegmenter wrapper shared by the segmentation worker and the
 * main-thread fallback. Loads the ES-module flavour of the wasm runtime with a
 * dynamic import (works in module workers, where importScripts is unavailable).
 */

export type Delegate = 'GPU' | 'CPU';

export interface SegmenterConfig {
  loaderUrl: string;
  wasmUrl: string;
  modelUrl: string;
  delegate: Delegate;
}

export interface SegmentResult {
  mask: Uint8Array;
  stats: MaskStats;
  /** Mean linear luminance of the person (-1 if unknown), for brightness matching. */
  lum: number;
  ms: number;
}

const LUM_SIZE = 32;

export type WorkerRequest =
  | { type: 'init'; config: SegmenterConfig }
  | { type: 'segment'; id: number; image: ImageBitmap; roi: Roi; videoW: number; videoH: number; ts: number; smoothing: number }
  | { type: 'reset' };

export type WorkerResponse =
  | { type: 'ready'; delegate: Delegate }
  | { type: 'error'; message: string; id?: number }
  | ({ type: 'result'; id: number } & SegmentResult);

type Factory = (module?: unknown) => Promise<unknown>;

let factory: Factory | null = null;

async function loadFactory(loaderUrl: string): Promise<Factory> {
  if (factory) return factory;
  const g = globalThis as { ModuleFactory?: Factory };
  const mod = (await import(/* @vite-ignore */ loaderUrl)) as { default?: Factory };
  factory = mod.default ?? g.ModuleFactory ?? null;
  if (!factory) throw new Error('MediaPipe wasm loader did not provide a ModuleFactory');
  return factory;
}

function makeCanvas(): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
  return document.createElement('canvas');
}

export class SegmentRunner {
  private prev: { mask: Uint8Array; roi: Roi } | null = null;
  private lastTs = 0;
  private readonly scratch = new Uint8Array(MASK_SIZE * MASK_SIZE);
  private lumCanvas: OffscreenCanvas | null = null;

  private constructor(
    private readonly segmenter: ImageSegmenter,
    readonly delegate: Delegate,
  ) {}

  static async create(config: SegmenterConfig): Promise<SegmentRunner> {
    const f = await loadFactory(config.loaderUrl);
    const attempt = async (delegate: Delegate) => {
      // MediaPipe consumes (and clears) the global factory on every creation.
      (globalThis as { ModuleFactory?: Factory }).ModuleFactory = f;
      return ImageSegmenter.createFromOptions(
        { wasmLoaderPath: '', wasmBinaryPath: config.wasmUrl },
        {
          baseOptions: { modelAssetPath: config.modelUrl, delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
          canvas: makeCanvas(),
        },
      );
    };
    try {
      return new SegmentRunner(await attempt(config.delegate), config.delegate);
    } catch (err) {
      if (config.delegate !== 'GPU') throw err;
      console.warn('[Ames] GPU segmentation unavailable, falling back to CPU:', err);
      return new SegmentRunner(await attempt('CPU'), 'CPU');
    }
  }

  reset(): void {
    this.prev = null;
  }

  /** Segments one ROI crop (MASK_SIZE² image) and returns the smoothed mask + stats. */
  run(image: ImageBitmap, roi: Roi, videoW: number, videoH: number, ts: number, smoothing: number): SegmentResult {
    const t0 = performance.now();
    const out = new Uint8Array(MASK_SIZE * MASK_SIZE);
    // VIDEO mode requires strictly increasing timestamps.
    const stamp = Math.max(Math.round(ts), this.lastTs + 1);
    this.lastTs = stamp;
    this.segmenter.segmentForVideo(image, stamp, (result) => {
      const masks = result.confidenceMasks;
      if (!masks || masks.length === 0) return;
      // One mask ("selfie") = person confidence; several (multiclass) = mask 0 is background.
      const invert = masks.length > 1;
      const m = masks[0];
      const data = m.getAsFloat32Array();
      if (m.width === MASK_SIZE && m.height === MASK_SIZE) {
        toUint8(data, out, invert);
      } else {
        // Nearest resample to MASK_SIZE² (only if the model output differs from the input).
        for (let j = 0; j < MASK_SIZE; j++) {
          const sj = Math.min(m.height - 1, Math.floor(((j + 0.5) / MASK_SIZE) * m.height));
          for (let i = 0; i < MASK_SIZE; i++) {
            const si = Math.min(m.width - 1, Math.floor(((i + 0.5) / MASK_SIZE) * m.width));
            const v = invert ? 1 - data[sj * m.width + si] : data[sj * m.width + si];
            out[j * MASK_SIZE + i] = Math.max(0, Math.min(255, Math.round(v * 255)));
          }
        }
      }
    });
    if (this.prev) {
      if (sameRoi(this.prev.roi, roi)) {
        smoothMask(out, this.prev.mask, smoothing);
      } else {
        resampleMask(this.prev.mask, this.prev.roi, roi, this.scratch);
        smoothMask(out, this.scratch, smoothing);
      }
    }
    this.prev = { mask: out.slice(), roi: { ...roi } };
    const stats = maskStats(out, roi, videoW, videoH);
    return { mask: out, stats, lum: this.luminance(image, out), ms: performance.now() - t0 };
  }

  private luminance(image: ImageBitmap, mask: Uint8Array): number {
    try {
      if (typeof OffscreenCanvas === 'undefined') return -1;
      this.lumCanvas ??= new OffscreenCanvas(LUM_SIZE, LUM_SIZE);
      const ctx = this.lumCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return -1;
      ctx.drawImage(image, 0, 0, LUM_SIZE, LUM_SIZE);
      return personLuminance(ctx.getImageData(0, 0, LUM_SIZE, LUM_SIZE).data, LUM_SIZE, mask);
    } catch {
      return -1;
    }
  }

  close(): void {
    this.segmenter.close();
  }
}
