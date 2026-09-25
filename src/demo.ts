import { MASK_SIZE, RoiTracker, maskStats, type Roi } from './maskproc';
import { captureRoi, snapRoi, type PersonFrame, type PersonSource } from './segment';

/**
 * A synthetic performer for trying the app without a webcam (and for automated
 * tests). It renders a simple person into a fake 1280x720 "camera" frame and
 * produces a pixel-exact mask, then goes through the same ROI crop / mask
 * statistics path as the real camera. Its position is in raw camera pixels:
 * like a real person facing the camera, "your left" is the image's right.
 */

const W = 1280;
const H = 720;

export type DemoAction = 'auto' | 'left' | 'right' | 'center' | 'walkRight' | 'walkLeft' | 'wave' | 'lookDown' | 'idle';

interface Pose {
  x: number; // raw frame x of the feet
  phase: number; // walk cycle
  speed: number; // px/s (signed)
  wave: number; // 0..1 right arm raised
  lookDown: number; // 0..1
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export class DemoSource implements PersonSource {
  readonly kind = 'demo' as const;
  status = 'Demo performer';
  fps = 0;
  /** Mirror setting of the app, so "left" always means the room's left. */
  mirrored = true;
  private readonly frame = makeCanvas(W, H);
  private readonly person = makeCanvas(W, H);
  private readonly maskCanvas = makeCanvas(MASK_SIZE, MASK_SIZE);
  private readonly roiTracker = new RoiTracker();
  private latest: PersonFrame | null = null;
  private stopped = false;
  private inFlight = false;
  private last = performance.now();
  private lastSubmit = 0;
  private id = 0;
  private fpsCount = 0;
  private fpsT0 = performance.now();
  private raf = 0;
  private readonly pose: Pose = { x: W * 0.5, phase: 0, speed: 0, wave: 0, lookDown: 0 };
  private targetX = W * 0.5;
  private walkSpeed = 150;
  private waveTarget = 0;
  private lookTarget = 0;
  private action: DemoAction = 'auto';
  private actionT = 0;
  private keys = { left: false, right: false };
  /** Height of the performer in frame pixels (feet to top of head). */
  private readonly heightPx = 560;
  private readonly feetY = 668;

  constructor() {
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Room-left (far, tiny corner) is raw-frame right when the image is mirrored. */
  private rawFromRoom(u: number): number {
    // Slightly past the default webcam range, so the ends of the walking line are reached.
    const x = 0.12 + 0.76 * u;
    return (this.mirrored ? 1 - x : x) * W;
  }

  perform(action: DemoAction): void {
    this.action = action;
    this.actionT = 0;
    this.waveTarget = 0;
    this.lookTarget = 0;
    this.walkSpeed = 150;
    switch (action) {
      case 'left':
        this.targetX = this.rawFromRoom(0);
        this.walkSpeed = 420;
        break;
      case 'right':
        this.targetX = this.rawFromRoom(1);
        this.walkSpeed = 420;
        break;
      case 'center':
        this.targetX = this.rawFromRoom(0.5);
        break;
      case 'walkRight':
        this.targetX = this.rawFromRoom(1);
        this.walkSpeed = 150;
        break;
      case 'walkLeft':
        this.targetX = this.rawFromRoom(0);
        this.walkSpeed = 150;
        break;
      case 'wave':
        this.waveTarget = 1;
        this.targetX = this.pose.x;
        break;
      case 'lookDown':
        this.lookTarget = 1;
        this.targetX = this.pose.x;
        break;
      default:
        this.targetX = this.pose.x;
    }
  }

  /** Arrow-key control (room directions). */
  setKey(key: 'left' | 'right', down: boolean): void {
    this.keys[key] = down;
    if (down && this.action === 'auto') this.action = 'idle';
  }

  toggleWave(): void {
    this.waveTarget = this.waveTarget > 0.5 ? 0 : 1;
  }

  private autoScript(t: number): void {
    // 16 s loop: far corner + wave, slow walk to the near corner, look down, back.
    const T = t % 16;
    this.lookTarget = 0;
    this.waveTarget = 0;
    if (T < 2.5) {
      this.targetX = this.rawFromRoom(0.02);
      this.walkSpeed = 380;
    } else if (T < 4.5) {
      this.waveTarget = 1;
    } else if (T < 11) {
      this.targetX = this.rawFromRoom(0.98);
      this.walkSpeed = 140;
    } else if (T < 13.5) {
      this.lookTarget = 1;
    } else {
      this.targetX = this.rawFromRoom(0.5);
      this.walkSpeed = 300;
    }
  }

  private loop(now: number): void {
    if (this.stopped) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.actionT += dt;
    if (this.action === 'auto') this.autoScript(this.actionT);
    const roomDir = this.mirrored ? -1 : 1;
    if (this.keys.left) this.targetX = Math.max(W * 0.12, Math.min(W * 0.88, this.pose.x - roomDir * 260 * dt * 1.4));
    if (this.keys.right) this.targetX = Math.max(W * 0.12, Math.min(W * 0.88, this.pose.x + roomDir * 260 * dt * 1.4));
    const p = this.pose;
    const dx = this.targetX - p.x;
    const step = Math.sign(dx) * Math.min(Math.abs(dx), this.walkSpeed * dt);
    p.speed = step / Math.max(dt, 1e-3);
    p.x += step;
    const moving = Math.min(1, Math.abs(p.speed) / 120);
    p.phase += dt * (2.2 + Math.abs(p.speed) / 90) * moving;
    p.wave += (this.waveTarget - p.wave) * Math.min(1, dt * 5);
    p.lookDown += (this.lookTarget - p.lookDown) * Math.min(1, dt * 4);
    // "Capture" at ~30 fps.
    if (!this.inFlight && now - this.lastSubmit >= 1000 / 30 - 4) {
      this.lastSubmit = now;
      this.inFlight = true;
      void this.capture(now).finally(() => (this.inFlight = false));
    }
  }

  private draw(): void {
    const fctx = this.frame.getContext('2d') as Ctx;
    const pctx = this.person.getContext('2d') as Ctx;
    // Plain wall behind the performer.
    const g = fctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#c9c3b8');
    g.addColorStop(1, '#a9a399');
    fctx.fillStyle = g;
    fctx.fillRect(0, 0, W, H);
    pctx.clearRect(0, 0, W, H);
    drawPerson(pctx, this.pose, this.heightPx, this.feetY);
    fctx.drawImage(this.person as CanvasImageSource, 0, 0);
  }

  private async capture(now: number): Promise<void> {
    this.draw();
    const roi = snapRoi(this.roiTracker.current(W, H));
    const [color, small] = await captureRoi(this.frame as unknown as HTMLCanvasElement, roi);
    small.close();
    const mask = this.maskFor(roi);
    const stats = maskStats(mask, roi, W, H);
    this.roiTracker.update(stats, W, H);
    if (this.stopped) {
      color.close();
      return;
    }
    this.latest?.color.close();
    this.latest = { id: ++this.id, time: now, color, mask, roi, videoW: W, videoH: H, stats };
    this.fpsCount++;
    if (now - this.fpsT0 >= 1000) {
      this.fps = (this.fpsCount * 1000) / (now - this.fpsT0);
      this.fpsCount = 0;
      this.fpsT0 = now;
    }
  }

  private maskFor(roi: Roi): Uint8Array {
    const ctx = this.maskCanvas.getContext('2d', { willReadFrequently: true }) as Ctx;
    ctx.clearRect(0, 0, MASK_SIZE, MASK_SIZE);
    ctx.drawImage(this.person as CanvasImageSource, roi.x, roi.y, roi.size, roi.size, 0, 0, MASK_SIZE, MASK_SIZE);
    const data = ctx.getImageData(0, 0, MASK_SIZE, MASK_SIZE).data;
    const mask = new Uint8Array(MASK_SIZE * MASK_SIZE);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3];
    return mask;
  }

  take(): PersonFrame | null {
    const f = this.latest;
    this.latest = null;
    return f;
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    this.latest?.color.close();
    this.latest = null;
  }
}

// ------------------------------------------------------------------ figure

function limb(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, width: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** Two-segment limb from a joint with angles (radians from straight down). */
function arm(ctx: Ctx, sx: number, sy: number, a1: number, a2: number, l1: number, l2: number, w: number, sleeve: string, skin: string): void {
  const ex = sx + Math.sin(a1) * l1;
  const ey = sy + Math.cos(a1) * l1;
  const hx = ex + Math.sin(a2) * l2;
  const hy = ey + Math.cos(a2) * l2;
  limb(ctx, sx, sy, ex, ey, w, sleeve);
  limb(ctx, ex, ey, hx, hy, w * 0.9, sleeve);
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(hx + Math.sin(a2) * w * 0.35, hy + Math.cos(a2) * w * 0.35, w * 0.42, w * 0.55, -a2, 0, Math.PI * 2);
  ctx.fill();
}

function drawPerson(ctx: Ctx, p: Pose, height: number, feetY: number): void {
  const u = height / 7.6; // one head height
  const x = p.x;
  const top = feetY - height;
  const skin = '#d7a17b';
  const sweater = '#2f6f73';
  const trousers = '#2a2d38';
  const walk = Math.sin(p.phase * Math.PI);
  const bob = Math.abs(Math.cos(p.phase * Math.PI)) * u * 0.05;
  const hipY = top + u * 3.75 + bob;
  const shoulderY = top + u * 1.45 + bob;
  const headCy = top + u * 0.55 + bob + p.lookDown * u * 0.12;

  // Legs (side-step from the front: feet spread and close).
  const spread = u * (0.34 + 0.22 * walk);
  for (const s of [-1, 1]) {
    const hx = x + s * u * 0.36;
    const fx = x + s * spread;
    const lift = s * walk > 0 ? Math.abs(walk) * u * 0.12 : 0;
    const kx = (hx + fx) / 2 + s * u * 0.05;
    const ky = (hipY + feetY) / 2;
    limb(ctx, hx, hipY, kx, ky, u * 0.62, trousers);
    limb(ctx, kx, ky, fx, feetY - u * 0.2 - lift, u * 0.52, trousers);
    ctx.fillStyle = '#18181a';
    ctx.beginPath();
    ctx.ellipse(fx + s * u * 0.05, feetY - u * 0.12 - lift, u * 0.32, u * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Torso.
  const tg = ctx.createLinearGradient(x - u, 0, x + u, 0);
  tg.addColorStop(0, '#255a5d');
  tg.addColorStop(0.5, sweater);
  tg.addColorStop(1, '#244f52');
  ctx.fillStyle = tg;
  ctx.beginPath();
  ctx.moveTo(x - u * 0.95, shoulderY + u * 0.1);
  ctx.quadraticCurveTo(x, shoulderY - u * 0.2, x + u * 0.95, shoulderY + u * 0.1);
  ctx.lineTo(x + u * 0.78, hipY + u * 0.1);
  ctx.quadraticCurveTo(x, hipY + u * 0.3, x - u * 0.78, hipY + u * 0.1);
  ctx.closePath();
  ctx.fill();

  // Arms: swing while walking; the right arm (image left) waves when asked.
  const swing = walk * 0.25;
  arm(ctx, x + u * 0.86, shoulderY + u * 0.25, 0.12 - swing, 0.05 - swing * 0.6, u * 1.45, u * 1.25, u * 0.4, sweater, skin);
  const wa = p.wave;
  const wob = Math.sin(performance.now() / 160) * 0.35 * wa;
  arm(
    ctx,
    x - u * 0.86,
    shoulderY + u * 0.25,
    -0.12 + swing + wa * (-2.35 + 0.12 - swing),
    -0.05 + swing * 0.6 + wa * (-2.9 + wob),
    u * 1.45,
    u * 1.25,
    u * 0.4,
    sweater,
    skin,
  );

  // Neck and head.
  limb(ctx, x, shoulderY - u * 0.05, x, headCy + u * 0.45, u * 0.34, skin);
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(x, headCy, u * 0.4, u * 0.52, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2b1d14';
  ctx.beginPath();
  ctx.ellipse(x, headCy - u * 0.2, u * 0.43, u * 0.36, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(x - u * 0.43, headCy - u * 0.22, u * 0.1, u * 0.35);
  ctx.fillRect(x + u * 0.33, headCy - u * 0.22, u * 0.1, u * 0.35);
  // A hint of a face (eyes, smile), looking down when asked.
  const ey = headCy + u * 0.02 + p.lookDown * u * 0.08;
  ctx.fillStyle = '#3a2418';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + s * u * 0.15, ey, u * 0.045, u * (0.035 - p.lookDown * 0.015), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#8c4a3a';
  ctx.lineWidth = u * 0.04;
  ctx.beginPath();
  ctx.arc(x, headCy + u * 0.16 + p.lookDown * u * 0.06, u * 0.13, 0.2 * Math.PI, 0.8 * Math.PI);
  ctx.stroke();
}
