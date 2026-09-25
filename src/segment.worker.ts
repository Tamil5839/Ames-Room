/**
 * Segmentation worker: keeps MediaPipe (and the mask smoothing/statistics) off
 * the main thread so rendering stays at 60 fps while segmentation runs at ~30.
 */
import { SegmentRunner, type WorkerRequest, type WorkerResponse } from './mediapipe';

const ctx = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

let runner: SegmentRunner | null = null;

ctx.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      runner?.close();
      runner = await SegmentRunner.create(msg.config);
      ctx.postMessage({ type: 'ready', delegate: runner.delegate });
    } catch (err) {
      ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (msg.type === 'reset') {
    runner?.reset();
    return;
  }
  if (msg.type === 'segment') {
    if (!runner) {
      msg.image.close();
      ctx.postMessage({ type: 'error', message: 'segmenter not ready', id: msg.id });
      return;
    }
    try {
      const res = runner.run(msg.image, msg.roi, msg.videoW, msg.videoH, msg.ts, msg.smoothing);
      ctx.postMessage({ type: 'result', id: msg.id, ...res }, [res.mask.buffer]);
    } catch (err) {
      ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err), id: msg.id });
    } finally {
      msg.image.close();
    }
  }
};
