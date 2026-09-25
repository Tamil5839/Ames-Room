import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraRig, heroFov } from '../src/camera';
import { checkFrustumInside, makeHeroCamera } from '../src/checks';
import { BACK_LEFT, BACK_RIGHT, DEFAULT_SETTINGS, EYE, HALF_W, ROOM } from '../src/config';
import { AmesWarp, vec3 } from '../src/warp';
import { walkLine, walkPoint } from '../src/walk';

const bounds = { min: vec3(-HALF_W, 0, -ROOM.depth - 0.3), max: vec3(HALF_W, ROOM.height, 0) };

function setup() {
  const warp = new AmesWarp(EYE, BACK_LEFT, BACK_RIGHT);
  warp.setFactors(DEFAULT_SETTINGS.leftFactor, DEFAULT_SETTINGS.rightFactor, bounds);
  const line = walkLine(DEFAULT_SETTINGS.walkDepth, DEFAULT_SETTINGS.walkMargin);
  const rig = new CameraRig();
  rig.setWalk(line.z, DEFAULT_SETTINGS.walkMargin);
  rig.setWarp(warp);
  rig.setAspect(16 / 9);
  return { warp, line, rig };
}

describe('hero camera', () => {
  it('sits exactly on the eye point and looks straight down the room', () => {
    const { rig } = setup();
    const c = rig.camera;
    expect(c.position.toArray()).toEqual([EYE.x, EYE.y, EYE.z]);
    const dir = c.getWorldDirection(new THREE.Vector3());
    expect(dir.z).toBeCloseTo(-1, 12);
  });

  it('never sees past the room opening, for every recording aspect and common screens', () => {
    for (const [w, h] of [[1920, 1080], [1080, 1920], [1080, 1080], [1440, 900], [2560, 1080], [390, 844]]) {
      const cam = makeHeroCamera(w, h, -ROOM.depth + DEFAULT_SETTINGS.walkDepth);
      expect(checkFrustumInside(cam)).toBe(true);
    }
  });

  it('keeps the whole walking line in frame in portrait', () => {
    const walkZ = -ROOM.depth + DEFAULT_SETTINGS.walkDepth;
    const fov = heroFov(9 / 16, walkZ);
    const tanH = Math.tan((fov / 2) * (Math.PI / 180)) * (9 / 16);
    expect(tanH * (EYE.z - walkZ)).toBeGreaterThanOrEqual(HALF_W);
  });
});

describe('reveal camera', () => {
  it('ends equally far from both ends of the walking line (same apparent size)', () => {
    const { warp, line, rig } = setup();
    const p = rig.revealPose().position;
    const a = warp.forward(walkPoint(line, 0));
    const b = warp.forward(walkPoint(line, 1));
    const da = p.distanceTo(new THREE.Vector3(a.x, a.y, a.z));
    const db = p.distanceTo(new THREE.Vector3(b.x, b.y, b.z));
    expect(Math.abs(da - db) / da).toBeLessThan(0.01);
  });

  it('swings roughly 60-80 degrees around the room and rises above it', () => {
    const { warp, rig } = setup();
    const corners: THREE.Vector3[] = [];
    for (const x of [-HALF_W, HALF_W]) for (const z of [0, -ROOM.depth]) {
      const r = warp.forward({ x, y: 0, z });
      corners.push(new THREE.Vector3(r.x, 0, r.z));
    }
    const center = corners.reduce((s, v) => s.add(v), new THREE.Vector3()).multiplyScalar(1 / 4);
    const p = rig.revealPose().position;
    const az = (v: THREE.Vector3) => Math.atan2(v.x - center.x, v.z - center.z);
    const swing = Math.abs(az(p) - az(new THREE.Vector3(EYE.x, EYE.y, EYE.z))) * (180 / Math.PI);
    expect(swing).toBeGreaterThan(55);
    expect(swing).toBeLessThan(85);
    expect(p.y).toBeGreaterThan(ROOM.height);
  });
});
