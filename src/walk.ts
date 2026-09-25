import { HALF_W, ROOM } from './config';
import type { Vec3 } from './warp';

/**
 * Exact critically damped spring step (no overshoot, frame-rate independent).
 * omega is the natural frequency in rad/s: the spring settles in about 4/omega s.
 */
export function springStep(x: number, v: number, target: number, omega: number, dt: number): [number, number] {
  const exp = Math.exp(-omega * dt);
  const change = x - target;
  const temp = (v + omega * change) * dt;
  return [target + (change + temp) * exp, (v - omega * temp) * exp];
}

export interface WalkLine {
  /** Apparent z of the walking line (just in front of the back wall). */
  z: number;
  /** Apparent x of its two ends (back-left corner → back-right corner). */
  xLeft: number;
  xRight: number;
}

export function walkLine(walkDepth: number, walkMargin: number): WalkLine {
  return { z: -ROOM.depth + walkDepth, xLeft: -HALF_W + walkMargin, xRight: HALF_W - walkMargin };
}

/** Apparent floor point at parameter u (0 = back-left corner, 1 = back-right corner). */
export function walkPoint(line: WalkLine, u: number): Vec3 {
  return { x: line.xLeft + (line.xRight - line.xLeft) * u, y: 0, z: line.z };
}

/**
 * Maps the performer's horizontal position in the webcam frame onto the walking
 * line. The image is mirrored first, so stepping to your left moves you to the
 * left of the room, toward the far (tiny) corner.
 */
export class WalkMapper {
  /** Smoothed position along the line, 0..1. */
  u = 0.5;
  private v = 0;
  private target = 0.5;
  rangeMin = 0.15;
  rangeMax = 0.85;
  omega = 5;

  /** xNorm: centroid x / video width, 0..1 in raw (unmirrored) camera pixels. */
  setObservation(xNorm: number, mirrored: boolean): void {
    const x = mirrored ? 1 - xNorm : xNorm;
    const span = Math.max(0.05, this.rangeMax - this.rangeMin);
    this.target = Math.min(1, Math.max(0, (x - this.rangeMin) / span));
  }

  /** Directly set the target (ghost playback, scripted demo). */
  setTarget(u: number): void {
    this.target = Math.min(1, Math.max(0, u));
  }

  get targetU(): number {
    return this.target;
  }

  jump(u: number): void {
    this.u = this.target = u;
    this.v = 0;
  }

  update(dt: number): number {
    [this.u, this.v] = springStep(this.u, this.v, this.target, this.omega, dt);
    return this.u;
  }
}
