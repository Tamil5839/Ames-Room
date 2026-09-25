import * as THREE from 'three';
import { EYE, HALF_W, HERO_HALF_WIDTH_AT_WALK, HERO_MIN_VFOV_DEG, ROOM } from './config';
import type { AmesWarp } from './warp';

export type ViewName = 'hero' | 'reveal' | 'top';

export interface Pose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  fov: number;
}

const DEG = Math.PI / 180;
/** How high the reveal camera rises above the room (degrees of elevation). */
const REVEAL_ELEVATION = 24 * DEG;

/**
 * Hero vertical FOV for an aspect ratio. The eye point never moves (that is what
 * keeps the illusion exact); only the frustum adapts: at least HERO_MIN_VFOV_DEG
 * vertically, and wide enough that the whole walking line fits horizontally.
 */
export function heroFov(aspect: number, walkZ: number): number {
  const dist = EYE.z - walkZ;
  const tanH = HERO_HALF_WIDTH_AT_WALK / dist;
  const tanVFromWidth = tanH / aspect;
  const tanVFromHeight = (Math.max(ROOM.height - EYE.y, EYE.y) * 1.12) / dist;
  const tanV = Math.max(Math.tan((HERO_MIN_VFOV_DEG / 2) * DEG), tanVFromWidth, tanVFromHeight);
  return (2 * Math.atan(tanV)) / DEG;
}

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Anim {
  from: Pose;
  to: Pose;
  toView: ViewName;
  t: number;
  duration: number;
  pivot: THREE.Vector3;
}

/** Spherical coordinates of p around a pivot: azimuth around +y from +z, elevation, radius. */
function toSpherical(p: THREE.Vector3, pivot: THREE.Vector3) {
  const d = p.clone().sub(pivot);
  const r = d.length();
  return { az: Math.atan2(d.x, d.z), el: Math.asin(THREE.MathUtils.clamp(d.y / Math.max(r, 1e-9), -1, 1)), r };
}

function fromSpherical(az: number, el: number, r: number, pivot: THREE.Vector3, out = new THREE.Vector3()) {
  return out.set(pivot.x + r * Math.cos(el) * Math.sin(az), pivot.y + r * Math.sin(el), pivot.z + r * Math.cos(el) * Math.cos(az));
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  view: ViewName = 'hero';
  /** True while the camera sits exactly on the hero pose. */
  locked = true;
  onLock: (() => void) | null = null;
  onViewChange: ((view: ViewName, moving: boolean) => void) | null = null;

  private aspect = 16 / 9;
  private walkZ = -4.55;
  private walkMargin = 0.3;
  private anim: Anim | null = null;
  private settleT = -1;
  private drift = 0;
  private warp: AmesWarp | null = null;
  private readonly orbitOffset = { az: 0, el: 0 };

  constructor() {
    this.camera = new THREE.PerspectiveCamera(50, this.aspect, 0.05, 400);
    this.applyPose(this.heroPose());
  }

  setWarp(warp: AmesWarp): void {
    this.warp = warp;
    if (this.view !== 'hero' && !this.anim) this.applyPose(this.poseFor(this.view));
  }

  setWalk(z: number, margin: number): void {
    this.walkZ = z;
    this.walkMargin = margin;
    if (this.view === 'hero' && !this.anim) this.applyPose(this.heroPose());
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.camera.aspect = aspect;
    if (this.anim) {
      this.anim.to = this.poseFor(this.anim.toView);
    } else {
      this.applyPose(this.poseFor(this.view));
    }
  }

  heroPose(): Pose {
    return {
      position: new THREE.Vector3(EYE.x, EYE.y, EYE.z),
      target: new THREE.Vector3(EYE.x, EYE.y, EYE.z - 10),
      up: new THREE.Vector3(0, 1, 0),
      fov: heroFov(this.aspect, this.walkZ),
    };
  }

  /** Real-space points that describe the warped room (for framing the reveal and top views). */
  private realCorners(): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    if (!this.warp) return pts;
    for (const x of [-HALF_W, HALF_W]) {
      for (const y of [0, ROOM.height]) {
        for (const z of [0, -ROOM.depth]) {
          const r = this.warp.forward({ x, y, z });
          pts.push(new THREE.Vector3(r.x, r.y, r.z));
        }
      }
    }
    return pts;
  }

  /** Orbit pivot: middle of the real walking line, a little above the floor. */
  pivot(): THREE.Vector3 {
    if (!this.warp) return new THREE.Vector3(0, 1.2, -3);
    const a = this.warp.forward({ x: -HALF_W, y: 1.2, z: this.walkZ });
    const b = this.warp.forward({ x: HALF_W, y: 1.2, z: this.walkZ });
    const c = this.warp.forward({ x: 0, y: 1.2, z: -ROOM.depth / 2 });
    return new THREE.Vector3((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3);
  }

  /** Real positions of the two ends of the walking line (feet). */
  private walkEnds(): [THREE.Vector3, THREE.Vector3] {
    const w = this.warp;
    if (!w) return [new THREE.Vector3(-3, 0, -4.5), new THREE.Vector3(3, 0, -4.5)];
    const a = w.forward({ x: -HALF_W + this.walkMargin, y: 0, z: this.walkZ });
    const b = w.forward({ x: HALF_W - this.walkMargin, y: 0, z: this.walkZ });
    return [new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z)];
  }

  /**
   * The reveal: rise and swing to the side until the camera is equally far from
   * both ends of the walking line. From there two people of the same real size
   * look the same size, while the room around them is obviously a trapezoid.
   */
  revealPose(): Pose {
    const [L, R] = this.walkEnds();
    const mid = L.clone().add(R).multiplyScalar(0.5);
    const target = mid.clone().add(new THREE.Vector3(0, 0.95, 0));
    const el = THREE.MathUtils.clamp(REVEAL_ELEVATION + this.orbitOffset.el, 4 * DEG, 80 * DEG);
    // Directions d (unit, elevation el) with d·(R - L) = 0 are equidistant from both ends.
    const lr = R.clone().sub(L);
    const rho = Math.hypot(lr.x, lr.z);
    const phi0 = Math.atan2(lr.x, lr.z);
    const c = THREE.MathUtils.clamp((-Math.tan(el) * lr.y) / Math.max(rho, 1e-6), -1, 1);
    const cands = [phi0 + Math.acos(c), phi0 - Math.acos(c)];
    // Pick the solution on the viewer's side of the room (closest to the hero direction).
    const heroAz = Math.atan2(EYE.x - target.x, EYE.z - target.z);
    cands.sort((a, b) => Math.abs(wrapAngle(a - heroAz)) - Math.abs(wrapAngle(b - heroAz)));
    const az = cands[0] + this.drift * DEG + this.orbitOffset.az;
    const fov = 40;
    const r = this.fitRadius(target, az, el, fov);
    return { position: fromSpherical(az, el, r, target), target, up: new THREE.Vector3(0, 1, 0), fov };
  }

  topPose(): Pose {
    const pts = this.realCorners();
    pts.push(new THREE.Vector3(EYE.x, EYE.y, EYE.z));
    const box = new THREE.Box3().setFromPoints(pts);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const fov = 14; // narrow and far: close to the flat look of a plan drawing
    const tanV = Math.tan((fov / 2) * DEG);
    // Screen up is -z, so the plan's depth runs vertically and its width horizontally.
    const need = Math.max((size.z * 0.5 * 1.12) / tanV, (size.x * 0.5 * 1.12) / (tanV * this.aspect));
    const position = new THREE.Vector3(center.x, box.max.y + need, center.z);
    return { position, target: new THREE.Vector3(center.x, box.min.y, center.z), up: new THREE.Vector3(0, 0, -1), fov };
  }

  /** Distance from the pivot at which the whole real room fits in the frame. */
  private fitRadius(pivot: THREE.Vector3, az: number, el: number, fov: number): number {
    const pts = this.realCorners();
    const dir = fromSpherical(az, el, 1, new THREE.Vector3()).normalize(); // pivot → camera
    const forward = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    const tanV = Math.tan((fov / 2) * DEG) / 1.08;
    const tanH = tanV * this.aspect;
    let r = 1;
    for (const p of pts) {
      const d = p.clone().sub(pivot);
      const x = Math.abs(d.dot(right));
      const y = Math.abs(d.dot(up));
      const z = d.dot(forward); // positive = beyond the pivot
      r = Math.max(r, x / tanH - z, y / tanV - z);
    }
    return r;
  }

  poseFor(view: ViewName): Pose {
    if (view === 'reveal') return this.revealPose();
    if (view === 'top') return this.topPose();
    return this.heroPose();
  }

  currentPose(): Pose {
    const c = this.camera;
    const dir = new THREE.Vector3();
    c.getWorldDirection(dir);
    return { position: c.position.clone(), target: c.position.clone().add(dir.multiplyScalar(10)), up: c.up.clone(), fov: c.fov };
  }

  get moving(): boolean {
    return this.anim !== null;
  }

  goTo(view: ViewName, duration = view === 'hero' ? 2.6 : 3.2): void {
    if (view === this.view && !this.anim) return;
    const from = this.currentPose();
    this.orbitOffset.az = 0;
    this.orbitOffset.el = 0;
    this.drift = 0;
    this.anim = { from, to: this.poseFor(view), toView: view, t: 0, duration, pivot: this.pivot() };
    this.view = view;
    this.locked = false;
    this.settleT = -1;
    this.onViewChange?.(view, true);
  }

  /** Drag-to-orbit while away from the hero pose. */
  nudgeOrbit(dAz: number, dEl: number): void {
    if (this.view !== 'reveal' || this.anim) return;
    this.orbitOffset.az += dAz;
    this.orbitOffset.el = THREE.MathUtils.clamp(this.orbitOffset.el + dEl, -24 * DEG, 60 * DEG);
    this.applyPose(this.revealPose());
  }

  update(dt: number): void {
    const a = this.anim;
    if (a) {
      a.t = Math.min(1, a.t + dt / a.duration);
      // Keep chasing the live target pose (the aspect or the warp may change mid-move).
      a.to = this.poseFor(a.toView);
      if (a.t >= 1) {
        this.anim = null;
        // Lock the final frame exactly on the destination pose (no easing residue).
        this.applyPose(a.to);
        if (a.toView === 'hero') {
          this.locked = true;
          this.settleT = 0;
          this.onLock?.();
        }
        this.onViewChange?.(a.toView, false);
      } else {
        this.applyPose(this.interpolate(a, easeInOutCubic(a.t)));
      }
      return;
    }
    if (this.view === 'reveal') {
      // A slow drift keeps the reveal shot alive.
      this.drift += dt * 0.8;
      this.applyPose(this.revealPose());
    }
    if (this.view === 'hero' && this.settleT >= 0) {
      // "Illusion lock": a tiny damped zoom settle. The eye point never moves, so
      // the room stays pixel-exact through the whole settle.
      this.settleT += dt;
      const t = this.settleT;
      const base = this.heroPose();
      const k = t < 0.6 ? Math.sin(t * 2 * Math.PI * 4.2) * Math.exp(-t * 9) * 0.018 : 0;
      this.camera.fov = base.fov * (1 + k);
      this.camera.updateProjectionMatrix();
      if (t >= 0.6) {
        this.settleT = -1;
        this.applyPose(base);
      }
    }
  }

  private interpolate(a: Anim, t: number): Pose {
    const pivot = a.pivot;
    const s0 = toSpherical(a.from.position, pivot);
    const s1 = toSpherical(a.to.position, pivot);
    const az = s0.az + wrapAngle(s1.az - s0.az) * t;
    // Rise a little extra mid-move so the swing reads as an orbit rather than a slide.
    const el = s0.el + (s1.el - s0.el) * t + Math.sin(Math.PI * t) * 6 * DEG * (a.toView === 'top' ? 0 : 1);
    const r = s0.r + (s1.r - s0.r) * t;
    const position = fromSpherical(az, el, r, pivot);
    const target = a.from.target.clone().lerp(a.to.target, t);
    const up = a.from.up.clone().lerp(a.to.up, t).normalize();
    return { position, target, up, fov: a.from.fov + (a.to.fov - a.from.fov) * t };
  }

  applyPose(p: Pose): void {
    const c = this.camera;
    c.position.copy(p.position);
    c.up.copy(p.up);
    c.lookAt(p.target);
    c.fov = p.fov;
    c.aspect = this.aspect;
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
  }

  /** 0 on the hero pose, 1 once the camera has clearly left the eye point. */
  revealAmount(): number {
    const d = this.camera.position.distanceTo(new THREE.Vector3(EYE.x, EYE.y, EYE.z));
    return THREE.MathUtils.smoothstep(d, 0.05, 1.6);
  }
}
