/**
 * The Ames warp: a central projective transform about the hero eye point E.
 *
 * For a point V of the apparent (rectangular) room, with X = V - E:
 *
 *     X' = X / (1 + w·X)        real vertex V' = E + X'
 *
 * X' is parallel to X, so every point stays on its own sight line from the eye
 * and the hero view is pixel-identical. The map is projective, so planes map to
 * planes and straight lines to straight lines: walls, floor, ceiling and window
 * frames stay flat and straight. w has no y component, so real verticals stay
 * vertical and a person standing upright in the real room also stands upright in
 * the apparent one.
 *
 * s(V) = 1 / (1 + w·X) is the distance factor: how many times farther from the
 * eye the real point is than the apparent one. Anything placed at V' appears
 * 1/s times its real size.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Box3Like {
  min: Vec3;
  max: Vec3;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

/** Smallest allowed value of 1 + w·X anywhere in the geometry (keeps the map far from its singular plane). */
export const MIN_DENOMINATOR = 0.12;

export class AmesWarp {
  readonly E: Vec3;
  /** w = (wx, 0, wz). */
  readonly w: Vec3 = vec3();
  /** Factors requested by the last successful solve (may be softened by `setFactors`). */
  leftFactor = 1;
  rightFactor = 1;
  /** Incremented on every change so dependents can cheaply detect updates. */
  version = 0;

  constructor(
    E: Vec3,
    /** Apparent back-left and back-right corners that the two factors refer to. */
    readonly backLeft: Vec3,
    readonly backRight: Vec3,
  ) {
    this.E = { ...E };
  }

  /**
   * Solves w = (wx, 0, wz) so that s(backLeft) = sL and s(backRight) = sR:
   *
   *     1 + wx·XL + wz·ZL = 1/sL
   *     1 + wx·XR + wz·ZR = 1/sR
   */
  static solveW(E: Vec3, backLeft: Vec3, backRight: Vec3, sL: number, sR: number): Vec3 {
    const xl = backLeft.x - E.x;
    const zl = backLeft.z - E.z;
    const xr = backRight.x - E.x;
    const zr = backRight.z - E.z;
    const bl = 1 / sL - 1;
    const br = 1 / sR - 1;
    const det = xl * zr - xr * zl;
    if (Math.abs(det) < 1e-9) throw new Error('AmesWarp: back corners are collinear with the eye; cannot solve w');
    return { x: (bl * zr - br * zl) / det, y: 0, z: (xl * br - xr * bl) / det };
  }

  /**
   * Sets the corner factors. If the result would push 1 + w·X below MIN_DENOMINATOR
   * anywhere inside `bounds`, the warp is softened (both factors pulled toward 1)
   * until it is valid. Returns the factors actually applied.
   */
  setFactors(sL: number, sR: number, bounds: Box3Like): { left: number; right: number; clamped: boolean } {
    const tryApply = (t: number) => {
      const l = 1 + (sL - 1) * t;
      const r = 1 + (sR - 1) * t;
      const w = AmesWarp.solveW(this.E, this.backLeft, this.backRight, l, r);
      return { l, r, w, min: minDenominator(this.E, w, bounds) };
    };
    let best = tryApply(1);
    let clamped = false;
    if (best.min < MIN_DENOMINATOR) {
      clamped = true;
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (tryApply(mid).min >= MIN_DENOMINATOR) lo = mid;
        else hi = mid;
      }
      best = tryApply(lo);
    }
    this.w.x = best.w.x;
    this.w.y = 0;
    this.w.z = best.w.z;
    this.leftFactor = best.l;
    this.rightFactor = best.r;
    this.version++;
    return { left: best.l, right: best.r, clamped };
  }

  /** 1 + w·(p - E) for an apparent point. */
  denominator(p: Vec3): number {
    return 1 + this.w.x * (p.x - this.E.x) + this.w.z * (p.z - this.E.z);
  }

  /** Distance factor s at an apparent point. */
  factor(p: Vec3): number {
    return 1 / this.denominator(p);
  }

  /** Apparent → real. */
  forward(p: Vec3, out: Vec3 = vec3()): Vec3 {
    const s = 1 / this.denominator(p);
    out.x = this.E.x + (p.x - this.E.x) * s;
    out.y = this.E.y + (p.y - this.E.y) * s;
    out.z = this.E.z + (p.z - this.E.z) * s;
    return out;
  }

  /** Real → apparent: X = X' / (1 - w·X'). */
  inverse(p: Vec3, out: Vec3 = vec3()): Vec3 {
    const q = 1 - this.w.x * (p.x - this.E.x) - this.w.z * (p.z - this.E.z);
    out.x = this.E.x + (p.x - this.E.x) / q;
    out.y = this.E.y + (p.y - this.E.y) / q;
    out.z = this.E.z + (p.z - this.E.z) / q;
    return out;
  }

  /** Distance factor at a real point (same value as `factor` at its apparent twin). */
  factorAtReal(p: Vec3): number {
    return 1 - this.w.x * (p.x - this.E.x) - this.w.z * (p.z - this.E.z);
  }

  /** Warps packed xyz triples: dst[i] = forward(src[i]). Returns the smallest denominator seen. */
  forwardArray(src: ArrayLike<number>, dst: Float32Array | number[]): number {
    const { x: ex, y: ey, z: ez } = this.E;
    const wx = this.w.x;
    const wz = this.w.z;
    let min = Infinity;
    for (let i = 0; i < src.length; i += 3) {
      const X = src[i] - ex;
      const Y = src[i + 1] - ey;
      const Z = src[i + 2] - ez;
      const d = 1 + wx * X + wz * Z;
      if (d < min) min = d;
      const s = 1 / d;
      dst[i] = ex + X * s;
      dst[i + 1] = ey + Y * s;
      dst[i + 2] = ez + Z * s;
    }
    return min;
  }

  minDenominator(bounds: Box3Like): number {
    return minDenominator(this.E, this.w, bounds);
  }
}

/** 1 + w·X is linear, so its minimum over a box is attained at one of the corners. */
export function minDenominator(E: Vec3, w: Vec3, b: Box3Like): number {
  let min = Infinity;
  for (const x of [b.min.x, b.max.x]) {
    for (const y of [b.min.y, b.max.y]) {
      for (const z of [b.min.z, b.max.z]) {
        const d = 1 + w.x * (x - E.x) + w.y * (y - E.y) + w.z * (z - E.z);
        if (d < min) min = d;
      }
    }
  }
  return min;
}

/** Angle in radians between the sight lines E→p and E→q. */
export function sightLineAngle(E: Vec3, p: Vec3, q: Vec3): number {
  const ax = p.x - E.x, ay = p.y - E.y, az = p.z - E.z;
  const bx = q.x - E.x, by = q.y - E.y, bz = q.z - E.z;
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  const cross = Math.hypot(cx, cy, cz);
  const dot = ax * bx + ay * by + az * bz;
  return Math.atan2(cross, dot);
}
