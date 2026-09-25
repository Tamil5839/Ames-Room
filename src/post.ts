import * as THREE from 'three';

/**
 * Final screen pass: gentle tone curve, warm grade, soft vignette, film grain,
 * and burned-in captions (so they end up in recordings, unlike the HTML UI).
 * Everything here is screen-space, so none of it can reveal the room's shape.
 */
export class PostFX {
  readonly target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly captionCanvas = document.createElement('canvas');
  private readonly captionTexture: THREE.CanvasTexture;
  private captionText = '';
  private captionKey = '';
  private width = 1;
  private height = 1;
  grain = 0.05;
  vignette = 0.55;
  captionOpacity = 0;

  constructor(samples: number) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples,
      depthBuffer: true,
    });
    this.captionTexture = new THREE.CanvasTexture(this.captionCanvas);
    this.captionTexture.colorSpace = THREE.NoColorSpace;
    this.captionTexture.minFilter = THREE.LinearFilter;
    this.captionTexture.generateMipmaps = false;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.target.texture },
        tCaption: { value: this.captionTexture },
        uCaption: { value: 0 },
        uTime: { value: 0 },
        uGrain: { value: 0.05 },
        uVignette: { value: 0.55 },
        uPulse: { value: 0 },
        uAspect: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene;
        uniform sampler2D tCaption;
        uniform float uCaption;
        uniform float uTime;
        uniform float uGrain;
        uniform float uVignette;
        uniform float uPulse;
        uniform float uAspect;
        varying vec2 vUv;
        float hash(vec3 p) {
          p = fract(p * vec3(443.897, 441.423, 437.195));
          p += dot(p, p.yxz + 19.19);
          return fract((p.x + p.y) * p.z);
        }
        vec3 shoulder(vec3 c) {
          const float t = 0.78;
          vec3 over = max(c - t, 0.0);
          return min(c, vec3(t)) + (1.0 - t) * (1.0 - exp(-over / (1.0 - t)));
        }
        vec3 toSRGB(vec3 c) {
          c = clamp(c, 0.0, 1.0);
          return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
        }
        void main() {
          vec3 c = texture2D(tScene, vUv).rgb;
          c = shoulder(c);
          // Warm vintage grade: lifted, slightly amber shadows; creamy highlights.
          c = c * vec3(1.02, 1.0, 0.95) + vec3(0.006, 0.004, 0.0);
          vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
          float r = length(q) / length(vec2(uAspect, 1.0) * 0.5);
          float vig = 1.0 - uVignette * smoothstep(0.35, 1.08, r) * (0.75 + 0.25 * r);
          vig *= 1.0 - uPulse * 0.25 * smoothstep(0.2, 1.0, r);
          c *= vig;
          vec3 s = toSRGB(c);
          float luma = dot(s, vec3(0.299, 0.587, 0.114));
          float n = hash(vec3(gl_FragCoord.xy, fract(uTime * 7.31) * 100.0)) + hash(vec3(gl_FragCoord.yx * 1.37, fract(uTime * 3.17) * 100.0)) - 1.0;
          s += n * uGrain * (0.35 + 0.65 * (1.0 - abs(luma - 0.45) * 1.6));
          vec4 cap = texture2D(tCaption, vUv);
          s = mix(s, cap.rgb, cap.a * uCaption);
          s += (hash(vec3(gl_FragCoord.xy, 7.0)) - 0.5) / 255.0;
          gl_FragColor = vec4(s, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.target.setSize(this.width, this.height);
    this.material.uniforms.uAspect.value = this.width / this.height;
    this.captionKey = '';
  }

  setCaption(text: string | null): void {
    this.captionText = text ?? this.captionText;
  }

  /** 0..1 flash of the vignette at the illusion-lock moment. */
  set pulse(v: number) {
    this.material.uniforms.uPulse.value = v;
  }

  private drawCaption(): void {
    const key = `${this.captionText}|${this.width}x${this.height}`;
    if (key === this.captionKey) return;
    this.captionKey = key;
    // Caption canvas at up to 1080p-equivalent resolution; it is stretched to the frame.
    const s = Math.min(1, 1920 / Math.max(this.width, this.height));
    const w = Math.max(2, Math.round(this.width * s));
    const h = Math.max(2, Math.round(this.height * s));
    const cv = this.captionCanvas;
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
      // GPU texture storage is immutable once allocated: drop it so it is re-created at the new size.
      this.captionTexture.dispose();
    }
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    const text = this.captionText;
    if (text) {
      const size = Math.round(Math.min(h * 0.058, w * 0.075));
      ctx.font = `italic ${size}px Georgia, "Times New Roman", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const lines = wrap(ctx, text, w * 0.84);
      const lh = size * 1.22;
      const y0 = h * (w < h ? 0.84 : 0.885) - (lines.length - 1) * lh;
      // Soft dark backing so the words stay legible over the checkerboard.
      const cy = y0 + ((lines.length - 1) * lh) / 2 - size * 0.3;
      const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
      ctx.save();
      ctx.translate(w / 2, cy);
      ctx.scale(Math.max(1, (tw * 0.75) / (size * 1.6)), 1);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 1.6 + (lines.length - 1) * lh);
      g.addColorStop(0, 'rgba(12, 8, 4, 0.42)');
      g.addColorStop(1, 'rgba(12, 8, 4, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(-size * 3.2, -size * 3.2 - lines.length * lh, size * 6.4, size * 6.4 + lines.length * lh * 2);
      ctx.restore();
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = size * 0.35;
      ctx.shadowOffsetY = size * 0.04;
      ctx.fillStyle = 'rgba(255, 244, 222, 1)';
      lines.forEach((line, i) => ctx.fillText(line, w / 2, y0 + i * lh));
    }
    this.captionTexture.needsUpdate = true;
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, time: number): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uGrain.value = this.grain;
    u.uVignette.value = this.vignette;
    u.uCaption.value = this.captionOpacity;
    if (this.captionOpacity > 0) this.drawCaption();
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}
