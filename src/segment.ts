import { MASK_SIZE, RoiTracker, type MaskStats, type Roi } from './maskproc';
import type { Delegate, SegmenterConfig, SegmentResult, SegmentRunner, WorkerRequest, WorkerResponse } from './mediapipe';
import type { SegModel } from './config';

/**
 * Webcam capture + person segmentation.
 *
 * Every captured frame is cropped to a square region of interest around the
 * performer (tracked from the previous mask). The crop is kept for display and a
 * 256² copy goes to MediaPipe, so the colour pixels and the mask always come from
 * the very same video frame and the edges never lag behind the picture.
 */

/** Resolution of the colour crop used for the cutout card. */
export const COLOR_SIZE = 768;
const TARGET_FPS = 30;

export interface PersonFrame {
  id: number;
  time: number;
  color: ImageBitmap;
  mask: Uint8Array;
  roi: Roi;
  videoW: number;
  videoH: number;
  stats: MaskStats;
  /** Mean linear luminance of the person (-1 if unknown). */
  lum: number;
}

export interface PersonSource {
  readonly kind: 'camera' | 'demo';
  /** Human readable status for the UI. */
  status: string;
  /** Measured segmentation rate. */
  fps: number;
  /** Returns the newest processed frame (once), or null. The caller owns `color`. */
  take(): PersonFrame | null;
  stop(): void;
}

export const MODEL_URLS: Record<SegModel, string> = {
  selfie: 'models/selfie_segmenter.tflite',
  'multiclass (16 MB)':
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};

function segmenterConfig(model: SegModel, delegate: Delegate): SegmenterConfig {
  const base = document.baseURI;
  return {
    loaderUrl: new URL('mediapipe/vision_wasm_module_internal.js', base).href,
    wasmUrl: new URL('mediapipe/vision_wasm_module_internal.wasm', base).href,
    modelUrl: new URL(MODEL_URLS[model], base).href,
    delegate,
  };
}

interface Backend {
  readonly name: string;
  delegate: Delegate;
  segment(image: ImageBitmap, roi: Roi, videoW: number, videoH: number, ts: number, smoothing: number): Promise<SegmentResult>;
  reset(): void;
  dispose(): void;
}

class WorkerBackend implements Backend {
  readonly name = 'worker';
  delegate: Delegate = 'GPU';
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: SegmentResult) => void; reject: (e: Error) => void }>();
  private ready: Promise<void>;

  constructor(config: SegmenterConfig) {
    this.worker = new Worker(new URL('./segment.worker.ts', import.meta.url), { type: 'module', name: 'ames-segmenter' });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('segmentation worker timed out')), 45000);
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          clearTimeout(timer);
          this.delegate = msg.delegate;
          resolve();
        } else if (msg.type === 'error' && msg.id === undefined) {
          clearTimeout(timer);
          reject(new Error(msg.message));
        } else if (msg.type === 'error' && msg.id !== undefined) {
          this.pending.get(msg.id)?.reject(new Error(msg.message));
          this.pending.delete(msg.id);
        } else if (msg.type === 'result') {
          this.pending.get(msg.id)?.resolve(msg);
          this.pending.delete(msg.id);
        }
      };
      this.worker.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(e.message || 'segmentation worker failed to load'));
      };
    });
    this.post({ type: 'init', config });
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private post(msg: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  segment(image: ImageBitmap, roi: Roi, videoW: number, videoH: number, ts: number, smoothing: number): Promise<SegmentResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: 'segment', id, image, roi, videoW, videoH, ts, smoothing }, [image]);
    });
  }

  reset(): void {
    this.post({ type: 'reset' });
  }

  dispose(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('disposed'));
    this.pending.clear();
  }
}

class MainThreadBackend implements Backend {
  readonly name = 'main thread';
  constructor(private readonly runner: SegmentRunner) {}
  get delegate(): Delegate {
    return this.runner.delegate;
  }
  async segment(image: ImageBitmap, roi: Roi, videoW: number, videoH: number, ts: number, smoothing: number): Promise<SegmentResult> {
    try {
      return this.runner.run(image, roi, videoW, videoH, ts, smoothing);
    } finally {
      image.close();
    }
  }
  reset(): void {
    this.runner.reset();
  }
  dispose(): void {
    this.runner.close();
  }
}

async function createBackend(model: SegModel, onStatus: (s: string) => void): Promise<Backend> {
  const config = segmenterConfig(model, 'GPU');
  try {
    onStatus('Loading segmentation (worker)…');
    const wb = new WorkerBackend(config);
    await wb.whenReady();
    return wb;
  } catch (err) {
    console.warn('[Ames] segmentation worker unavailable, running on the main thread:', err);
    onStatus('Loading segmentation…');
    // Loaded on demand so MediaPipe stays out of the main bundle when the worker works.
    const { SegmentRunner } = await import('./mediapipe');
    return new MainThreadBackend(await SegmentRunner.create(config));
  }
}

export interface CameraOptions {
  deviceId?: string;
}

export async function openCamera(opts: CameraOptions = {}): Promise<MediaStream> {
  const video: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  };
  if (opts.deviceId) video.deviceId = { exact: opts.deviceId };
  else video.facingMode = 'user';
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

let cropCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
let directCropWorks = true;

/**
 * Crops the ROI from a frame source as a COLOR_SIZE² bitmap plus a MASK_SIZE² copy
 * for the model. The ROI may extend past the frame (it is letterboxed while
 * searching); areas outside the frame come out transparent black.
 */
export async function captureRoi(source: CanvasImageSource & ImageBitmapSource, roi: Roi): Promise<[ImageBitmap, ImageBitmap]> {
  const x = Math.round(roi.x);
  const y = Math.round(roi.y);
  const size = Math.round(roi.size);
  let color: ImageBitmap | null = null;
  if (directCropWorks) {
    try {
      color = await createImageBitmap(source, x, y, size, size, { resizeWidth: COLOR_SIZE, resizeHeight: COLOR_SIZE, resizeQuality: 'medium' });
      if (color.width !== COLOR_SIZE) {
        color.close();
        color = null;
        directCropWorks = false;
      }
    } catch {
      directCropWorks = false;
    }
  }
  if (!color) {
    // Fallback: drawImage clips an out-of-bounds source rectangle the same way.
    if (!cropCanvas) {
      if (typeof OffscreenCanvas !== 'undefined') cropCanvas = new OffscreenCanvas(COLOR_SIZE, COLOR_SIZE);
      else {
        cropCanvas = document.createElement('canvas');
        cropCanvas.width = cropCanvas.height = COLOR_SIZE;
      }
    }
    const ctx = cropCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    ctx.clearRect(0, 0, COLOR_SIZE, COLOR_SIZE);
    ctx.drawImage(source, x, y, size, size, 0, 0, COLOR_SIZE, COLOR_SIZE);
    color = await createImageBitmap(cropCanvas);
  }
  const small = await createImageBitmap(color, { resizeWidth: MASK_SIZE, resizeHeight: MASK_SIZE, resizeQuality: 'medium' });
  return [color, small];
}

/** Integer ROI (the crop actually taken), so mask and colour agree to the pixel. */
export function snapRoi(r: Roi): Roi {
  return { x: Math.round(r.x), y: Math.round(r.y), size: Math.round(r.size) };
}

export class CameraSource implements PersonSource {
  readonly kind = 'camera' as const;
  status = 'Starting camera…';
  fps = 0;
  private backend: Backend | null = null;
  private latest: PersonFrame | null = null;
  private readonly roiTracker = new RoiTracker();
  private inFlight = false;
  private stopped = false;
  private frameId = 0;
  private lastSubmit = 0;
  private fpsCount = 0;
  private fpsT0 = performance.now();
  private rafHandle = 0;

  constructor(
    readonly video: HTMLVideoElement,
    private readonly getSmoothing: () => number,
    private model: SegModel,
  ) {}

  async start(): Promise<void> {
    this.backend = await createBackend(this.model, (s) => (this.status = s));
    this.status = `Segmenting (${this.backend.delegate}, ${this.backend.name})`;
    this.schedule();
  }

  async setModel(model: SegModel): Promise<void> {
    if (model === this.model) return;
    this.model = model;
    const old = this.backend;
    this.backend = null;
    old?.dispose();
    this.backend = await createBackend(model, (s) => (this.status = s));
    this.status = `Segmenting (${this.backend.delegate}, ${this.backend.name})`;
  }

  private schedule(): void {
    if (this.stopped) return;
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (typeof v.requestVideoFrameCallback === 'function') {
      v.requestVideoFrameCallback(() => {
        this.tick();
        this.schedule();
      });
    } else {
      this.rafHandle = requestAnimationFrame(() => {
        this.tick();
        this.schedule();
      });
    }
  }

  private tick(): void {
    const now = performance.now();
    if (this.inFlight || !this.backend) return;
    if (now - this.lastSubmit < 1000 / TARGET_FPS - 4) return;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh || this.video.readyState < 2) return;
    this.lastSubmit = now;
    this.inFlight = true;
    void this.process(vw, vh, now).finally(() => (this.inFlight = false));
  }

  private async process(vw: number, vh: number, now: number): Promise<void> {
    const backend = this.backend;
    if (!backend) return;
    const roi = snapRoi(this.roiTracker.current(vw, vh));
    let color: ImageBitmap | null = null;
    try {
      const [c, small] = await captureRoi(this.video, roi);
      color = c;
      const res = await backend.segment(small, roi, vw, vh, now, this.getSmoothing());
      if (this.stopped || backend !== this.backend) {
        color.close();
        return;
      }
      this.roiTracker.update(res.stats, vw, vh);
      this.publish({ id: ++this.frameId, time: now, color, mask: res.mask, roi, videoW: vw, videoH: vh, stats: res.stats, lum: res.lum });
      color = null;
      this.countFps();
    } catch (err) {
      color?.close();
      if (!this.stopped) console.warn('[Ames] segmentation frame failed:', err);
    }
  }

  private publish(f: PersonFrame): void {
    this.latest?.color.close();
    this.latest = f;
  }

  private countFps(): void {
    this.fpsCount++;
    const now = performance.now();
    if (now - this.fpsT0 >= 1000) {
      this.fps = (this.fpsCount * 1000) / (now - this.fpsT0);
      this.fpsCount = 0;
      this.fpsT0 = now;
    }
  }

  take(): PersonFrame | null {
    const f = this.latest;
    this.latest = null;
    return f;
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.rafHandle);
    this.backend?.dispose();
    this.backend = null;
    this.latest?.color.close();
    this.latest = null;
    const stream = this.video.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
  }
}
