/**
 * Tiny synthesized sound effects: the "illusion lock" click and countdown ticks.
 * Everything also feeds a MediaStream destination so recordings can include it.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  enabled = true;

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(this.ctx.destination);
    this.dest = this.ctx.createMediaStreamDestination();
    this.out.connect(this.dest);
    return this.ctx;
  }

  /** Call from a user gesture so the context is allowed to start. */
  unlock(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  /** Audio track to mix into recordings. */
  stream(): MediaStream | null {
    this.ensure();
    return this.dest?.stream ?? null;
  }

  /** A soft mechanical "tock": filtered noise burst plus a short low sine thump. */
  click(): void {
    const ctx = this.ensure();
    if (!ctx || !this.out || !this.enabled) return;
    const t = ctx.currentTime + 0.005;
    const len = Math.floor(ctx.sampleRate * 0.05);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 1.4;
    const ng = ctx.createGain();
    ng.gain.value = 0.55;
    noise.connect(bp).connect(ng).connect(this.out);
    noise.start(t);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(190, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.08);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.45, t + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    osc.connect(og).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.13);
  }

  tick(high = false): void {
    const ctx = this.ensure();
    if (!ctx || !this.out || !this.enabled) return;
    const t = ctx.currentTime + 0.005;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = high ? 1320 : 880;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (high ? 0.25 : 0.12));
    osc.connect(g).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.3);
  }
}
