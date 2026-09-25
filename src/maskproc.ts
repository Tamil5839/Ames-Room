/**
 * Mask post-processing shared by the segmentation worker, the main-thread
 * fallback and the demo performer. Masks are MASK_SIZE² uint8 confidence maps
 * covering a square region of interest (ROI) of the source video.
 */

export const MASK_SIZE = 256;

/** Square region of the source video, in video pixels. May extend past the frame edges. */
export interface Roi {
  x: number;
  y: number;
  size: number;
}

export interface MaskStats {
  found: boolean;
  /** Fraction of the ROI covered by the person. */
  area: number;
  /** Bounding box of the person, video pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Mask centroid, video pixels. */
  cx: number;
  cy: number;
  /** Feet: centre of the lowest rows and the lowest row, video pixels. */
  feetX: number;
  feetY: number;
  /** Top of the head (ignores hands raised to the side), video pixels. */
  headY: number;
  /** Robust body width around the shoulders, video pixels. */
  shoulderW: number;
  /** The mask runs into the bottom edge of the video frame (feet cut off). */
  touchesBottom: boolean;
}

export const EMPTY_STATS: MaskStats = {
  found: false,
  area: 0,
  x0: 0,
  y0: 0,
  x1: 0,
  y1: 0,
  cx: 0,
  cy: 0,
  feetX: 0,
  feetY: 0,
  headY: 0,
  shoulderW: 0,
  touchesBottom: false,
};

/** Float confidences (0..1) → uint8. `invert` for background-class masks. */
export function toUint8(src: Float32Array, out: Uint8Array, invert = false): void {
  const n = Math.min(src.length, out.length);
  for (let i = 0; i < n; i++) {
    const v = invert ? 1 - src[i] : src[i];
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
  }
}

export function sameRoi(a: Roi, b: Roi): boolean {
  return Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3 && Math.abs(a.size - b.size) < 1e-3;
}

/** Bilinearly resamples a mask defined over `from` into the pixel grid of `to`. */
export function resampleMask(src: Uint8Array, from: Roi, to: Roi, out: Uint8Array, n = MASK_SIZE): void {
  const k = to.size / from.size;
  const off = (to.x - from.x) / from.size * n;
  const offY = (to.y - from.y) / from.size * n;
  for (let j = 0; j < n; j++) {
    const sy = offY + (j + 0.5) * k - 0.5;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let i = 0; i < n; i++) {
      const sx = off + (i + 0.5) * k - 0.5;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      let v = 0;
      if (x0 >= -1 && x0 < n && y0 >= -1 && y0 < n) {
        const a = x0 >= 0 && y0 >= 0 ? src[y0 * n + x0] : 0;
        const b = x0 + 1 < n && y0 >= 0 ? src[y0 * n + x0 + 1] : 0;
        const c = x0 >= 0 && y0 + 1 < n ? src[(y0 + 1) * n + x0] : 0;
        const d = x0 + 1 < n && y0 + 1 < n ? src[(y0 + 1) * n + x0 + 1] : 0;
        v = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      }
      out[j * n + i] = (v + 0.5) | 0;
    }
  }
}

/**
 * Temporal smoothing, in place: cur = prev + (cur - prev) * a, where a grows with
 * the size of the change so real motion is followed quickly while small
 * frame-to-frame edge flicker is averaged away.
 */
export function smoothMask(cur: Uint8Array, prev: Uint8Array, smoothing: number): void {
  const base = 1 - Math.min(0.95, Math.max(0, smoothing));
  for (let i = 0; i < cur.length; i++) {
    const p = prev[i];
    const d = cur[i] - p;
    const ad = d < 0 ? -d : d;
    const t = ad <= 50 ? 0 : ad >= 190 ? 1 : (ad - 50) / 140;
    const a = base + (1 - base) * t;
    cur[i] = (p + d * a + 0.5) | 0;
  }
}

const T = 128;

/** Person statistics from a mask, converted to video pixels. */
export function maskStats(mask: Uint8Array, roi: Roi, _videoW: number, videoH: number, n = MASK_SIZE): MaskStats {
  const colCount = new Uint16Array(n);
  let total = 0;
  for (let j = 0; j < n; j++) {
    const row = j * n;
    for (let i = 0; i < n; i++) {
      if (mask[row + i] >= T) {
        colCount[i]++;
        total++;
      }
    }
  }
  if (total < n * n * 0.0015) return { ...EMPTY_STATS };

  // Main blob by column contiguity around the densest column (ignores stray blobs at the sides).
  let peak = 0;
  for (let i = 1; i < n; i++) if (colCount[i] > colCount[peak]) peak = i;
  const maxGap = Math.max(3, Math.round(n * 0.02));
  let xa = peak;
  for (let gap = 0, i = peak - 1; i >= 0; i--) {
    if (colCount[i] > 0) {
      xa = i;
      gap = 0;
    } else if (++gap > maxGap) break;
  }
  let xb = peak;
  for (let gap = 0, i = peak + 1; i < n; i++) {
    if (colCount[i] > 0) {
      xb = i;
      gap = 0;
    } else if (++gap > maxGap) break;
  }

  const rowCount = new Uint16Array(n);
  let sum = 0;
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (let j = 0; j < n; j++) {
    const row = j * n;
    for (let i = xa; i <= xb; i++) {
      const v = mask[row + i];
      if (v >= T) {
        rowCount[j]++;
        count++;
      }
      if (v >= 32) {
        sum += v;
        sx += v * i;
        sy += v * j;
      }
    }
  }
  let ya = 0;
  while (ya < n - 1 && rowCount[ya] < 2) ya++;
  let yb = n - 1;
  while (yb > 0 && rowCount[yb] < 2) yb--;
  if (yb <= ya + 4 || sum === 0) return { ...EMPTY_STATS };
  const h = yb - ya;

  // Feet: centre of the mask in the lowest 5% of the body.
  const feetTop = Math.max(ya, yb - Math.max(2, Math.round(h * 0.05)));
  let fsum = 0;
  let fcount = 0;
  for (let j = feetTop; j <= yb; j++) {
    for (let i = xa; i <= xb; i++) {
      if (mask[j * n + i] >= T) {
        fsum += i;
        fcount++;
      }
    }
  }
  const feetI = fcount ? fsum / fcount : sx / sum;

  // Torso centre (median column of rows 18%-40% down) and the head band around it.
  const hist = new Uint16Array(n);
  let hcount = 0;
  for (let j = ya + Math.round(h * 0.18); j <= ya + Math.round(h * 0.4); j++) {
    for (let i = xa; i <= xb; i++) {
      if (mask[j * n + i] >= T) {
        hist[i]++;
        hcount++;
      }
    }
  }
  let torso = Math.round(sx / sum);
  if (hcount > 0) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += hist[i];
      if (acc * 2 >= hcount) {
        torso = i;
        break;
      }
    }
  }
  const band = Math.max(3, Math.round(h * 0.075));
  let headJ = ya;
  for (let j = ya; j <= yb; j++) {
    let c = 0;
    for (let i = Math.max(xa, torso - band); i <= Math.min(xb, torso + band); i++) if (mask[j * n + i] >= T) c++;
    if (c >= 2) {
      headJ = j;
      break;
    }
  }

  // Shoulder width: 75th percentile of row widths in the upper body.
  const r0 = headJ + Math.round((yb - headJ) * 0.15);
  const r1 = headJ + Math.round((yb - headJ) * 0.45);
  const widths: number[] = [];
  for (let j = r0; j <= r1; j++) widths.push(rowCount[j]);
  widths.sort((a, b) => a - b);
  const shoulder = widths.length ? widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.75))] : 0;

  const k = roi.size / n;
  const vx = (i: number) => roi.x + (i + 0.5) * k;
  const vy = (j: number) => roi.y + (j + 0.5) * k;
  const frameBottom = (videoH - roi.y) / k; // in mask rows
  const touchesBottom = yb >= Math.min(n - 1, frameBottom - 1) - 2;
  return {
    found: true,
    area: count / (n * n),
    x0: vx(xa) - k / 2,
    y0: vy(ya) - k / 2,
    x1: vx(xb) + k / 2,
    y1: vy(yb) + k / 2,
    cx: vx(sx / sum),
    cy: vy(sy / sum),
    feetX: vx(feetI),
    feetY: vy(yb) + k / 2,
    headY: vy(headJ) - k / 2,
    shoulderW: shoulder * k,
    touchesBottom,
  };
}

/**
 * Chooses the ROI for the next frame from the latest stats: a square around the
 * person with generous margins, kept steady until the person nears its edges.
 */
export class RoiTracker {
  private roi: Roi | null = null;
  private lost = 0;

  reset(): void {
    this.roi = null;
    this.lost = 0;
  }

  /** Full-frame square (letterboxed) used until someone is found. */
  static fullFrame(w: number, h: number): Roi {
    const size = Math.max(w, h);
    return { x: (w - size) / 2, y: (h - size) / 2, size };
  }

  current(w: number, h: number): Roi {
    return this.roi ?? RoiTracker.fullFrame(w, h);
  }

  update(stats: MaskStats, w: number, h: number): void {
    if (!stats.found) {
      if (++this.lost > 12) this.roi = null;
      return;
    }
    this.lost = 0;
    const bw = stats.x1 - stats.x0;
    const bh = stats.y1 - stats.y0;
    const want = Math.min(Math.max(w, h), Math.max(bh * 1.32, bw * 1.25, h * 0.3));
    const cx = (stats.x0 + stats.x1) / 2;
    const cy = (stats.y0 + stats.y1) / 2;
    const r = this.roi;
    if (r) {
      const inner = 0.1 * r.size;
      const inside =
        stats.x0 > r.x + inner && stats.x1 < r.x + r.size - inner && stats.y0 > r.y + inner * 0.6 && stats.y1 < r.y + r.size - inner * 0.6;
      const sizeOk = want > r.size * 0.8 && want < r.size * 1.12;
      if (inside && sizeOk) return; // keep the ROI steady: fewer resamples, stabler masks
    }
    const size = r ? r.size + (want - r.size) * 0.6 : want;
    this.roi = { x: cx - size / 2, y: cy - size / 2, size };
  }
}
