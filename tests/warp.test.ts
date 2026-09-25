import { describe, expect, it } from 'vitest';
import { AmesWarp, MIN_DENOMINATOR, sightLineAngle, vec3, type Vec3 } from '../src/warp';
import { BACK_LEFT, BACK_RIGHT, DEFAULT_SETTINGS, EYE, HALF_W, ROOM } from '../src/config';

const roomBounds = { min: vec3(-HALF_W, 0, -ROOM.depth - 0.4), max: vec3(HALF_W, ROOM.height, 0) };

function makeWarp(l = DEFAULT_SETTINGS.leftFactor, r = DEFAULT_SETTINGS.rightFactor) {
  const warp = new AmesWarp(EYE, BACK_LEFT, BACK_RIGHT);
  warp.setFactors(l, r, roomBounds);
  return warp;
}

const sub = (a: Vec3, b: Vec3) => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
const cross = (a: Vec3, b: Vec3) => vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

describe('AmesWarp', () => {
  it('solves w so the back corners get the requested distance factors', () => {
    const warp = makeWarp(2.0, 0.85);
    expect(warp.w.y).toBe(0);
    expect(warp.factor(BACK_LEFT)).toBeCloseTo(2.0, 10);
    expect(warp.factor(BACK_RIGHT)).toBeCloseTo(0.85, 10);
    // The whole vertical corner edge shares the factor.
    expect(warp.factor(vec3(BACK_LEFT.x, ROOM.height, BACK_LEFT.z))).toBeCloseTo(2.0, 10);
  });

  it('keeps 1 + w·X positive everywhere in the room', () => {
    const warp = makeWarp();
    expect(warp.minDenominator(roomBounds)).toBeGreaterThan(MIN_DENOMINATOR);
  });

  it('keeps every point on its own sight line from the eye', () => {
    const warp = makeWarp();
    for (let i = 0; i < 500; i++) {
      const p = vec3(
        -HALF_W + Math.random() * ROOM.width,
        Math.random() * ROOM.height,
        -Math.random() * ROOM.depth,
      );
      const q = warp.forward(p);
      expect(sightLineAngle(EYE, p, q)).toBeLessThan(1e-9);
      const s = Math.hypot(q.x - EYE.x, q.y - EYE.y, q.z - EYE.z) / Math.hypot(p.x - EYE.x, p.y - EYE.y, p.z - EYE.z);
      expect(s).toBeCloseTo(warp.factor(p), 9);
    }
  });

  it('inverse undoes forward', () => {
    const warp = makeWarp();
    const p = vec3(-2.2, 1.7, -4.1);
    const back = warp.inverse(warp.forward(p));
    expect(back.x).toBeCloseTo(p.x, 10);
    expect(back.y).toBeCloseTo(p.y, 10);
    expect(back.z).toBeCloseTo(p.z, 10);
    expect(warp.factorAtReal(warp.forward(p))).toBeCloseTo(warp.factor(p), 10);
  });

  it('maps planes to planes (walls stay flat)', () => {
    const warp = makeWarp();
    // Four points on the back wall, four on the floor, four on the left wall.
    const planes: Vec3[][] = [
      [vec3(-3, 0, -5), vec3(3, 0, -5), vec3(3, 3, -5), vec3(-1, 2.2, -5)],
      [vec3(-3, 0, 0), vec3(3, 0, -5), vec3(-3, 0, -5), vec3(1.3, 0, -2.7)],
      [vec3(-3, 0, 0), vec3(-3, 3, -5), vec3(-3, 0, -5), vec3(-3, 1.1, -3.3)],
    ];
    for (const pts of planes) {
      const [a, b, c, d] = pts.map((p) => warp.forward(p));
      const n = cross(sub(b, a), sub(c, a));
      const dist = dot(n, sub(d, a)) / Math.hypot(n.x, n.y, n.z);
      expect(Math.abs(dist)).toBeLessThan(1e-9);
    }
  });

  it('keeps real verticals vertical', () => {
    const warp = makeWarp();
    const a = warp.forward(vec3(-2, 0.3, -4.5));
    const b = warp.forward(vec3(-2, 2.6, -4.5));
    expect(b.x - a.x).toBeCloseTo(0, 12);
    expect(b.z - a.z).toBeCloseTo(0, 12);
  });

  it('warps the floor so it tilts down toward the far corner', () => {
    const warp = makeWarp();
    const farLeft = warp.forward(BACK_LEFT);
    const nearRight = warp.forward(BACK_RIGHT);
    expect(farLeft.y).toBeLessThan(0);
    expect(nearRight.y).toBeGreaterThan(0);
  });

  it('softens an impossible warp instead of folding the room through the eye plane', () => {
    const warp = new AmesWarp(EYE, BACK_LEFT, BACK_RIGHT);
    const res = warp.setFactors(40, 0.2, roomBounds);
    expect(res.clamped).toBe(true);
    expect(warp.minDenominator(roomBounds)).toBeGreaterThanOrEqual(MIN_DENOMINATOR - 1e-6);
    expect(res.left).toBeGreaterThan(1);
    expect(res.right).toBeLessThan(1);
  });

  it('changes apparent size by at least 2x along the default walking line', () => {
    const warp = makeWarp();
    const z = -ROOM.depth + DEFAULT_SETTINGS.walkDepth;
    const left = warp.factor(vec3(-HALF_W + DEFAULT_SETTINGS.walkMargin, 0, z));
    const right = warp.factor(vec3(HALF_W - DEFAULT_SETTINGS.walkMargin, 0, z));
    // Apparent height is realHeight / s, so the on-screen ratio is s_left / s_right.
    expect(left / right).toBeGreaterThanOrEqual(2);
  });
});
