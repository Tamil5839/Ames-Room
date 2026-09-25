import * as THREE from 'three';
import { EYE } from './config';
import { MASK_SIZE, type MaskStats } from './maskproc';
import type { PersonFrame } from './segment';
import type { AmesRoom } from './room';
import { counterDepth } from './room';
import type { AmesWarp } from './warp';
import { walkPoint, type WalkLine } from './walk';

/**
 * The cutout person: a vertical card of fixed REAL height standing on the real
 * (warped) floor. Nothing ever scales it: the warped room's perspective alone
 * makes it look tiny in the far corner and huge in the near one.
 */

export type BodyModeResolved = 'full' | 'upper';

/** Typical adult shoulder width (with arms), used to calibrate scale in upper-body mode. */
export const SHOULDER_WIDTH_M = 0.46;

/** Card rectangle relative to the feet anchor (metres, card-local) and its source region (ROI image coords, v down). */
export interface CardLayout {
  xl: number;
  xr: number;
  yb: number;
  yt: number;
  uL: number;
  uR: number;
  vT: number;
  vB: number;
}

export interface TrackerSettings {
  personHeight: number;
  mirror: boolean;
  bodyMode: 'auto' | 'full' | 'upper';
  lockScale: boolean;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/**
 * Turns per-frame mask statistics into steady card parameters: scale (metres
 * per video pixel), feet anchor, crop box, and full-body vs upper-body mode.
 */
export class BodyTracker {
  mode: BodyModeResolved = 'full';
  /** Metres per video pixel. */
  mpp = 0;
  found = false;
  /** Horizontal position of the person in the frame, 0..1 (raw camera pixels). */
  xNorm = 0.5;
  /** Scale is frozen (user lock, ghost take or recording). */
  frozen = false;
  private readonly heights: number[] = [];
  private readonly shoulders: number[] = [];
  private modeVotes = 0;
  private anchorX = 0;
  private anchorY = 0;
  private crop = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private hasCrop = false;
  private lastFrameTime = 0;

  reset(): void {
    this.heights.length = 0;
    this.shoulders.length = 0;
    this.hasCrop = false;
    this.mpp = 0;
    this.found = false;
  }

  /** Re-estimate the scale from scratch (e.g. after "recalibrate"). */
  recalibrate(): void {
    this.heights.length = 0;
    this.shoulders.length = 0;
    this.mpp = 0;
  }

  update(frame: PersonFrame, s: TrackerSettings): void {
    const st = frame.stats;
    const dt = this.lastFrameTime ? Math.min(0.25, (frame.time - this.lastFrameTime) / 1000) : 1 / 30;
    this.lastFrameTime = frame.time;
    this.found = st.found;
    if (!st.found) return;
    this.xNorm = st.cx / frame.videoW;

    // Full body vs upper body (feet cut off by the frame), with ~0.6 s of hysteresis.
    let mode: BodyModeResolved = this.mode;
    if (s.bodyMode === 'full' || s.bodyMode === 'upper') {
      mode = s.bodyMode;
    } else {
      const want: BodyModeResolved = st.touchesBottom ? 'upper' : 'full';
      this.modeVotes = want === this.mode ? 0 : this.modeVotes + dt;
      if (this.modeVotes > 0.6) mode = want;
    }
    if (mode !== this.mode) {
      this.mode = mode;
      this.modeVotes = 0;
      this.hasCrop = false;
      if (!this.frozen) this.recalibrate();
    }

    // Scale: the person's standing height (or shoulder width) in pixels, robust median over ~2.5 s.
    if (!this.frozen && !s.lockScale) {
      let target = 0;
      if (this.mode === 'full') {
        const hPx = st.feetY - st.headY;
        if (hPx > 20) this.heights.push(hPx);
        if (this.heights.length > 75) this.heights.shift();
        if (this.heights.length) target = s.personHeight / median(this.heights);
      } else {
        if (st.shoulderW > 10) this.shoulders.push(st.shoulderW);
        if (this.shoulders.length > 75) this.shoulders.shift();
        if (this.shoulders.length) target = SHOULDER_WIDTH_M / median(this.shoulders);
      }
      if (target > 0) this.mpp = this.mpp ? this.mpp + (target - this.mpp) * (1 - Math.exp(-dt * 2.5)) : target;
    }

    // Anchor: the feet (full body) or the bottom cut of the frame (upper body).
    const ax = this.mode === 'full' ? st.feetX : (st.x0 + st.x1) / 2;
    const ay = this.mode === 'full' ? st.feetY : Math.min(st.y1, frame.videoH);
    if (!this.hasCrop) {
      this.anchorX = ax;
      this.anchorY = ay;
    } else {
      this.anchorX += (ax - this.anchorX) * 0.6;
      this.anchorY += (ay - this.anchorY) * 0.5;
    }

    // Crop: padded bounding box, grows at once and shrinks slowly, clamped to the ROI.
    const h = Math.max(1, st.y1 - st.y0);
    const pad = h * 0.1;
    const want = { x0: st.x0 - pad, y0: st.y0 - pad * 0.6, x1: st.x1 + pad, y1: st.y1 + pad * 0.4 };
    if (!this.hasCrop) {
      this.crop = want;
      this.hasCrop = true;
    } else {
      const c = this.crop;
      const k = 0.08;
      c.x0 = want.x0 < c.x0 ? want.x0 : c.x0 + (want.x0 - c.x0) * k;
      c.y0 = want.y0 < c.y0 ? want.y0 : c.y0 + (want.y0 - c.y0) * k;
      c.x1 = want.x1 > c.x1 ? want.x1 : c.x1 + (want.x1 - c.x1) * k;
      c.y1 = want.y1 > c.y1 ? want.y1 : c.y1 + (want.y1 - c.y1) * k;
    }
    const r = frame.roi;
    this.crop.x0 = Math.max(this.crop.x0, r.x);
    this.crop.y0 = Math.max(this.crop.y0, r.y);
    this.crop.x1 = Math.min(this.crop.x1, r.x + r.size);
    this.crop.y1 = Math.min(this.crop.y1, r.y + r.size, frame.videoH);
  }

  /** Card rectangle (metres around the feet) and the matching region of the ROI textures. */
  layout(frame: PersonFrame, mirror: boolean): CardLayout | null {
    if (!this.hasCrop || this.mpp <= 0) return null;
    const { roi } = frame;
    const c = this.crop;
    const sign = mirror ? -1 : 1;
    const xa = sign * (c.x0 - this.anchorX) * this.mpp;
    const xb = sign * (c.x1 - this.anchorX) * this.mpp;
    const ua = (c.x0 - roi.x) / roi.size;
    const ub = (c.x1 - roi.x) / roi.size;
    return {
      xl: Math.min(xa, xb),
      xr: Math.max(xa, xb),
      uL: mirror ? ub : ua,
      uR: mirror ? ua : ub,
      yt: (this.anchorY - c.y0) * this.mpp,
      yb: (this.anchorY - c.y1) * this.mpp,
      vT: (c.y0 - roi.y) / roi.size,
      vB: (c.y1 - roi.y) / roi.size,
    };
  }
}

// ------------------------------------------------------------------ card shader

export const cardVertex = /* glsl */ `
uniform vec4 uRect;   // xl, yb, xr, yt (metres, card-local)
uniform vec4 uUvRect; // uL, vB, uR, vT (source image coords, v down)
varying vec2 vUv;
varying float vY;
void main() {
  vec2 p = mix(uRect.xy, uRect.zw, uv);
  vUv = mix(uUvRect.xy, uUvRect.zw, uv);
  vY = uv.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}
`;

export const cardFragment = /* glsl */ `
uniform float uOpacity;
uniform vec3 uTint;
uniform float uBright;
uniform float uSat;
uniform float uFootShade;
varying vec2 vUv;
varying float vY;
#ifdef GHOST
  precision highp sampler2DArray;
  uniform sampler2DArray tLayers;
  uniform float uLayer;
#else
  uniform sampler2D tColor;
  uniform sampler2D tMask;
  uniform float uFeather;
  uniform float uErode;
  uniform vec2 uTexel;
#endif

vec4 cutout(vec2 uv) {
#ifdef GHOST
  return texture(tLayers, vec3(uv, uLayer));
#else
  // Feathered, slightly eroded mask: a small cross blur, then a soft threshold.
  vec2 o = uTexel * mix(0.6, 2.2, uFeather);
  float m = texture2D(tMask, uv).r * 0.4
    + (texture2D(tMask, uv + vec2(o.x, 0.0)).r + texture2D(tMask, uv - vec2(o.x, 0.0)).r
     + texture2D(tMask, uv + vec2(0.0, o.y)).r + texture2D(tMask, uv - vec2(0.0, o.y)).r) * 0.15;
  float thr = 0.5 + uErode * 0.32;
  float w = mix(0.035, 0.24, uFeather);
  float a = smoothstep(thr - w, thr + w, m);
  vec3 c = texture2D(tColor, uv).rgb;
  // Colour match to the room: gentle desaturation, warm tint, brightness.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat) * uTint * uBright;
  return vec4(c * a, a);
#endif
}

void main() {
  if (vUv.x < 0.0 || vUv.x > 1.0 || vUv.y < 0.0 || vUv.y > 1.0) discard;
  vec4 c = cutout(vUv);
  // A touch of darkening toward the feet (the floor's ambient occlusion).
  c.rgb *= 1.0 - uFootShade * (1.0 - smoothstep(0.0, 0.14, vY));
  c *= uOpacity;
  if (c.a < 0.004) discard;
  gl_FragColor = c;
}
`;

export interface CardLook {
  warmth: number;
  brightness: number;
  saturation: number;
  feather: number;
  erode: number;
}

export function tintFor(warmth: number): THREE.Vector3 {
  return new THREE.Vector3(1 + 0.08 * warmth, 1 + 0.01 * warmth, 1 - 0.12 * warmth);
}

/** Where a person stands this frame, derived from the walking-line parameter. */
export interface PersonPose {
  u: number;
  layout: CardLayout;
  mode: BodyModeResolved;
  opacity: number;
}

export class PersonCard {
  readonly object = new THREE.Group();
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  readonly material: THREE.ShaderMaterial;
  /** Footprint ring for the reveal and top views (where the card is seen edge-on). */
  readonly marker: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  /** Real-space feet position (on the real floor) after `place`. */
  readonly feet = new THREE.Vector3();
  /** Apparent-space feet position and distance factor after `place`. */
  readonly apparentFeet = new THREE.Vector3();
  factor = 1;
  lift = 0;
  visible = false;
  private readonly rect = new THREE.Vector4();
  private readonly uvRect = new THREE.Vector4();

  constructor(ghost: boolean, name: string) {
    this.material = new THREE.ShaderMaterial({
      name,
      defines: ghost ? { GHOST: 1 } : {},
      uniforms: {
        uRect: { value: this.rect },
        uUvRect: { value: this.uvRect },
        uOpacity: { value: 0 },
        uTint: { value: tintFor(0.35) },
        uBright: { value: 1 },
        uSat: { value: 0.9 },
        uFootShade: { value: 0.18 },
        tColor: { value: null },
        tMask: { value: null },
        tLayers: { value: null },
        uLayer: { value: 0 },
        uFeather: { value: 0.5 },
        uErode: { value: 0.35 },
        uTexel: { value: new THREE.Vector2(1 / MASK_SIZE, 1 / MASK_SIZE) },
      },
      vertexShader: cardVertex,
      fragmentShader: cardFragment,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = name;
    this.object.add(this.mesh);
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.3, 40),
      new THREE.MeshBasicMaterial({ color: ghost ? 0x35e4ff : 0xffd27a, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.position.y = 0.02;
    this.marker.renderOrder = 20;
    this.marker.frustumCulled = false;
    this.object.add(this.marker);
    this.object.visible = false;
  }

  /** Footprint opacity (0 in the hero view). */
  setMarker(opacity: number): void {
    this.marker.material.opacity = opacity;
    this.marker.visible = opacity > 0.01;
  }

  setLook(look: CardLook): void {
    const u = this.material.uniforms;
    u.uTint.value.copy(tintFor(look.warmth));
    u.uBright.value = look.brightness;
    u.uSat.value = look.saturation;
    u.uFeather.value = look.feather;
    u.uErode.value = look.erode;
  }

  /**
   * Stands the card on the real floor at walking-line position u, facing the
   * camera around its vertical axis (a cylindrical billboard).
   */
  place(pose: PersonPose, ctx: PlaceContext): void {
    const { warp, room, line, camera } = ctx;
    const a = walkPoint(line, pose.u);
    this.apparentFeet.set(a.x, a.y, a.z);
    const real = warp.forward(a);
    this.factor = warp.factor(a);
    // Raycast down onto the warped floor mesh for the floor height under the feet.
    const floorY = room.floorHeightAt(real.x, real.z, real.y);
    this.feet.set(real.x, floorY, real.z);

    let lift = 0.002;
    if (pose.mode === 'upper') {
      // Hide the bottom cut behind the counter: find how high the counter's front
      // edge hides things at the walking line (seen from the eye), then put the
      // cut a little below that, in real metres (verticals scale by s).
      const { zFront } = counterDepth(ctx.walkDepth);
      const h = ctx.counterHeight;
      const hidden = EYE.y + (h - EYE.y) * ((EYE.z - line.z) / (EYE.z - zFront));
      lift = Math.max(0.05, hidden - 0.07) * this.factor - pose.layout.yb;
    }
    this.lift = lift;

    const L = pose.layout;
    this.rect.set(L.xl, L.yb + lift, L.xr, L.yt + lift);
    this.uvRect.set(L.uL, L.vB, L.uR, L.vT);
    this.object.position.copy(this.feet);
    const dx = camera.position.x - this.feet.x;
    const dz = camera.position.z - this.feet.z;
    if (dx * dx + dz * dz > 1e-6) this.object.rotation.set(0, Math.atan2(dx, dz), 0);
    this.material.uniforms.uOpacity.value = pose.opacity;
    this.visible = pose.opacity > 0.003;
    this.object.visible = this.visible;
  }

  /** Height of the top of the card above the real floor, in metres. */
  topHeight(): number {
    return this.rect.w;
  }

  halfWidth(): number {
    return Math.max(0.12, Math.min(0.45, (this.rect.z - this.rect.x) * 0.35));
  }
}

export interface PlaceContext {
  warp: AmesWarp;
  room: AmesRoom;
  line: WalkLine;
  camera: THREE.Camera;
  walkDepth: number;
  counterHeight: number;
}

/** Live person textures (colour crop + mask), updated whenever a new frame arrives. */
export class LiveTextures {
  readonly color: THREE.Texture;
  readonly mask: THREE.DataTexture;
  private current: ImageBitmap | null = null;
  private retired: ImageBitmap[] = [];
  frame: PersonFrame | null = null;

  constructor() {
    this.color = new THREE.Texture();
    this.color.colorSpace = THREE.SRGBColorSpace;
    this.color.flipY = false;
    this.color.generateMipmaps = false;
    this.color.minFilter = THREE.LinearFilter;
    this.color.magFilter = THREE.LinearFilter;
    this.mask = new THREE.DataTexture(new Uint8Array(MASK_SIZE * MASK_SIZE), MASK_SIZE, MASK_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
    this.mask.flipY = false;
    this.mask.minFilter = THREE.LinearFilter;
    this.mask.magFilter = THREE.LinearFilter;
    this.mask.generateMipmaps = false;
    this.mask.needsUpdate = true;
  }

  /** Takes ownership of the frame's bitmap. */
  set(frame: PersonFrame): void {
    // Bitmaps already uploaded in an earlier render can be released now.
    for (const b of this.retired) b.close();
    this.retired = [];
    if (this.current) this.retired.push(this.current);
    this.current = frame.color;
    this.frame = frame;
    this.color.image = frame.color;
    this.color.needsUpdate = true;
    (this.mask.image as { data: Uint8Array }).data = frame.mask;
    this.mask.needsUpdate = true;
  }

  get stats(): MaskStats | null {
    return this.frame?.stats ?? null;
  }
}
