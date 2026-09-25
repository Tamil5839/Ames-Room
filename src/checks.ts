import * as THREE from 'three';
import { EYE, HALF_W, ROOM } from './config';
import { heroFov } from './camera';
import type { AmesRoom } from './room';
import type { AmesWarp } from './warp';

export interface AlignmentReport {
  label: string;
  ok: boolean;
  maxErrorPx: number;
  vertices: number;
  width: number;
  height: number;
}

/** A camera exactly on the hero pose for a given output size. */
export function makeHeroCamera(width: number, height: number, walkZ: number): THREE.PerspectiveCamera {
  const aspect = width / height;
  const cam = new THREE.PerspectiveCamera(heroFov(aspect, walkZ), aspect, 0.05, 400);
  cam.position.set(EYE.x, EYE.y, EYE.z);
  cam.lookAt(EYE.x, EYE.y, EYE.z - 10);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

/**
 * Projects every apparent-room vertex and its warped twin through the hero
 * camera and measures the pixel distance between them. It must stay < 0.5 px.
 */
export function checkAlignment(room: AmesRoom, camera: THREE.PerspectiveCamera, width: number, height: number, label: string): AlignmentReport {
  const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const e = viewProj.elements;
  let maxErr = 0;
  let count = 0;
  const project = (x: number, y: number, z: number, out: number[]) => {
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    out[0] = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * 0.5 * width;
    out[1] = ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5 * height;
    return w;
  };
  const a = [0, 0];
  const b = [0, 0];
  for (const { mesh, apparent } of room.warpedMeshes()) {
    const real = (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    for (let i = 0; i < apparent.length; i += 3) {
      const wa = project(apparent[i], apparent[i + 1], apparent[i + 2], a);
      const wb = project(real[i], real[i + 1], real[i + 2], b);
      if (wa <= camera.near || wb <= camera.near) continue; // behind the eye: never on screen
      const err = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (err > maxErr) maxErr = err;
      count++;
    }
  }
  return { label, ok: maxErr < 0.5 && count > 0, maxErrorPx: maxErr, vertices: count, width, height };
}

/** Ratio of apparent heights between the two ends of the walking line (≥ 2 wanted). */
export function walkingSizeRatio(warp: AmesWarp, walkZ: number, margin: number): number {
  const left = warp.factor({ x: -HALF_W + margin, y: 0, z: walkZ });
  const right = warp.factor({ x: HALF_W - margin, y: 0, z: walkZ });
  return left / right;
}

/** The hero frustum must never see past the room's front opening (z = 0). */
export function checkFrustumInside(camera: THREE.PerspectiveCamera): boolean {
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const tanH = tanV * camera.aspect;
  const floorHit = EYE.z - EYE.y / tanV;
  const ceilHit = EYE.z - (ROOM.height - EYE.y) / tanV;
  const wallHit = EYE.z - HALF_W / tanH;
  return floorHit < 0 && ceilHit < 0 && wallHit < 0;
}

export function runStartupChecks(room: AmesRoom, warp: AmesWarp, walkZ: number, walkMargin: number): AlignmentReport[] {
  const sizes: [string, number, number][] = [
    ['16:9', 1920, 1080],
    ['9:16', 1080, 1920],
    ['1:1', 1080, 1080],
  ];
  const reports: AlignmentReport[] = [];
  for (const [label, w, h] of sizes) {
    const cam = makeHeroCamera(w, h, walkZ);
    const r = checkAlignment(room, cam, w, h, label);
    reports.push(r);
    const inside = checkFrustumInside(cam);
    if (r.ok) {
      console.info(
        `%c[Ames] alignment ${label} ${w}x${h}: PASS — ${r.vertices} vertices, max error ${r.maxErrorPx.toExponential(2)} px (limit 0.5 px)`,
        'color:#3a9d5d',
      );
    } else {
      console.error(
        `[Ames] ALIGNMENT FAILED ${label} ${w}x${h}: max error ${r.maxErrorPx.toFixed(3)} px over ${r.vertices} vertices. ` +
          'The warped room does not project onto the apparent room from the hero eye.',
      );
    }
    if (!inside) console.error(`[Ames] hero frustum for ${label} sees past the room opening`);
  }
  const ratio = walkingSizeRatio(warp, walkZ, walkMargin);
  const msg = `[Ames] warp w=(${warp.w.x.toFixed(4)}, 0, ${warp.w.z.toFixed(4)}), corner factors ${warp.leftFactor.toFixed(2)} / ${warp.rightFactor.toFixed(2)}, min(1+w·X)=${warp
    .minDenominator(room.apparentBounds)
    .toFixed(3)}, apparent size change along the walking line ${ratio.toFixed(2)}x`;
  if (ratio >= 2) console.info(msg);
  else console.warn(`${msg} (below 2x: increase the warp factors)`);
  return reports;
}
