import GUI, { type Controller } from 'lil-gui';
import type { ViewName } from './camera';
import { DEFAULT_SETTINGS, type Settings } from './config';
import type { GhostState } from './ghost';
import type { RecordingResult } from './recorder';
import { ROOM_STYLES } from './room';

export interface UIHandlers {
  onReveal(): void;
  onTop(): void;
  onGhost(): void;
  onClearGhost(): void;
  onRecord(): void;
  onDirector(): void;
  onStartCamera(deviceId?: string): void;
  onStartDemo(): void;
  onSwitchSource(id: string): void;
  onSettingChange(key: keyof Settings): void;
  onRecalibrate(): void;
  onRunChecks(): void;
  onResetSettings(): void;
}

const ICONS: Record<string, string> = {
  reveal:
    '<path d="M3 12a9 9 0 0 1 15.5-6.2M21 12a9 9 0 0 1-15.5 6.2"/><path d="M18.5 2.8v3.1h-3.1M5.5 21.2v-3.1h3.1"/><circle cx="12" cy="12" r="2.6"/>',
  back: '<path d="M9 5 3 11l6 6"/><path d="M3 11h11a7 7 0 0 1 0 14"/>',
  top: '<path d="M4 5.5 20 8v9l-16 3z"/><circle cx="12" cy="21.5" r="0.2"/><path d="M12 21 7 6.5M12 21l6.5-12.5" stroke-dasharray="2 2"/>',
  ghost:
    '<path d="M5 20V11a7 7 0 0 1 14 0v9l-2.3-1.6L14.3 20 12 18.4 9.7 20l-2.4-1.6z"/><circle cx="9.5" cy="11" r="1"/><circle cx="14.5" cy="11" r="1"/>',
  clear: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  record: '<circle cx="12" cy="12" r="7"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  director: '<path d="M3 10h18v10H3z"/><path d="m3 10 1.6-5 16.4 2.3L21 10"/><path d="m8.4 5.6 1.6 4.4M13.8 6.4l1.6 3.6"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  hide: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3 3.8M6.6 6.6A17 17 0 0 0 2.5 12S6 19 12 19a9.6 9.6 0 0 0 5.4-1.6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.7-1.5"/>',
};

function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export class UI {
  readonly gui: GUI;
  readonly pip: HTMLCanvasElement;
  hidden = false;
  private readonly root: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly lockChip: HTMLElement;
  private readonly modeChip: HTMLElement;
  private readonly fpsChip: HTMLElement;
  private readonly recChip: HTMLElement;
  private readonly cue: HTMLElement;
  private readonly cueMain: HTMLElement;
  private readonly cueSub: HTMLElement;
  private readonly countdownEl: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly onboarding: HTMLElement;
  private readonly result: HTMLElement;
  private toastTimer = 0;
  private resultUrl: string | null = null;
  private sourceFolder!: GUI;
  private sourceCtrl: Controller | null = null;
  private readonly sourceState = { source: '' };
  private readonly warpInfo = { sizeChange: '' };
  private warpInfoCtrl: Controller | null = null;

  constructor(
    root: HTMLElement,
    private readonly settings: Settings,
    private readonly handlers: UIHandlers,
  ) {
    this.root = root;

    const top = el('div', 'topbar');
    const brand = el('div', 'brand', '<span class="brand-mark"></span>Ames Room');
    const chips = el('div', 'chips');
    this.lockChip = el('span', 'chip chip-lock');
    this.modeChip = el('span', 'chip');
    this.fpsChip = el('span', 'chip chip-fps');
    chips.append(this.lockChip, this.modeChip, this.fpsChip);
    this.recChip = el('div', 'rec-chip', '<i></i><span>REC 00:00</span>');
    top.append(brand, chips, this.recChip);

    this.cue = el('div', 'cue');
    this.cueMain = el('div', 'cue-main');
    this.cueSub = el('div', 'cue-sub');
    this.cue.append(this.cueMain, this.cueSub);
    this.countdownEl = el('div', 'countdown');
    this.progress = el('div', 'dir-progress');
    this.progressBar = el('div', 'bar');
    this.progress.append(this.progressBar);

    const toolbar = el('div', 'toolbar');
    const add = (id: string, label: string, key: string, onClick: () => void, cls = '') => {
      const b = el('button', `tb ${cls}`, `${icon(id === 'record' ? 'record' : id)}<span class="tb-label">${label}</span><kbd>${key}</kbd>`);
      b.type = 'button';
      b.title = `${label} (${key})`;
      b.addEventListener('click', () => {
        onClick();
        b.blur(); // keep Space/letters for the shortcuts, not for re-clicking this button
      });
      this.buttons.set(id, b);
      toolbar.append(b);
      return b;
    };
    add('reveal', 'Reveal', 'Space', () => handlers.onReveal());
    add('top', 'Top view', 'T', () => handlers.onTop());
    toolbar.append(el('span', 'tb-sep'));
    add('ghost', 'Ghost', 'G', () => handlers.onGhost());
    add('clear', 'Clear ghost', 'X', () => handlers.onClearGhost());
    toolbar.append(el('span', 'tb-sep'));
    add('record', 'Record', 'R', () => handlers.onRecord(), 'tb-record');
    add('director', 'Director', 'D', () => handlers.onDirector());
    toolbar.append(el('span', 'tb-sep'));
    add('settings', 'Settings', 'S', () => this.toggleSettings());
    add('hide', 'Hide UI', 'H', () => this.toggleHidden());

    this.pip = el('canvas', 'pip');
    this.pip.width = 256;
    this.pip.height = 144;
    this.pip.title = 'What the camera sees: cyan is your cutout, the dashed lines are the ends of the room';

    this.toastEl = el('div', 'toast');
    this.onboarding = this.buildOnboarding();
    this.result = el('div', 'modal result hidden');

    const hint = el('div', 'hint', 'H hides the interface');
    root.append(top, this.cue, this.countdownEl, this.progress, toolbar, this.pip, hint, this.toastEl, this.onboarding, this.result);

    this.gui = this.buildGui();
    this.setGhostState('empty', 0);
    this.setLock(true, 'hero');
    this.setRecording(false, 0);
  }

  // ---------------------------------------------------------------- settings panel

  private buildGui(): GUI {
    const s = this.settings;
    const h = this.handlers;
    const gui = new GUI({ title: 'Settings', container: this.root, width: 300 });
    gui.domElement.classList.add('settings-panel');
    const on = (key: keyof Settings) => () => h.onSettingChange(key);

    this.sourceFolder = gui.addFolder('Source');
    this.setSources([], '');

    const warp = gui.addFolder('Warp');
    warp.add(s, 'leftFactor', 1.1, 3.2, 0.01).name('far corner ×distance').onChange(on('leftFactor'));
    warp.add(s, 'rightFactor', 0.5, 1.0, 0.01).name('near corner ×distance').onChange(on('rightFactor'));
    this.warpInfoCtrl = warp.add(this.warpInfo, 'sizeChange').name('you change size by').disable();

    const me = gui.addFolder('Me');
    me.add(s, 'personHeight', 1.2, 2.2, 0.01).name('my real height (m)').onChange(on('personHeight'));
    me.add(s, 'mirror').name('mirror image').onChange(on('mirror'));
    me.add(s, 'bodyMode', ['auto', 'full', 'upper']).name('body mode').onChange(on('bodyMode'));
    me.add(s, 'lockScale').name('lock my scale').onChange(on('lockScale'));
    me.add({ recalibrate: () => h.onRecalibrate() }, 'recalibrate').name('recalibrate my height');
    me.add(s, 'counterHeight', 0.85, 1.3, 0.01).name('counter height (m)').onChange(on('counterHeight'));

    const mask = gui.addFolder('Mask');
    mask.add(s, 'maskFeather', 0, 1, 0.01).name('edge feather').onChange(on('maskFeather'));
    mask.add(s, 'maskErode', 0, 1, 0.01).name('edge erosion').onChange(on('maskErode'));
    mask.add(s, 'maskSmoothing', 0, 0.9, 0.01).name('temporal smoothing').onChange(on('maskSmoothing'));
    mask.add(s, 'segModel', ['selfie', 'multiclass (16 MB)']).name('model').onChange(on('segModel'));

    const walk = gui.addFolder('Walking line');
    walk.add(s, 'walkDepth', 0.3, 1.5, 0.01).name('from back wall (m)').onChange(on('walkDepth'));
    walk.add(s, 'walkMargin', 0.25, 1.2, 0.01).name('from side walls (m)').onChange(on('walkMargin'));
    walk.add(s, 'walkRangeMin', 0, 0.45, 0.01).name('webcam range start').onChange(on('walkRangeMin'));
    walk.add(s, 'walkRangeMax', 0.55, 1, 0.01).name('webcam range end').onChange(on('walkRangeMax'));
    walk.add(s, 'walkSpring', 1, 12, 0.1).name('follow speed').onChange(on('walkSpring'));
    walk.close();

    const look = gui.addFolder('Look');
    look.add(s, 'roomStyle', Object.keys(ROOM_STYLES)).name('room style').onChange(on('roomStyle'));
    look.add(s, 'grain').name('film grain').onChange(on('grain'));
    look.add(s, 'grainAmount', 0, 0.15, 0.005).name('grain amount').onChange(on('grainAmount'));
    look.add(s, 'vignette', 0, 1, 0.01).name('vignette').onChange(on('vignette'));
    look.add(s, 'personWarmth', -1, 1, 0.01).name('my warmth').onChange(on('personWarmth'));
    look.add(s, 'personBrightness', 0.5, 1.6, 0.01).name('my brightness').onChange(on('personBrightness'));
    look.add(s, 'autoBrightness').name('match room brightness').onChange(on('autoBrightness'));
    look.add(s, 'personSaturation', 0, 1.5, 0.01).name('my saturation').onChange(on('personSaturation'));
    look.close();

    const rec = gui.addFolder('Recording');
    rec.add(s, 'aspect', ['fill', '16:9', '9:16', '1:1']).name('aspect').onChange(on('aspect'));
    rec.add(s, 'captions').name('burn in captions').onChange(on('captions'));
    rec.add(s, 'recordSound').name('record sound').onChange(on('recordSound'));

    const dbg = gui.addFolder('Debug');
    dbg.add(s, 'debugWireframe').name('apparent room wireframe').onChange(on('debugWireframe'));
    dbg.add(s, 'showStats').name('show stats').onChange(on('showStats'));
    dbg.add({ check: () => h.onRunChecks() }, 'check').name('run alignment check');
    dbg.close();

    gui.add({ reset: () => h.onResetSettings() }, 'reset').name('reset to defaults');
    gui.hide();
    return gui;
  }

  /** Camera / demo picker in the settings panel. */
  setSources(cameras: MediaDeviceInfo[], current: string): void {
    const opts: Record<string, string> = {};
    cameras.forEach((c, i) => {
      if (c.deviceId) opts[c.label || `Camera ${i + 1}`] = c.deviceId;
    });
    if (!cameras.some((c) => c.deviceId)) opts['Camera'] = '';
    opts['Demo performer'] = 'demo';
    opts['Demo (laptop framing)'] = 'demo-upper';
    this.sourceState.source = current;
    this.sourceCtrl?.destroy();
    this.sourceCtrl = this.sourceFolder
      .add(this.sourceState, 'source', opts)
      .name('camera')
      .onChange((v: string) => this.handlers.onSwitchSource(v));
  }

  /** Live readout of how much the warp changes your apparent height along the walking line. */
  setSizeChange(ratio: number): void {
    this.warpInfo.sizeChange = `${ratio.toFixed(2)}×`;
    this.warpInfoCtrl?.updateDisplay();
  }

  refreshGui(): void {
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }

  toggleSettings(force?: boolean): void {
    const show = force ?? this.gui._hidden;
    if (show) this.gui.show();
    else this.gui.hide();
    this.buttons.get('settings')?.classList.toggle('active', show);
  }

  // ---------------------------------------------------------------- onboarding

  private buildOnboarding(): HTMLElement {
    const m = el('div', 'modal onboarding');
    m.innerHTML = `
      <div class="card">
        <h1>Ames Room</h1>
        <p class="lede">Step into a room that lies. Walk to the left and you shrink into a tiny person;
        walk to the right and you grow into a giant. Then swing the camera around to see how the trick works.</p>
        <ol class="tips">
          <li><b>Use your phone as the webcam</b> (Continuity Camera on a Mac with an iPhone, or DroidCam on Android). Laptop cameras can't see your feet.</li>
          <li><b>Stand 2.5–3 m back</b> so your whole body, head to feet, is in the frame.</li>
          <li><b>Plain background, even lighting.</b> Avoid a bright window behind you.</li>
          <li><b>Move sideways slowly</b>, parallel to the camera. Your left is the room's far corner.</li>
          <li>No feet in the frame? You'll stand behind a counter instead (upper-body mode).</li>
        </ol>
        <div class="row">
          <label class="select"><span>Camera</span><select class="camera-select"><option value="">Default camera</option></select></label>
        </div>
        <div class="row buttons">
          <button type="button" class="primary start-camera">Start camera</button>
          <button type="button" class="ghostbtn start-demo">Try the demo performer</button>
        </div>
        <p class="error" hidden></p>
        <p class="fine">Runs entirely in your browser: your video never leaves this device.
        Keys: <kbd>Space</kbd> reveal · <kbd>T</kbd> top view · <kbd>G</kbd> ghost · <kbd>R</kbd> record · <kbd>D</kbd> director · <kbd>H</kbd> hide UI</p>
      </div>`;
    const select = m.querySelector('select') as HTMLSelectElement;
    m.querySelector('.start-camera')!.addEventListener('click', () => this.handlers.onStartCamera(select.value || undefined));
    m.querySelector('.start-demo')!.addEventListener('click', () => this.handlers.onStartDemo());
    return m;
  }

  setCameras(cameras: MediaDeviceInfo[], preferred?: string): void {
    const select = this.onboarding.querySelector('select') as HTMLSelectElement;
    select.innerHTML = '<option value="">Default camera</option>';
    cameras.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = c.label || `Camera ${i + 1}`;
      if (c.deviceId && c.deviceId === preferred) o.selected = true;
      select.append(o);
    });
  }

  setOnboardingError(msg: string | null): void {
    const p = this.onboarding.querySelector('.error') as HTMLElement;
    p.hidden = !msg;
    p.textContent = msg ?? '';
  }

  setOnboardingBusy(busy: boolean): void {
    this.onboarding.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = busy));
    const start = this.onboarding.querySelector('.start-camera') as HTMLButtonElement;
    start.textContent = busy ? 'Starting…' : 'Start camera';
  }

  hideOnboarding(): void {
    this.onboarding.classList.add('hidden');
  }

  showOnboarding(): void {
    this.onboarding.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- status

  setLock(locked: boolean, view: ViewName): void {
    this.lockChip.innerHTML = locked ? `${icon('lock')}illusion locked` : `${icon('unlock')}${view === 'top' ? 'top view' : 'revealed'}`;
    this.lockChip.classList.toggle('on', locked);
    const b = this.buttons.get('reveal')!;
    const away = view !== 'hero';
    b.querySelector('svg')!.outerHTML = icon(away ? 'back' : 'reveal');
    b.querySelector('.tb-label')!.textContent = away ? 'Return' : 'Reveal';
    this.buttons.get('top')!.classList.toggle('active', view === 'top');
  }

  setMode(text: string, warn = false): void {
    this.modeChip.textContent = text;
    this.modeChip.classList.toggle('warn', warn);
  }

  setFps(text: string | null): void {
    this.fpsChip.hidden = !text;
    if (text) this.fpsChip.textContent = text;
  }

  private recState: boolean | null = null;

  setRecording(on: boolean, seconds: number): void {
    (this.recChip.querySelector('span') as HTMLElement).textContent = `REC ${fmtTime(seconds)}`;
    if (on === this.recState) return;
    this.recState = on;
    this.recChip.classList.toggle('on', on);
    const b = this.buttons.get('record')!;
    b.classList.toggle('active', on);
    b.querySelector('svg')!.outerHTML = icon(on ? 'stop' : 'record');
    b.querySelector('.tb-label')!.textContent = on ? 'Stop' : 'Record';
  }

  setDirectorActive(on: boolean): void {
    this.buttons.get('director')!.classList.toggle('active', on);
  }

  setGhostState(state: GhostState, progress: number): void {
    const b = this.buttons.get('ghost')!;
    const label = state === 'recording' ? `Ghost ${Math.ceil((1 - progress) * 10)}s` : state === 'ready' ? 'New ghost' : 'Ghost';
    b.querySelector('.tb-label')!.textContent = label;
    b.classList.toggle('active', state === 'recording');
    b.style.setProperty('--p', String(progress));
    this.buttons.get('clear')!.disabled = state === 'empty';
  }

  setCue(main: string | null, sub?: string): void {
    this.cue.classList.toggle('on', !!main);
    if (main) {
      this.cueMain.textContent = main;
      this.cueSub.textContent = sub ?? '';
    }
  }

  countdown(n: number | null): void {
    this.countdownEl.classList.toggle('on', n !== null);
    if (n !== null) {
      this.countdownEl.textContent = String(n);
      this.countdownEl.classList.remove('pop');
      void this.countdownEl.offsetWidth;
      this.countdownEl.classList.add('pop');
    }
  }

  setProgress(t: number, total: number): void {
    this.progress.classList.toggle('on', total > 0);
    this.progressBar.style.width = total > 0 ? `${Math.min(100, (t / total) * 100)}%` : '0%';
  }

  toast(msg: string, ms = 2600): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('on'), ms);
  }

  toggleHidden(force?: boolean): void {
    this.hidden = force ?? !this.hidden;
    this.root.classList.toggle('ui-hidden', this.hidden);
  }

  // ---------------------------------------------------------------- result

  showResult(r: RecordingResult): void {
    if (this.resultUrl) URL.revokeObjectURL(this.resultUrl);
    this.resultUrl = URL.createObjectURL(r.blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const name = `ames-room-${stamp}.${r.extension}`;
    const mb = (r.blob.size / 1e6).toFixed(1);
    const convert = !r.shareReady;
    const out = name.replace(/\.(webm|mp4)$/, '') + (r.extension === 'mp4' ? '-x.mp4' : '.mp4');
    const cmd = `ffmpeg -i ${name} -c:v libx264 -pix_fmt yuv420p -crf 18 -c:a aac -movflags +faststart ${out}`;
    const codec = /codecs=([^,;]+)/.exec(r.mimeType)?.[1];
    this.result.innerHTML = `
      <div class="card">
        <h2>Your take</h2>
        <video class="preview" src="${this.resultUrl}" controls playsinline loop autoplay muted></video>
        <p class="meta">${r.width}×${r.height} · ${r.seconds.toFixed(1)} s · ${r.extension.toUpperCase()}${codec ? ` (${codec})` : ''} · ${mb} MB</p>
        ${
          convert
            ? `<p class="fine">This browser can't encode H.264, so it recorded ${r.extension.toUpperCase()}${codec ? `/${codec}` : ''}. For X/Twitter, convert it with:</p><pre class="cmd"></pre>`
            : '<p class="fine">MP4 (H.264): ready for X/Twitter, Reels and Shorts.</p>'
        }
        <div class="row buttons">
          <a class="primary download" download="${name}" href="${this.resultUrl}">Download ${r.extension.toUpperCase()}</a>
          <button type="button" class="ghostbtn close">Close</button>
        </div>
      </div>`;
    const pre = this.result.querySelector('.cmd');
    if (pre) pre.textContent = cmd;
    this.result.querySelector('.close')!.addEventListener('click', () => this.hideResult());
    this.result.classList.remove('hidden');
  }

  hideResult(): void {
    this.result.classList.add('hidden');
    const v = this.result.querySelector('video');
    v?.pause();
  }

  get modalOpen(): boolean {
    return !this.onboarding.classList.contains('hidden') || !this.result.classList.contains('hidden');
  }
}

export function resetSettings(s: Settings): void {
  Object.assign(s, DEFAULT_SETTINGS);
}
