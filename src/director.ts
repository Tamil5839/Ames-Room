import type { ViewName } from './camera';
import type { DemoAction } from './demo';

/**
 * Director mode (D): a guided 30 s recording. It drives the camera, the ghost
 * and the burned-in captions, and shows performer-only cues (HTML, never
 * recorded) telling you what to do next.
 */

export interface DirectorHooks {
  /** Countdown, then start recording. Resolves false if it could not start. */
  startRecording(): Promise<boolean>;
  stopRecording(): void;
  cancelRecording(): void;
  setCaption(text: string | null, opacity: number): void;
  setCue(text: string | null, sub?: string): void;
  setProgress(t: number, total: number): void;
  goTo(view: ViewName, duration?: number): void;
  hasGhost(): boolean;
  showGhost(show: boolean, restart: boolean): void;
  perform?(action: DemoAction): void;
  finished(): void;
}

interface Caption {
  from: number;
  to: number;
  text: string;
}

export const DIRECTOR_LENGTH = 30;

const CAPTIONS: Caption[] = [
  { from: 0, to: 4, text: 'a normal room.' },
  { from: 15, to: 23, text: "the room isn't square." },
  { from: 23, to: 30, text: 'your brain just assumes it is.' },
];

export class Director {
  active = false;
  private t = 0;
  private stage = -1;
  private starting = false;

  constructor(private readonly hooks: DirectorHooks) {}

  get time(): number {
    return this.t;
  }

  async start(): Promise<void> {
    if (this.active || this.starting) return;
    this.starting = true;
    const h = this.hooks;
    h.goTo('hero', 1.2);
    h.showGhost(false, false);
    h.perform?.('left');
    h.setCue('Stand in the LEFT corner', 'the far corner, where you look tiny');
    const ok = await h.startRecording();
    this.starting = false;
    if (!ok) {
      h.setCue(null);
      h.showGhost(true, false);
      return;
    }
    this.active = true;
    this.t = 0;
    this.stage = -1;
  }

  cancel(): void {
    if (!this.active && !this.starting) return;
    this.active = false;
    this.starting = false;
    this.hooks.cancelRecording();
    this.cleanup();
  }

  private cleanup(): void {
    const h = this.hooks;
    h.setCue(null);
    h.setCaption(null, 0);
    h.showGhost(true, false);
    h.setProgress(0, 0);
  }

  private enter(stage: number): void {
    const h = this.hooks;
    this.stage = stage;
    switch (stage) {
      case 0:
        h.setCue('Stand still in the LEFT corner', 'a normal room…');
        break;
      case 1:
        h.setCue('Walk right slowly  →', 'you grow into a giant');
        h.perform?.('walkRight');
        break;
      case 2:
        if (h.hasGhost()) {
          h.showGhost(true, true);
          h.setCue('Look down at your tiny twin', 'they just appeared in the far corner');
        } else {
          h.setCue('Look around — you are a giant', 'tip: record a ghost first (G)');
        }
        h.perform?.('lookDown');
        break;
      case 3:
        h.goTo('reveal', 3.4);
        h.setCue('Hold still', 'the camera reveals the real room');
        h.perform?.('idle');
        break;
      case 4:
        h.goTo('hero', 2.8);
        h.setCue('Stay put…', 'locking the illusion again');
        break;
    }
  }

  update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    const t = this.t;
    const stage = t < 4 ? 0 : t < 10 ? 1 : t < 15 ? 2 : t < 23 ? 3 : 4;
    if (stage !== this.stage) this.enter(stage);

    let text: string | null = null;
    let opacity = 0;
    for (const c of CAPTIONS) {
      if (t >= c.from && t < c.to) {
        text = c.text;
        opacity = Math.min(1, (t - c.from) / 0.45, (c.to - t) / 0.45);
      }
    }
    this.hooks.setCaption(text, Math.max(0, opacity));
    this.hooks.setProgress(t, DIRECTOR_LENGTH);

    if (t >= DIRECTOR_LENGTH) {
      this.active = false;
      this.hooks.stopRecording();
      this.cleanup();
      this.hooks.finished();
    }
  }
}
