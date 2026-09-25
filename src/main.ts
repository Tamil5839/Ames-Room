import * as THREE from 'three';
import './style.css';
import { BACK_LEFT, BACK_RIGHT, EYE, RECORD_SIZES, loadSettings, saveSettings, type Settings } from './config';
import { AmesWarp } from './warp';
import { AmesRoom } from './room';
import { CameraRig, type ViewName } from './camera';
import { PostFX } from './post';
import { runStartupChecks, walkingSizeRatio } from './checks';
import { BodyTracker, LiveTextures, PersonCard, type CardLayout, type PlaceContext } from './person';
import { WalkMapper, walkLine, walkPoint, type WalkLine } from './walk';
import { CameraSource, listCameras, openCamera, type PersonFrame, type PersonSource } from './segment';
import { DemoSource, type DemoAction } from './demo';
import { Ghost, GHOST_SECONDS } from './ghost';
import { Recorder, canRecord } from './recorder';
import { Director } from './director';
import { Sfx } from './audio';
import { UI, resetSettings } from './ui';
import { MASK_SIZE } from './maskproc';

// ------------------------------------------------------------------ core objects

const settings = loadSettings();
const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
renderer.setPixelRatio(1);
renderer.setClearColor(0x0b0a09, 1);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0a09);

const warp = new AmesWarp(EYE, BACK_LEFT, BACK_RIGHT);
const room = new AmesRoom(settings.roomStyle);
const rig = new CameraRig();
const post = new PostFX(4);
const live = new LiveTextures();
const liveCard = new PersonCard(false, 'live-card');
liveCard.material.uniforms.tColor.value = live.color;
liveCard.material.uniforms.tMask.value = live.mask;
const ghost = new Ghost(renderer);
const tracker = new BodyTracker();
const walker = new WalkMapper();
const sfx = new Sfx();
const recorder = new Recorder();
const video = document.createElement('video');
video.playsInline = true;
video.muted = true;
// Kept in the DOM (invisible): some browsers don't decode frames for detached videos.
video.setAttribute('aria-hidden', 'true');
Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
document.body.append(video);

let line: WalkLine = walkLine(settings.walkDepth, settings.walkMargin);
let source: PersonSource | null = null;
let layout: CardLayout | null = null;
let lastFrame: PersonFrame | null = null;
let presence = 0;
let recordSize: [number, number] | null = null;
let countdownAbort: (() => void) | null = null;
let lockPulse = 0;
/** Auto exposure for the cutout: nudges the person's mean brightness toward the room's. */
let exposure = 1;
const PERSON_TARGET_LUM = 0.2;
let caption: { text: string | null; opacity: number } = { text: null, opacity: 0 };

const walkHelper = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false, depthWrite: false, transparent: true }),
);
walkHelper.renderOrder = 1001;
walkHelper.frustumCulled = false;

/**
 * Diagram overlay for the reveal and top views: dashed sight lines from the eye to
 * each person's feet and head, and rings where each person APPEARS to stand in
 * the imagined room (on the same sight line, 1/s times closer and smaller).
 */
const sightMat = new THREE.LineDashedMaterial({ color: 0xfff0d0, dashSize: 0.16, gapSize: 0.12, transparent: true, depthTest: false, depthWrite: false });
const sightRays = new THREE.LineSegments(new THREE.BufferGeometry(), sightMat);
sightRays.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3));
sightRays.geometry.setAttribute('lineDistance', new THREE.BufferAttribute(new Float32Array(8), 1));
sightRays.frustumCulled = false;
sightRays.renderOrder = 15;
const apparentRings = [0xffd27a, 0x35e4ff].map((color) => {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.24, 0.28, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 16;
  ring.frustumCulled = false;
  return ring;
});

function updateSightDiagram(opacity: number): void {
  const pos = sightRays.geometry.getAttribute('position') as THREE.BufferAttribute;
  const cards = [liveCard, ghost.card];
  let n = 0;
  cards.forEach((card, i) => {
    const ring = apparentRings[i];
    const on = card.visible && opacity > 0.01;
    ring.visible = on;
    if (!on) return;
    for (const h of [0, card.topHeight()]) {
      pos.setXYZ(n++, EYE.x, EYE.y, EYE.z);
      pos.setXYZ(n++, card.feet.x, card.feet.y + h, card.feet.z);
    }
    ring.position.set(card.apparentFeet.x, 0.01, card.apparentFeet.z);
    ring.scale.setScalar(1 / card.factor);
    ring.material.opacity = opacity * 0.9;
  });
  for (let i = n; i < 8; i++) pos.setXYZ(i, EYE.x, EYE.y, EYE.z);
  pos.needsUpdate = true;
  // Dashes measured from the eye (updated in place rather than reallocated every frame).
  const dist = sightRays.geometry.getAttribute('lineDistance') as THREE.BufferAttribute;
  for (let i = 0; i < 8; i += 2) {
    dist.setX(i, 0);
    dist.setX(i + 1, Math.hypot(pos.getX(i + 1) - pos.getX(i), pos.getY(i + 1) - pos.getY(i), pos.getZ(i + 1) - pos.getZ(i)));
  }
  dist.needsUpdate = true;
  sightRays.visible = n > 0;
  sightMat.opacity = opacity * 0.75;
}

scene.add(room.object, liveCard.object, ghost.card.object, room.wireframe, walkHelper, room.diagram, sightRays, ...apparentRings);

// ------------------------------------------------------------------ UI

const ui = new UI(document.getElementById('ui')!, settings, {
  onReveal: () => toggleReveal(),
  onTop: () => rig.goTo(rig.view === 'top' ? 'hero' : 'top'),
  onGhost: () => void ghostAction(),
  onClearGhost: () => {
    ghost.clear();
    ui.toast('Ghost cleared');
  },
  onRecord: () => void recordAction(),
  onDirector: () => void directorAction(),
  onStartCamera: (id) => void startCamera(id),
  onStartDemo: () => startDemo(),
  onSwitchSource: (id) => {
    if (id === 'demo' || id === 'demo-upper') startDemo(id === 'demo' ? 'full' : 'upper');
    else void startCamera(id || undefined);
  },
  onSettingChange: (key) => applySettings(key),
  onRecalibrate: () => {
    tracker.recalibrate();
    ui.toast('Stand tall with your whole body in view: recalibrating');
  },
  onRunChecks: () => {
    const reports = runStartupChecks(room, warp, line.z, settings.walkMargin);
    const worst = Math.max(...reports.map((r) => r.maxErrorPx));
    ui.toast(reports.every((r) => r.ok) ? `Alignment check passed: max error ${worst.toExponential(1)} px` : 'Alignment check FAILED (see console)');
  },
  onResetSettings: () => {
    resetSettings(settings);
    ui.refreshGui();
    applySettings();
  },
});

const director = new Director({
  startRecording: () => startRecording(),
  stopRecording: () => void stopRecording(),
  cancelRecording: () => cancelRecording(),
  setCaption: (text, opacity) => (caption = { text, opacity }),
  setCue: (text, sub) => ui.setCue(text, sub),
  setProgress: (t, total) => ui.setProgress(t, total),
  goTo: (view, d) => rig.goTo(view, d),
  hasGhost: () => ghost.state === 'ready',
  showGhost: (show, restart) => {
    ghost.shown = show;
    if (restart) ghost.restart();
  },
  perform: (a: DemoAction) => {
    if (source instanceof DemoSource) source.perform(a);
  },
  finished: () => {
    ui.setDirectorActive(false);
    if (source instanceof DemoSource) source.perform('auto');
  },
});

// ------------------------------------------------------------------ settings

function applyWarp(): void {
  const res = warp.setFactors(settings.leftFactor, settings.rightFactor, room.apparentBounds);
  if (res.clamped) {
    settings.leftFactor = +res.left.toFixed(2);
    settings.rightFactor = +res.right.toFixed(2);
    ui.refreshGui();
    ui.toast('That warp would fold the room through the eye: softened it');
  }
  room.applyWarp(warp);
  rig.setWarp(warp);
}

function updateWalkHelper(): void {
  const a = walkPoint(line, 0);
  const b = walkPoint(line, 1);
  walkHelper.geometry.dispose();
  walkHelper.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x, 0.004, a.z), new THREE.Vector3(b.x, 0.004, b.z)]);
}

function applySettings(key?: keyof Settings): void {
  const all = key === undefined;
  if (all || key === 'leftFactor' || key === 'rightFactor') applyWarp();
  if (all || key === 'roomStyle') room.setStyle(settings.roomStyle);
  if (all || key === 'walkDepth' || key === 'walkMargin') {
    line = walkLine(settings.walkDepth, settings.walkMargin);
    rig.setWalk(line.z, settings.walkMargin);
    updateWalkHelper();
  }
  ui.setSizeChange(walkingSizeRatio(warp, line.z, settings.walkMargin));
  walker.rangeMin = settings.walkRangeMin;
  walker.rangeMax = settings.walkRangeMax;
  walker.omega = settings.walkSpring;
  liveCard.setLook({
    warmth: settings.personWarmth,
    brightness: settings.personBrightness,
    saturation: settings.personSaturation,
    feather: settings.maskFeather,
    erode: settings.maskErode,
  });
  post.grain = settings.grain ? settings.grainAmount : 0;
  post.vignette = settings.vignette;
  room.wireframe.visible = settings.debugWireframe;
  walkHelper.visible = settings.debugWireframe;
  if (key === 'mirror' && source instanceof DemoSource) source.mirrored = settings.mirror;
  if (key === 'bodyMode') tracker.recalibrate();
  if (key === 'segModel' && source instanceof CameraSource) {
    ui.toast(`Loading the ${settings.segModel} model…`);
    void source.setModel(settings.segModel).catch((err) => ui.toast(`Model failed to load: ${err}`));
  }
  if (all || key === 'aspect') resize();
  saveSettings(settings);
}

// ------------------------------------------------------------------ sizing

const ASPECT: Record<Exclude<Settings['aspect'], 'fill'>, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 };

function fillRecordSize(): [number, number] {
  const a = window.innerWidth / window.innerHeight;
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return a >= 1 ? [1920, even(1920 / a)] : [even(1920 * a), 1920];
}

function resize(): void {
  const ww = window.innerWidth;
  const wh = window.innerHeight;
  let cw = ww;
  let ch = wh;
  const aspect = recordSize ? recordSize[0] / recordSize[1] : settings.aspect === 'fill' ? ww / wh : ASPECT[settings.aspect];
  if (Math.abs(aspect - ww / wh) > 1e-3) {
    if (ww / wh > aspect) {
      ch = wh;
      cw = wh * aspect;
    } else {
      cw = ww;
      ch = ww / aspect;
    }
  }
  canvas.style.width = `${Math.round(cw)}px`;
  canvas.style.height = `${Math.round(ch)}px`;
  const pr = Math.min(window.devicePixelRatio || 1, 1.75);
  const [bw, bh] = recordSize ?? [Math.max(2, Math.round(cw * pr)), Math.max(2, Math.round(ch * pr))];
  renderer.setSize(bw, bh, false);
  post.setSize(bw, bh);
  rig.setAspect(bw / bh);
}
window.addEventListener('resize', resize);

// ------------------------------------------------------------------ sources

function setSource(s: PersonSource): void {
  source?.stop();
  source = s;
  tracker.reset();
  presence = 0;
  layout = null;
  if (s instanceof DemoSource) s.mirrored = settings.mirror;
}

async function startCamera(deviceId?: string): Promise<void> {
  sfx.unlock();
  ui.setOnboardingBusy(true);
  ui.setOnboardingError(null);
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs a secure context (https or localhost).');
    // Release the current source first: some cameras can't be opened twice.
    source?.stop();
    source = null;
    const stream = await openCamera({ deviceId });
    video.srcObject = stream;
    await video.play();
    const cams = await listCameras();
    const active = stream.getVideoTracks()[0]?.getSettings().deviceId;
    ui.setCameras(cams, active);
    ui.setSources(cams, active ?? '');
    const cam = new CameraSource(video, () => settings.maskSmoothing, settings.segModel);
    setSource(cam);
    ui.hideOnboarding();
    ui.toast('Step back until your whole body is in view');
    await cam.start();
  } catch (err) {
    console.error('[Ames] camera start failed', err);
    const name = (err as DOMException)?.name;
    const msg =
      name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow it in the address bar, or try the demo performer.'
        : name === 'NotFoundError'
          ? 'No camera found. Plug one in (or connect your phone), or try the demo performer.'
          : `Could not start: ${(err as Error)?.message ?? err}`;
    if (source instanceof CameraSource) {
      source.stop();
      source = null;
    }
    ui.setOnboardingError(msg);
    ui.showOnboarding();
  } finally {
    ui.setOnboardingBusy(false);
  }
}

function startDemo(framing: 'full' | 'upper' = 'full'): void {
  sfx.unlock();
  setSource(new DemoSource(framing));
  void listCameras()
    .then((cams) => ui.setSources(cams, framing === 'full' ? 'demo' : 'demo-upper'))
    .catch(() => ui.setSources([], framing === 'full' ? 'demo' : 'demo-upper'));
  ui.hideOnboarding();
  ui.toast('Demo performer: ← → to move, W to wave (or let it wander)');
}

// ------------------------------------------------------------------ actions

function toggleReveal(): void {
  rig.goTo(rig.view === 'hero' ? 'reveal' : 'hero');
}

function countdown(seconds: number, cue?: [string, string]): Promise<boolean> {
  return new Promise((resolve) => {
    let n = seconds;
    let timer = 0;
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      countdownAbort = null;
      ui.countdown(null);
      if (cue) ui.setCue(null);
      resolve(ok);
    };
    countdownAbort = () => finish(false);
    if (cue) ui.setCue(cue[0], cue[1]);
    const step = () => {
      if (n === 0) {
        sfx.tick(true);
        finish(true);
        return;
      }
      ui.countdown(n);
      sfx.tick(false);
      n--;
      timer = window.setTimeout(step, 1000);
    };
    step();
  });
}

async function startRecording(): Promise<boolean> {
  if (!canRecord()) {
    ui.toast('Recording is not supported in this browser');
    return false;
  }
  if (recorder.recording || countdownAbort) return false;
  sfx.unlock();
  recordSize = settings.aspect === 'fill' ? fillRecordSize() : RECORD_SIZES[settings.aspect];
  resize();
  tracker.frozen = true;
  const ok = await countdown(3);
  if (!ok) {
    recordSize = null;
    resize();
    tracker.frozen = ghost.state === 'recording';
    return false;
  }
  try {
    const mime = recorder.start(canvas, settings.recordSound ? sfx.stream() : null, 30);
    console.info(`[Ames] recording ${canvas.width}x${canvas.height} as ${mime}`);
    ui.setRecording(true, 0);
    return true;
  } catch (err) {
    ui.toast(String((err as Error).message ?? err));
    recordSize = null;
    resize();
    tracker.frozen = false;
    return false;
  }
}

async function stopRecording(): Promise<void> {
  if (!recorder.recording) return;
  try {
    const result = await recorder.stop();
    ui.showResult(result);
    (window as unknown as { __lastRecording?: unknown }).__lastRecording = result;
  } catch (err) {
    ui.toast(String((err as Error).message ?? err));
  } finally {
    recordSize = null;
    resize();
    tracker.frozen = ghost.state === 'recording';
    ui.setRecording(false, 0);
  }
}

function cancelRecording(): void {
  countdownAbort?.();
  recorder.cancel();
  recordSize = null;
  resize();
  tracker.frozen = ghost.state === 'recording';
  ui.setRecording(false, 0);
}

async function recordAction(): Promise<void> {
  if (director.active) {
    director.cancel();
    return;
  }
  if (recorder.recording) await stopRecording();
  else await startRecording();
}

async function directorAction(): Promise<void> {
  if (director.active) {
    director.cancel();
    ui.setDirectorActive(false);
    ui.toast('Director mode cancelled');
    return;
  }
  if (!source) {
    ui.toast('Start the camera (or the demo) first');
    return;
  }
  if (recorder.recording) await stopRecording();
  ui.setDirectorActive(true);
  await director.start();
  if (!director.active) ui.setDirectorActive(false);
}

async function ghostAction(): Promise<void> {
  if (ghost.state === 'recording') {
    ghost.finish();
    return;
  }
  if (!source) {
    ui.toast('Start the camera (or the demo) first');
    return;
  }
  if (countdownAbort) return;
  if (source instanceof DemoSource) source.perform('left');
  const ok = await countdown(3, ['Ghost take: go to the far LEFT corner', 'then wave up at your future self']);
  if (!ok) return;
  if (source instanceof DemoSource) source.perform('wave');
  tracker.frozen = true;
  ghost.startRecording();
  ui.setCue('Recording your ghost — wave!', `${GHOST_SECONDS} seconds`);
}

ghost.onFinished = () => {
  ui.setCue(null);
  tracker.frozen = recorder.recording;
  if (ghost.state === 'ready') {
    ui.toast('Ghost ready. Now stand in the near (right) corner and look down at it', 4200);
    if (source instanceof DemoSource) source.perform('auto');
  } else {
    ui.toast('Ghost take was empty: make sure you are in the frame');
  }
};

rig.onLock = () => {
  sfx.click();
  lockPulse = 1;
};
rig.onViewChange = (view, moving) => ui.setLock(!moving && view === 'hero', view);

// ------------------------------------------------------------------ input

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return;
  const demo = source instanceof DemoSource ? source : null;
  switch (e.code) {
    case 'Escape':
      if (countdownAbort) countdownAbort();
      else if (director.active) void directorAction();
      else ui.hideResult();
      return;
    case 'ArrowLeft':
      demo?.setKey('left', true);
      break;
    case 'ArrowRight':
      demo?.setKey('right', true);
      break;
  }
  if (ui.modalOpen || e.repeat) return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      toggleReveal();
      break;
    case 'KeyT':
      rig.goTo(rig.view === 'top' ? 'hero' : 'top');
      break;
    case 'KeyG':
      void ghostAction();
      break;
    case 'KeyX':
    case 'Backspace':
      ghost.clear();
      break;
    case 'KeyR':
      void recordAction();
      break;
    case 'KeyD':
      void directorAction();
      break;
    case 'KeyS':
      ui.toggleSettings();
      break;
    case 'KeyH':
      ui.toggleHidden();
      break;
    case 'KeyW':
      demo?.toggleWave();
      break;
  }
});
window.addEventListener('keyup', (e) => {
  if (!(source instanceof DemoSource)) return;
  if (e.code === 'ArrowLeft') source.setKey('left', false);
  if (e.code === 'ArrowRight') source.setKey('right', false);
});

let drag: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  rig.nudgeOrbit(-(e.clientX - drag.x) * 0.006, (e.clientY - drag.y) * 0.004);
  drag = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', () => (drag = null));
canvas.addEventListener('pointercancel', () => (drag = null));

// ------------------------------------------------------------------ per-frame

const placeCtx = (): PlaceContext => ({
  warp,
  room,
  line,
  camera: rig.camera,
  walkDepth: settings.walkDepth,
  counterHeight: settings.counterHeight,
});

function updateShadows(): void {
  const u = room.uniforms;
  [liveCard, ghost.card].forEach((card, i) => {
    const op = card.visible ? (card.material.uniforms.uOpacity.value as number) : 0;
    if (op > 0 && card.lift < 0.01) {
      const ry = card.object.rotation.y;
      u.uCasterPos.value[i].set(card.feet.x, card.feet.y, card.feet.z, 0.72 * op);
      u.uCasterAxis.value[i].set(Math.cos(ry), -Math.sin(ry), card.halfWidth() + 0.16, 0.24);
    } else {
      u.uCasterPos.value[i].w = 0;
    }
    if (op > 0) {
      const s = card.factor;
      u.uWallShadow.value[i].set(card.apparentFeet.x, card.apparentFeet.z, card.topHeight() / s, card.halfWidth() / s);
      u.uWallShadowK.value[i] = 0.26 * op;
    } else {
      u.uWallShadowK.value[i] = 0;
    }
  });
}

const pipMask = document.createElement('canvas');
pipMask.width = MASK_SIZE;
pipMask.height = MASK_SIZE;
let pipTime = 0;
function drawPip(f: PersonFrame, now: number): void {
  if (now - pipTime < 90 || ui.hidden || !source) return;
  pipTime = now;
  const ctx = ui.pip.getContext('2d');
  const mctx = pipMask.getContext('2d');
  if (!ctx || !mctx) return;
  const W = ui.pip.width;
  const H = ui.pip.height;
  // Fit the camera frame into the preview, mirrored like the room.
  const k = Math.min(W / f.videoW, H / f.videoH);
  const fw = f.videoW * k;
  const fh = f.videoH * k;
  const ox = (W - fw) / 2;
  const oy = (H - fh) / 2;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (settings.mirror) {
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
  }
  const view = source.view();
  if (view) ctx.drawImage(view, ox, oy, fw, fh);
  const img = mctx.createImageData(MASK_SIZE, MASK_SIZE);
  for (let i = 0; i < f.mask.length; i++) {
    img.data[i * 4] = 60;
    img.data[i * 4 + 1] = 230;
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = f.mask[i] * 0.5;
  }
  mctx.putImageData(img, 0, 0);
  ctx.beginPath();
  ctx.rect(ox, oy, fw, fh);
  ctx.clip();
  ctx.drawImage(pipMask, ox + f.roi.x * k, oy + f.roi.y * k, f.roi.size * k, f.roi.size * k);
  ctx.restore();
  // The part of the frame that maps onto the walking line (in mirrored view coordinates).
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 210, 122, 0.85)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  for (const r of [settings.walkRangeMin, settings.walkRangeMax]) {
    const x = Math.round(ox + r * fw) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, oy);
    ctx.lineTo(x, oy + fh);
    ctx.stroke();
  }
  ctx.restore();
}

let last = performance.now();
let fpsFrames = 0;
let fpsT0 = last;
let renderFps = 60;
let uiTime = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;

  // 1. New segmentation result: textures, tracking, walking target, ghost take.
  const f = source?.take() ?? null;
  if (f) {
    live.set(f);
    lastFrame = f;
    if (f.lum > 0.005 && f.stats.found) {
      const want = Math.min(1.6, Math.max(0.7, PERSON_TARGET_LUM / f.lum));
      exposure += (want - exposure) * 0.06;
    }
    tracker.update(f, settings);
    if (tracker.found) walker.setObservation(tracker.xNorm, settings.mirror);
    const l = tracker.layout(f, settings.mirror);
    if (l) layout = l;
    if (ghost.state === 'recording' && layout && tracker.found) ghost.addFrame(live, layout, walker.u, tracker.mode, liveCard);
    drawPip(f, now);
  }
  if (ghost.state === 'recording' && ghost.recordingProgress >= 1) ghost.finish();

  // 2. Motion.
  const want = tracker.found && layout ? 1 : 0;
  presence += (want - presence) * (1 - Math.exp(-dt * (want ? 5 : 2.5)));
  walker.update(dt);
  rig.update(dt);
  director.update(dt);

  // 3. People.
  liveCard.material.uniforms.uBright.value = settings.personBrightness * (settings.autoBrightness ? exposure : 1);
  const ctx = placeCtx();
  if (layout && presence > 0.003) {
    liveCard.place({ u: walker.u, layout, mode: tracker.mode, opacity: presence }, ctx);
  } else {
    liveCard.object.visible = liveCard.visible = false;
  }
  const gp = ghost.update(dt);
  if (gp && gp.opacity > 0.003) ghost.card.place(gp, ctx);
  else ghost.card.object.visible = ghost.card.visible = false;
  const counter =
    (liveCard.visible && tracker.mode === 'upper') || (ghost.card.visible && gp?.mode === 'upper') || settings.bodyMode === 'upper';
  room.setCounter(counter, settings.counterHeight, settings.walkDepth);
  updateShadows();

  // 4. Room state, overlays and post.
  room.updateCutaway(rig.camera.position);
  const reveal = rig.revealAmount();
  room.setDiagramOpacity(reveal);
  liveCard.setMarker(reveal * 0.85);
  ghost.card.setMarker(reveal * 0.85);
  updateSightDiagram(reveal);
  room.setClock(new Date());
  lockPulse = Math.max(0, lockPulse - dt / 0.7);
  post.pulse = Math.sin(Math.min(1, lockPulse) * Math.PI) * 0.8;
  post.setCaption(caption.text);
  post.captionOpacity = settings.captions ? caption.opacity : 0;
  post.render(renderer, scene, rig.camera, now / 1000);

  // 5. UI (a few times per second).
  fpsFrames++;
  if (now - fpsT0 >= 1000) {
    renderFps = (fpsFrames * 1000) / (now - fpsT0);
    fpsFrames = 0;
    fpsT0 = now;
  }
  if (now - uiTime > 120) {
    uiTime = now;
    updateStatus();
  }
}

function updateStatus(): void {
  if (!source) ui.setMode('no camera yet', true);
  else if (!lastFrame) ui.setMode(source.status, false);
  else if (!tracker.found) ui.setMode('step into the frame', true);
  else ui.setMode(tracker.mode === 'full' ? 'full body' : 'upper body · counter');
  ui.setFps(
    settings.showStats
      ? `${renderFps.toFixed(0)} fps · seg ${(source?.fps ?? 0).toFixed(0)} fps${source ? ` · ${source.status.replace(/^Segmenting /, '')}` : ''}`
      : null,
  );
  ui.setRecording(recorder.recording, recorder.elapsed);
  ui.setGhostState(ghost.state, ghost.recordingProgress);
}

// ------------------------------------------------------------------ boot

applySettings();
runStartupChecks(room, warp, line.z, settings.walkMargin);
requestAnimationFrame(frame);

if (params.has('demo')) startDemo(params.get('demo') === 'upper' ? 'upper' : 'full');
else
  void listCameras()
    .then((cams) => ui.setCameras(cams))
    .catch(() => undefined);
const startView = params.get('view') as ViewName | null;
if (startView === 'reveal' || startView === 'top') rig.goTo(startView, 0.01);

// Hooks for automated checks and the curious.
Object.assign(window as unknown as Record<string, unknown>, {
  __ames: {
    THREE,
    rig,
    room,
    warp,
    settings,
    tracker,
    walker,
    ghost,
    director,
    liveCard,
    applySettings,
    source: () => source,
    goTo: (v: ViewName, d?: number) => rig.goTo(v, d),
    ghostAction,
    recordAction,
    directorAction,
    projectHeight: () => projectPersonHeight(),
    setCaption: (text: string | null, opacity: number) => (caption = { text, opacity }),
  },
});

/** On-screen height (pixels) of the live card's top above its feet, for automated size checks. */
function projectPersonHeight(): { feet: number[]; head: number[]; heightPx: number } | null {
  if (!liveCard.visible) return null;
  const w = renderer.domElement.width;
  const h = renderer.domElement.height;
  const toPx = (v: THREE.Vector3) => {
    const p = v.clone().project(rig.camera);
    return [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h];
  };
  const feet = toPx(liveCard.feet);
  const head = toPx(liveCard.feet.clone().add(new THREE.Vector3(0, settings.personHeight, 0)));
  return { feet, head, heightPx: feet[1] - head[1] };
}
