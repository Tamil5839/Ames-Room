import { describe, expect, it } from 'vitest';
import { MASK_SIZE, RoiTracker, maskStats, resampleMask, smoothMask, type Roi } from '../src/maskproc';

const N = MASK_SIZE;

/** Draws a simple standing figure into a mask (mask pixel coordinates). */
function figure(opts: { cx: number; top: number; bottom: number; armUp?: boolean; stray?: boolean }): Uint8Array {
  const m = new Uint8Array(N * N);
  const h = opts.bottom - opts.top;
  const set = (i: number, j: number) => {
    if (i >= 0 && i < N && j >= 0 && j < N) m[j * N + i] = 255;
  };
  const headR = h * 0.065;
  const headCy = opts.top + headR;
  for (let j = opts.top; j <= opts.bottom; j++) {
    for (let i = 0; i < N; i++) {
      const dx = i - opts.cx;
      if (j < opts.top + 2 * headR) {
        if (dx * dx + (j - headCy) ** 2 <= headR * headR) set(i, j);
      } else if (j < opts.top + h * 0.5) {
        if (Math.abs(dx) <= h * 0.12) set(i, j);
      } else if (Math.abs(Math.abs(dx) - h * 0.05) <= h * 0.04) {
        set(i, j);
      }
    }
  }
  if (opts.armUp) {
    // An arm raised well above the head, off to one side, attached at the shoulder.
    for (let j = opts.top - Math.round(h * 0.15); j < opts.top + h * 0.3; j++) {
      for (let i = Math.round(opts.cx + h * 0.2); i < opts.cx + h * 0.24; i++) set(i, j);
    }
    for (let j = Math.round(opts.top + h * 0.25); j < opts.top + h * 0.3; j++) {
      for (let i = Math.round(opts.cx + h * 0.1); i < opts.cx + h * 0.24; i++) set(i, j);
    }
  }
  if (opts.stray) for (let j = 10; j < 30; j++) for (let i = 2; i < 6; i++) set(i, j);
  return m;
}

describe('maskStats', () => {
  const roi: Roi = { x: 100, y: -40, size: 512 }; // 2 video px per mask px

  it('finds the bounding box, feet and head of a standing figure', () => {
    const s = maskStats(figure({ cx: 128, top: 40, bottom: 230 }), roi, 1280, 720);
    expect(s.found).toBe(true);
    expect(s.headY).toBeCloseTo(roi.y + 40 * 2, -1);
    expect(s.feetY).toBeCloseTo(roi.y + 231 * 2, -1);
    expect(s.feetX).toBeCloseTo(roi.x + 128.5 * 2, -1);
    expect(s.touchesBottom).toBe(false);
    expect(s.touchesTop).toBe(false);
    expect(s.touchesSide).toBe(false);
  });

  it('flags a person whose head leaves the top of the frame', () => {
    // ROI reaches 40 px above the frame, so the frame's top edge is mask row 20.
    const roi: Roi = { x: 100, y: -40, size: 512 };
    const cut = figure({ cx: 128, top: 0, bottom: 200 });
    cut.fill(0, 0, 20 * N); // nothing above the frame edge
    expect(maskStats(cut, roi, 1280, 720).touchesTop).toBe(true);
    expect(maskStats(figure({ cx: 128, top: 40, bottom: 200 }), roi, 1280, 720).touchesTop).toBe(false);
  });

  it('ignores a hand raised to the side when measuring the head', () => {
    const s = maskStats(figure({ cx: 128, top: 60, bottom: 230, armUp: true }), roi, 1280, 720);
    expect(s.y0).toBeLessThan(roi.y + 60 * 2 - 20); // bbox includes the hand
    expect(s.headY).toBeCloseTo(roi.y + 60 * 2, -1); // head does not
  });

  it('ignores stray blobs away from the body', () => {
    const s = maskStats(figure({ cx: 150, top: 40, bottom: 230, stray: true }), roi, 1280, 720);
    expect(s.x0).toBeGreaterThan(roi.x + 60 * 2);
  });

  it('detects feet cut off by the bottom of the frame', () => {
    // Frame bottom (720) sits at mask row (720 + 40) / 2 = 380 → beyond the mask, so use a ROI that reaches it.
    const low: Roi = { x: 100, y: 250, size: 512 }; // frame bottom at mask row 235
    const s = maskStats(figure({ cx: 128, top: 40, bottom: 240 }), low, 1280, 720);
    expect(s.touchesBottom).toBe(true);
  });

  it('measures the shoulders, not the head, with laptop framing (feet out of frame)', () => {
    // Only head to hips visible: the body runs off the bottom of the mask.
    const m = figure({ cx: 128, top: 20, bottom: 470 });
    const s = maskStats(m, { x: 0, y: 0, size: 512 }, 512, 512);
    const torsoPx = 2 * Math.round(450 * 0.12) + 1; // torso width in mask px (figure())
    expect(s.touchesBottom).toBe(true);
    expect(s.shoulderW / 2).toBeGreaterThan(torsoPx * 0.9);
  });

  it('does not mistake a person cut by the ROI edge for feet out of the frame', () => {
    // ROI bottom at y = 0 + 512 = 512 while the frame continues down to 720.
    const s = maskStats(figure({ cx: 128, top: 40, bottom: 255 }), { x: 100, y: 0, size: 512 }, 1280, 720);
    expect(s.touchesBottom).toBe(false);
  });

  it('reports nothing for an empty mask', () => {
    expect(maskStats(new Uint8Array(N * N), roi, 1280, 720).found).toBe(false);
  });
});

describe('mask temporal processing', () => {
  it('resampling into the same ROI is the identity', () => {
    const src = figure({ cx: 128, top: 40, bottom: 230 });
    const out = new Uint8Array(N * N);
    resampleMask(src, { x: 0, y: 0, size: 512 }, { x: 0, y: 0, size: 512 }, out);
    expect(out).toEqual(src);
  });

  it('resampling follows a moved ROI', () => {
    const src = figure({ cx: 128, top: 40, bottom: 230 });
    const out = new Uint8Array(N * N);
    // New ROI shifted right by 20 mask px (40 video px): the figure moves left by 20 px.
    resampleMask(src, { x: 0, y: 0, size: 512 }, { x: 40, y: 0, size: 512 }, out);
    const a = maskStats(src, { x: 0, y: 0, size: 512 }, 1280, 720);
    const b = maskStats(out, { x: 40, y: 0, size: 512 }, 1280, 720);
    expect(b.feetX).toBeCloseTo(a.feetX, -1);
  });

  it('averages small flicker but follows large changes', () => {
    const prev = new Uint8Array([100, 0, 255]);
    const cur = new Uint8Array([130, 255, 0]);
    smoothMask(cur, prev, 0.6);
    expect(cur[0]).toBeGreaterThan(100);
    expect(cur[0]).toBeLessThan(120); // small change: smoothed
    expect(cur[1]).toBe(255); // big change: followed at once
    expect(cur[2]).toBe(0);
  });
});

describe('RoiTracker', () => {
  it('jumps toward a person who is cut off by the ROI edge', () => {
    const t = new RoiTracker();
    const full = t.current(1280, 720);
    t.update(maskStats(figure({ cx: 128, top: 90, bottom: 200 }), full, 1280, 720), 1280, 720);
    const r1 = t.current(1280, 720);
    expect(r1.size).toBeLessThan(full.size);
    // The person has moved right so the ROI only sees their left half.
    const cut = new Uint8Array(N * N);
    const src = figure({ cx: 250, top: 40, bottom: 230 });
    cut.set(src);
    const s = maskStats(cut, r1, 1280, 720);
    t.update(s, 1280, 720);
    const r2 = t.current(1280, 720);
    const personX = r1.x + (250.5 / N) * r1.size;
    expect(r2.x + r2.size).toBeGreaterThan(personX + 0.1 * r1.size);
  });

  it('zooms in on the person and stays steady for small moves', () => {
    const t = new RoiTracker();
    const full = t.current(1280, 720);
    expect(full.size).toBe(1280);
    // Full-frame ROI is 1280 px for 256 mask px (5 px each): a 550 px tall person.
    const stats = maskStats(figure({ cx: 128, top: 90, bottom: 200 }), full, 1280, 720);
    t.update(stats, 1280, 720);
    const r1 = t.current(1280, 720);
    expect(r1.size).toBeLessThan(full.size);
    t.update(stats, 1280, 720);
    expect(t.current(1280, 720)).toEqual(r1);
  });
});
