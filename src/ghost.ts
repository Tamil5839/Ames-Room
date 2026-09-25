import * as THREE from 'three';
import { cardFragment, PersonCard, type BodyModeResolved, type CardLayout, type PersonPose } from './person';
import type { LiveTextures } from './person';

/**
 * Two of me: records a 10 s take of the live cutout (frames baked into array
 * texture layers on the GPU, plus positions) and replays it in a loop as a
 * second person in the room.
 */

export const GHOST_SECONDS = 10;
const GHOST_W = 192;
const GHOST_H = 384;
const CHUNK = 150;

interface GhostFrame {
  t: number;
  u: number;
  mode: BodyModeResolved;
  layout: CardLayout; // metres; uv fields hold the frame's rectangle inside its layer
  chunk: number;
  layer: number;
}

const bakeVertex = /* glsl */ `
uniform vec4 uRect;   // target rectangle in the layer, NDC (x0, y0, x1, y1)
uniform vec4 uUvRect; // source rectangle in the live ROI textures (uL, vB, uR, vT)
varying vec2 vUv;
varying float vY;
void main() {
  vUv = mix(uUvRect.xy, uUvRect.zw, uv);
  vY = uv.y;
  gl_Position = vec4(mix(uRect.xy, uRect.zw, uv), 0.0, 1.0);
}
`;

export type GhostState = 'empty' | 'recording' | 'ready';

export class Ghost {
  state: GhostState = 'empty';
  readonly card = new PersonCard(true, 'ghost-card');
  /** Director mode hides the ghost until its entrance. */
  shown = true;
  private frames: GhostFrame[] = [];
  private chunks: THREE.WebGLArrayRenderTarget[] = [];
  private recordStart = 0;
  private playStart = 0;
  private fade = 0;
  private readonly bakeScene = new THREE.Scene();
  private readonly bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly bakeMaterial: THREE.ShaderMaterial;
  private readonly maxLayers: number;
  onFinished: (() => void) | null = null;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.maxLayers = Math.max(16, Math.min(CHUNK, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number));
    this.bakeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uRect: { value: new THREE.Vector4() },
        uUvRect: { value: new THREE.Vector4() },
        uOpacity: { value: 1 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uBright: { value: 1 },
        uSat: { value: 1 },
        uFootShade: { value: 0 },
        tColor: { value: null },
        tMask: { value: null },
        uFeather: { value: 0.5 },
        uErode: { value: 0.35 },
        uTexel: { value: new THREE.Vector2(1 / 256, 1 / 256) },
      },
      vertexShader: bakeVertex,
      fragmentShader: cardFragment,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bakeMaterial);
    quad.frustumCulled = false;
    this.bakeScene.add(quad);
  }

  get recordingProgress(): number {
    return this.state === 'recording' ? Math.min(1, (performance.now() - this.recordStart) / (GHOST_SECONDS * 1000)) : 0;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  startRecording(): void {
    this.clear();
    this.state = 'recording';
    this.recordStart = performance.now();
  }

  /** Copies the look of the live card (grading, feather) into the bake pass. */
  syncLook(live: PersonCard): void {
    const src = live.material.uniforms;
    const dst = this.bakeMaterial.uniforms;
    for (const k of ['uTint', 'uBright', 'uSat', 'uFeather', 'uErode'] as const) {
      const v = src[k].value;
      dst[k].value = v instanceof THREE.Vector3 ? v.clone() : v;
    }
  }

  private target(chunk: number): THREE.WebGLArrayRenderTarget {
    let rt = this.chunks[chunk];
    if (!rt) {
      rt = new THREE.WebGLArrayRenderTarget(GHOST_W, GHOST_H, this.maxLayers, { depthBuffer: false });
      rt.texture.colorSpace = THREE.SRGBColorSpace;
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      rt.texture.generateMipmaps = false;
      this.chunks[chunk] = rt;
    }
    return rt;
  }

  /** Adds the current live frame to the take. Call once per new segmentation frame. */
  addFrame(live: LiveTextures, layout: CardLayout, u: number, mode: BodyModeResolved, liveCard: PersonCard): void {
    if (this.state !== 'recording') return;
    const now = performance.now();
    if (now - this.recordStart >= GHOST_SECONDS * 1000) {
      this.finish();
      return;
    }
    const index = this.frames.length;
    const chunk = Math.floor(index / this.maxLayers);
    const layer = index % this.maxLayers;
    const rt = this.target(chunk);

    // Fit the card's aspect into the layer, bottom-centred (feet at the bottom).
    const cw = layout.xr - layout.xl;
    const ch = layout.yt - layout.yb;
    const layerAspect = GHOST_W / GHOST_H;
    let w = 1;
    let h = 1;
    if (cw / ch > layerAspect) h = (ch / cw) * layerAspect;
    else w = (cw / ch) / layerAspect;
    const x0 = (1 - w) / 2;
    const y0 = 0.0;
    this.syncLook(liveCard);
    const um = this.bakeMaterial.uniforms;
    um.tColor.value = live.color;
    um.tMask.value = live.mask;
    (um.uRect.value as THREE.Vector4).set(x0 * 2 - 1, y0 * 2 - 1, (x0 + w) * 2 - 1, (y0 + h) * 2 - 1);
    (um.uUvRect.value as THREE.Vector4).set(layout.uL, layout.vB, layout.uR, layout.vT);

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(rt, layer);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this.bakeScene, this.bakeCamera);
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);

    this.frames.push({
      t: now - this.recordStart,
      u,
      mode,
      chunk,
      layer,
      layout: { ...layout, uL: x0, uR: x0 + w, vB: y0, vT: y0 + h },
    });
  }

  /** Ends the take early (or when the 10 s are up) and starts the replay loop. */
  finish(): void {
    if (this.state !== 'recording') return;
    if (this.frames.length < 5) {
      this.clear();
    } else {
      this.state = 'ready';
      this.restart();
    }
    this.onFinished?.();
  }

  restart(): void {
    this.playStart = performance.now();
    this.fade = 0;
  }

  clear(): void {
    for (const rt of this.chunks) rt.dispose();
    this.chunks = [];
    this.frames = [];
    this.state = 'empty';
    this.card.object.visible = false;
    this.card.visible = false;
  }

  /** Current replay pose, or null when there is nothing to show. */
  update(dt: number): PersonPose | null {
    if (this.state !== 'ready' || this.frames.length === 0) return null;
    this.fade = Math.min(1, this.fade + dt / 0.45) * (this.shown ? 1 : 0);
    const duration = this.frames[this.frames.length - 1].t + 1000 / 30;
    const t = (performance.now() - this.playStart) % duration;
    // Frames are time-stamped, so playback speed matches the take even if segmentation ran slower.
    let lo = 0;
    let hi = this.frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.frames[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    const f = this.frames[lo];
    const u = this.card.material.uniforms;
    u.tLayers.value = this.chunks[f.chunk].texture;
    u.uLayer.value = f.layer;
    return { u: f.u, layout: f.layout, mode: f.mode, opacity: this.fade };
  }
}
