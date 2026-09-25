import { describe, expect, it } from 'vitest';
import { WalkMapper, springStep, walkLine, walkPoint } from '../src/walk';
import { HALF_W, ROOM } from '../src/config';

describe('critically damped spring', () => {
  it('settles on the target without overshooting', () => {
    let x = 0;
    let v = 0;
    let max = 0;
    for (let i = 0; i < 240; i++) {
      [x, v] = springStep(x, v, 1, 6, 1 / 60);
      max = Math.max(max, x);
    }
    expect(x).toBeCloseTo(1, 4);
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('is frame-rate independent', () => {
    let a: [number, number] = [0, 0];
    let b: [number, number] = [0, 0];
    for (let i = 0; i < 60; i++) a = springStep(a[0], a[1], 1, 5, 1 / 60);
    for (let i = 0; i < 30; i++) b = springStep(b[0], b[1], 1, 5, 1 / 30);
    expect(a[0]).toBeCloseTo(b[0], 10);
  });
});

describe('walk mapping', () => {
  it('mirrors the camera so stepping to your left heads for the far-left corner', () => {
    const w = new WalkMapper();
    // Stepping to your left moves you to the RIGHT of the raw (unmirrored) camera image.
    w.setObservation(0.9, true);
    expect(w.targetU).toBe(0);
    w.setObservation(0.1, true);
    expect(w.targetU).toBe(1);
    w.setObservation(0.5, true);
    expect(w.targetU).toBeCloseTo(0.5, 10);
  });

  it('maps u onto the walking line in front of the back wall', () => {
    const line = walkLine(0.45, 0.3);
    expect(walkPoint(line, 0)).toEqual({ x: -HALF_W + 0.3, y: 0, z: -ROOM.depth + 0.45 });
    expect(walkPoint(line, 1).x).toBeCloseTo(HALF_W - 0.3, 12);
  });
});
