/**
 * Canvas recording: canvas.captureStream(30) + MediaRecorder. MP4 (H.264) when
 * the browser can encode it, otherwise WebM (see the README for a one-line
 * ffmpeg conversion). Only the WebGL canvas is captured, so the HTML UI, the
 * director cues and the settings panel never end up in the video.
 */

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  extension: 'mp4' | 'webm';
  /** H.264 in MP4: ready for X/Twitter as is. */
  shareReady: boolean;
  width: number;
  height: number;
  seconds: number;
}

// MP4 is only preferred when it is H.264: a bare "video/mp4" may silently mean
// VP9-in-MP4 (Chromium without proprietary codecs), which X/Twitter rejects.
const VIDEO_TYPES = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1.4d0028',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/mp4',
  'video/webm',
];

function withAudio(type: string): string[] {
  if (type.startsWith('video/mp4')) {
    return type.includes('codecs=') ? [`${type},mp4a.40.2`] : ['video/mp4;codecs=avc1,mp4a.40.2', type];
  }
  return type.includes('codecs=') ? [`${type},opus`] : ['video/webm;codecs=vp9,opus', type];
}

export function pickMimeType(audio: boolean): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of VIDEO_TYPES) {
    const candidates = audio ? withAudio(t) : [t];
    for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

/** Whether a recorded MIME type is H.264 MP4 (Safari reports a bare "video/mp4", which is H.264). */
export function isShareReady(mimeType: string): boolean {
  if (!mimeType.startsWith('video/mp4')) return false;
  if (/avc1|avc3|h264/i.test(mimeType)) return true;
  return !/codecs=/.test(mimeType) && !/vp9|vp8|av01/i.test(mimeType) && /Safari/.test(navigator.userAgent) && !/Chrome|Chromium/.test(navigator.userAgent);
}

export function canRecord(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

export class Recorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startTime = 0;
  private size: [number, number] = [0, 0];
  private stream: MediaStream | null = null;

  get recording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording';
  }

  get elapsed(): number {
    return this.recording ? (performance.now() - this.startTime) / 1000 : 0;
  }

  start(canvas: HTMLCanvasElement, audio: MediaStream | null, fps = 30): string {
    const hasAudio = !!audio && audio.getAudioTracks().length > 0;
    const mimeType = pickMimeType(hasAudio) ?? pickMimeType(false);
    if (!mimeType) throw new Error('This browser cannot record video (MediaRecorder unsupported).');
    const includeAudio = hasAudio && /mp4a|opus|vorbis/.test(mimeType);
    const video = canvas.captureStream(fps);
    const tracks = [...video.getVideoTracks(), ...(includeAudio && audio ? audio.getAudioTracks() : [])];
    this.stream = new MediaStream(tracks);
    const pixels = canvas.width * canvas.height;
    this.recorder = new MediaRecorder(this.stream, {
      mimeType,
      videoBitsPerSecond: Math.round(Math.min(16e6, Math.max(6e6, pixels * 5.5))),
      audioBitsPerSecond: includeAudio ? 128000 : undefined,
    });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.size = [canvas.width, canvas.height];
    this.recorder.start(250);
    this.startTime = performance.now();
    return mimeType;
  }

  stop(): Promise<RecordingResult> {
    const rec = this.recorder;
    if (!rec) return Promise.reject(new Error('not recording'));
    const seconds = (performance.now() - this.startTime) / 1000;
    return new Promise((resolve, reject) => {
      rec.onstop = () => {
        const mimeType = rec.mimeType || 'video/webm';
        const blob = new Blob(this.chunks, { type: mimeType.split(';')[0] });
        this.chunks = [];
        this.stream?.getVideoTracks().forEach((t) => t.stop());
        this.stream = null;
        this.recorder = null;
        resolve({
          blob,
          mimeType,
          extension: mimeType.includes('mp4') ? 'mp4' : 'webm',
          shareReady: isShareReady(mimeType),
          width: this.size[0],
          height: this.size[1],
          seconds,
        });
      };
      rec.onerror = (e) => reject(new Error(`recording failed: ${String((e as ErrorEvent).message ?? e)}`));
      if (rec.state !== 'inactive') rec.stop();
    });
  }

  cancel(): void {
    const rec = this.recorder;
    if (!rec) return;
    rec.ondataavailable = null;
    rec.onstop = null;
    if (rec.state !== 'inactive') rec.stop();
    this.stream?.getVideoTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}
