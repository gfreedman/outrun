/**
 * audio.ts
 *
 * AudioManager — all game sounds generated via the Web Audio API.
 *
 * Architecture
 * ────────────
 * Three engine oscillators (sawtooth) run continuously; GainNodes crossfade
 * between bands based on speed ratio.  Engine is silent at speed 0.
 * One-shots (beep, crash, screech) are spawned as transient nodes.
 * A rumble oscillator is toggled on/off when the player goes off-road.
 * Background music is a scheduled 4-bar synth loop in OutRun style.
 */

// ── Music pattern constants ──────────────────────────────────────────────────

// BPM and timing — 148 BPM matches the actual OutRun arcade tempo
const BPM    = 148;
const BEAT   = 60 / BPM;          // ≈ 0.405 s
const EIGHTH = BEAT / 2;          // ≈ 0.203 s
const BAR    = BEAT * 4;          // ≈ 1.622 s

// Note frequencies — E major (bright, uplifting OutRun key)
const E2 = 82.41,  A2 = 110.00, B2 = 123.47;
const E3 = 164.81, F3s= 185.00, G3s= 207.65, A3 = 220.00, B3 = 246.94, C4s= 277.18;
const E4 = 329.63, F4s= 369.99, G4s= 415.30, A4 = 440.00, B4 = 493.88;
const C5s= 554.37, D5s= 622.25, E5 = 659.25;

// 4-bar melody — 8 eighth-notes per bar, bright E major feel
const MELODY: number[][] = [
  [E4,  G4s, B4,  G4s, A4,  E4,  F4s, G4s],  // I  — E major, ascending
  [A4,  G4s, F4s, E4,  F4s, G4s, A4,  B4 ],  // IV — A major, flowing
  [B4,  A4,  G4s, F4s, E4,  D5s, C5s, B4 ],  // V  — B major, run down
  [C5s, B4,  A4,  G4s, F4s, E4,  F4s, E4 ],  // resolve to tonic, triumphant
];

// Bass: 4 quarter-notes per bar — driving, punchy
const BASS: number[][] = [
  [E2,  E2,  B2,  E2 ],
  [A2,  A2,  E2,  A2 ],
  [B2,  B2,  F3s, B2 ],
  [C4s, B2,  A2,  E2 ],
];

// Chord pads: 3 notes held for the full bar
const CHORDS: number[][] = [
  [E3,  G3s, B3  ],   // E major
  [A3,  C4s, E4  ],   // A major
  [B3,  D5s, F4s ],   // B major
  [C4s, E4,  G4s ],   // C#minor (brief colour before E resolve)
];

// ────────────────────────────────────────────────────────────────────────────

export class AudioManager
{
  private ctx:         AudioContext | null = null;
  private masterGain:  GainNode    | null = null;
  private enabled      = true;
  private initialized  = false;

  // ── Engine oscillators ──────────────────────────────────────────────────
  // Three harmonics: fundamental (f), 2f, 3f — all routed through a shared
  // lowpass filter that tracks RPM.  Lower base frequency (30-90 Hz) gives
  // a real motor growl instead of synthesiser buzz.

  private engFundOsc:   OscillatorNode | null = null;  // 1f
  private eng2ndOsc:    OscillatorNode | null = null;  // 2f
  private eng3rdOsc:    OscillatorNode | null = null;  // 3f
  private engFundGain:  GainNode | null = null;
  private eng2ndGain:   GainNode | null = null;
  private eng3rdGain:   GainNode | null = null;
  private engFilter:    BiquadFilterNode | null = null;
  private engMasterGain: GainNode | null = null;

  // ── Rumble oscillator (off-road) ────────────────────────────────────────

  private rumbleOsc:   OscillatorNode | null = null;
  private rumbleGain:  GainNode | null = null;

  // ── Screech oscillator (drifting) ───────────────────────────────────────

  private screechSrc:  AudioBufferSourceNode | null = null;
  private screechGain: GainNode | null = null;

  // ── Background music ────────────────────────────────────────────────────

  private musicGain:    GainNode | null = null;
  private musicPlaying  = false;
  private musicNextTime = 0;
  private musicBarIdx   = 0;

  // ─────────────────────────────────────────────────────────────────────────

  init(): void
  {
    if (this.initialized) return;
    this.initialized = true;

    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.enabled ? 1 : 0;
    this.masterGain.connect(this.ctx.destination);

    this.startEngineOscillators();
    this.startRumbleOscillator();
  }

  setEnabled(v: boolean): void
  {
    this.enabled = v;
    if (this.masterGain) this.masterGain.gain.value = v ? 1 : 0;
  }

  // ── Engine ────────────────────────────────────────────────────────────────

  private startEngineOscillators(): void
  {
    const ctx = this.ctx!;

    // Shared lowpass filter — cutoff tracks RPM so timbre opens up at speed
    const filt = ctx.createBiquadFilter();
    filt.type            = 'lowpass';
    filt.frequency.value = 200;   // starts dark at idle
    filt.Q.value         = 1.4;
    this.engFilter = filt;

    // Master engine gain (post-filter)
    const master = ctx.createGain();
    master.gain.value = 0;
    this.engMasterGain = master;

    filt.connect(master);
    master.connect(this.masterGain!);

    // Build each harmonic: sawtooth → individual gain → shared filter
    const makeHarmonic = (baseFreq: number, initGain: number): [OscillatorNode, GainNode] =>
    {
      const osc  = ctx.createOscillator();
      const g    = ctx.createGain();
      osc.type            = 'sawtooth';
      osc.frequency.value = baseFreq;
      g.gain.value        = initGain;
      osc.connect(g);
      g.connect(filt);
      osc.start();
      return [osc, g];
    };

    // Fundamental: ~30 Hz idle, rises to ~90 Hz at top speed
    [this.engFundOsc, this.engFundGain] = makeHarmonic(30, 1.0);
    // 2nd harmonic: 2× fundamental — body of the motor sound
    [this.eng2ndOsc,  this.eng2ndGain]  = makeHarmonic(60, 0.6);
    // 3rd harmonic: 3× fundamental — gives that snarl at high RPM
    [this.eng3rdOsc,  this.eng3rdGain]  = makeHarmonic(90, 0.3);
  }

  /**
   * Called each frame with the current speed ratio (0–1).
   * Engine is fully silent at speed = 0.
   * Fundamental frequency: 30 Hz (idle) → 90 Hz (max speed)
   * Filter cutoff: 200 Hz (closed, dark) → 1800 Hz (open, snarling)
   */
  updateEngine(speedRatio: number): void
  {
    if (!this.initialized || !this.ctx) return;

    const now = this.ctx.currentTime;
    const T   = 0.07;   // smoothing time constant

    if (speedRatio < 0.01)
    {
      // Silent when stopped
      if (this.engMasterGain)
        this.engMasterGain.gain.setTargetAtTime(0, now, T);
      return;
    }

    // Fundamental: 30 Hz at idle, 90 Hz at full speed
    const fundamental = 30 + speedRatio * 60;

    this.engFundOsc!.frequency.setTargetAtTime(fundamental,       now, T);
    this.eng2ndOsc! .frequency.setTargetAtTime(fundamental * 2,   now, T);
    this.eng3rdOsc! .frequency.setTargetAtTime(fundamental * 3,   now, T);

    // Filter cutoff opens with speed — motor timbre gets brighter/louder
    const cutoff = 200 + speedRatio * speedRatio * 1600;
    this.engFilter!.frequency.setTargetAtTime(cutoff, now, T * 2);

    // Master volume — gentle ramp from quiet idle to solid driving level
    const vol = 0.04 + speedRatio * 0.22;
    this.engMasterGain!.gain.setTargetAtTime(vol, now, T);

    // Harmonic mix: 3rd harmonic grows at high RPM for that V8 snarl
    this.engFundGain!.gain.setTargetAtTime(1.0,                   now, T);
    this.eng2ndGain! .gain.setTargetAtTime(0.55,                  now, T);
    this.eng3rdGain! .gain.setTargetAtTime(0.25 + speedRatio * 0.45, now, T);
  }

  /** Immediately cuts engine to silence — call when leaving game. */
  silenceEngine(): void
  {
    if (!this.ctx || !this.engMasterGain) return;
    const now = this.ctx.currentTime;
    this.engMasterGain.gain.cancelScheduledValues(now);
    this.engMasterGain.gain.setValueAtTime(0, now);
  }

  // ── Off-road rumble ───────────────────────────────────────────────────────

  private startRumbleOscillator(): void
  {
    const ctx  = this.ctx!;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type            = 'square';
    osc.frequency.value = 45;
    gain.gain.value     = 0;
    osc.connect(gain);
    gain.connect(this.masterGain!);
    osc.start();
    this.rumbleOsc  = osc;
    this.rumbleGain = gain;
  }

  startRumble(): void
  {
    if (!this.initialized || !this.ctx) return;
    this.rumbleGain!.gain.setTargetAtTime(0.06, this.ctx.currentTime, 0.05);
  }

  stopRumble(): void
  {
    if (!this.initialized || !this.ctx) return;
    this.rumbleGain!.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
  }

  // ── Screech (drift / sharp curve) ────────────────────────────────────────

  startScreech(): void
  {
    if (!this.initialized || !this.ctx || this.screechSrc) return;

    const ctx    = this.ctx;
    const buf    = this.makeNoiseBuf(0.8);
    const src    = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain   = ctx.createGain();

    src.buffer = buf;
    src.loop   = true;
    filter.type            = 'bandpass';
    filter.frequency.value = 1200;
    filter.Q.value         = 4;
    gain.gain.value        = 0.04;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain!);
    src.start();

    this.screechSrc  = src;
    this.screechGain = gain;
  }

  stopScreech(): void
  {
    if (!this.initialized || !this.ctx || !this.screechSrc) return;
    const now = this.ctx.currentTime;
    this.screechGain!.gain.setTargetAtTime(0, now, 0.1);
    const src = this.screechSrc;
    this.screechSrc  = null;
    this.screechGain = null;
    setTimeout(() => src.stop(), 300);
  }

  // ── One-shots ─────────────────────────────────────────────────────────────

  playBeep(freq: number, duration: number): void
  {
    if (!this.initialized || !this.ctx) return;
    const ctx  = this.ctx;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type            = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.setTargetAtTime(0, ctx.currentTime + duration * 0.8, 0.03);
    osc.connect(gain);
    gain.connect(this.masterGain!);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.1);
  }

  playCrashCar(): void
  {
    if (!this.initialized || !this.ctx) return;
    this.playThud(120, 0.14, 0.35);
  }

  playCrashObject(): void
  {
    if (!this.initialized || !this.ctx) return;
    this.playThud(200, 0.11, 0.25);
  }

  playBarney(): void { /* requires sounds/barney.mp3 */ }

  // ── Background music ─────────────────────────────────────────────────────

  /**
   * Starts the OutRun-style synth music loop.
   * Call once when the countdown begins.
   */
  startMusic(): void
  {
    if (!this.initialized || !this.ctx || this.musicPlaying) return;

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.setValueAtTime(0, this.ctx.currentTime);
    this.musicGain.gain.linearRampToValueAtTime(0.10, this.ctx.currentTime + 1.5);
    this.musicGain.connect(this.masterGain!);

    this.musicPlaying  = true;
    this.musicNextTime = this.ctx.currentTime + 0.1;
    this.musicBarIdx   = 0;
  }

  /**
   * Fades out and stops the music.
   */
  stopMusic(): void
  {
    if (!this.initialized || !this.ctx || !this.musicPlaying) return;
    this.musicPlaying = false;
    const now = this.ctx.currentTime;
    this.musicGain!.gain.cancelScheduledValues(now);
    this.musicGain!.gain.setTargetAtTime(0, now, 0.4);
    const g = this.musicGain;
    this.musicGain = null;
    setTimeout(() => g?.disconnect(), 2000);
  }

  /**
   * Must be called each frame while music is playing.
   * Schedules upcoming notes to keep the buffer ahead of playback.
   */
  tickMusic(): void
  {
    if (!this.initialized || !this.ctx || !this.musicPlaying || !this.musicGain) return;

    const now = this.ctx.currentTime;
    // Keep two bars scheduled ahead
    while (this.musicNextTime < now + BAR * 2)
    {
      this.scheduleMusicBar(this.musicNextTime, this.musicBarIdx % 4);
      this.musicNextTime += BAR;
      this.musicBarIdx++;
    }
  }

  private scheduleMusicBar(t: number, bar: number): void
  {
    const ctx  = this.ctx!;
    const gain = this.musicGain!;

    // ── Chord pad (triangle, soft attack, held for full bar) ───────────────
    CHORDS[bar].forEach(freq =>
    {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.type            = 'triangle';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.14, t + BEAT * 0.3);
      g.gain.setValueAtTime(0.14, t + BAR - BEAT * 0.3);
      g.gain.linearRampToValueAtTime(0, t + BAR);
      osc.connect(g);
      g.connect(gain);
      osc.start(t);
      osc.stop(t + BAR + 0.05);
    });

    // ── Bass (sawtooth, one quarter-note per beat) ─────────────────────────
    BASS[bar].forEach((freq, beat) =>
    {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.type            = 'sawtooth';
      osc.frequency.value = freq;
      const bt = t + beat * BEAT;
      g.gain.setValueAtTime(0, bt);
      g.gain.linearRampToValueAtTime(0.24, bt + 0.012);
      g.gain.setValueAtTime(0.24, bt + BEAT * 0.65);
      g.gain.linearRampToValueAtTime(0, bt + BEAT * 0.85);

      const filt = ctx.createBiquadFilter();
      filt.type            = 'lowpass';
      filt.frequency.value = 700;
      osc.connect(filt);
      filt.connect(g);
      g.connect(gain);
      osc.start(bt);
      osc.stop(bt + BEAT + 0.05);
    });

    // ── Melody (square wave, 8 eighth-notes per bar) ──────────────────────
    MELODY[bar].forEach((freq, i) =>
    {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.type            = 'square';
      osc.frequency.value = freq;
      const et = t + i * EIGHTH;
      g.gain.setValueAtTime(0, et);
      g.gain.linearRampToValueAtTime(0.11, et + 0.008);
      g.gain.setValueAtTime(0.11, et + EIGHTH * 0.72);
      g.gain.linearRampToValueAtTime(0, et + EIGHTH * 0.88);

      const filt = ctx.createBiquadFilter();
      filt.type            = 'bandpass';
      filt.frequency.value = freq * 1.4;
      filt.Q.value         = 0.7;
      osc.connect(filt);
      filt.connect(g);
      g.connect(gain);
      osc.start(et);
      osc.stop(et + EIGHTH + 0.05);
    });

    // ── Kick drum (beats 1 and 3) — sine thump + noise ────────────────────
    [0, 2].forEach(beat =>
    {
      const bt = t + beat * BEAT;

      // Body: pitched sine sweep 120→40 Hz
      const osc = ctx.createOscillator();
      const og  = ctx.createGain();
      osc.frequency.setValueAtTime(120, bt);
      osc.frequency.exponentialRampToValueAtTime(40, bt + 0.08);
      og.gain.setValueAtTime(0.30, bt);
      og.gain.exponentialRampToValueAtTime(0.001, bt + 0.22);
      osc.connect(og);
      og.connect(gain);
      osc.start(bt);
      osc.stop(bt + 0.25);

      // Click transient
      const ns  = ctx.createBufferSource();
      const buf = this.makeNoiseBuf(0.025);
      const nf  = ctx.createBiquadFilter();
      const ng  = ctx.createGain();
      ns.buffer        = buf;
      nf.type          = 'bandpass';
      nf.frequency.value = 200;
      nf.Q.value         = 1;
      ng.gain.setValueAtTime(0.14, bt);
      ng.gain.exponentialRampToValueAtTime(0.001, bt + 0.025);
      ns.connect(nf);
      nf.connect(ng);
      ng.connect(gain);
      ns.start(bt);
      ns.stop(bt + 0.03);
    });

    // ── Snare (beats 2 and 4) — noise burst + mid sine ────────────────────
    [1, 3].forEach(beat =>
    {
      const bt = t + beat * BEAT;

      const ns  = ctx.createBufferSource();
      const buf = this.makeNoiseBuf(0.18);
      const nf  = ctx.createBiquadFilter();
      const ng  = ctx.createGain();
      ns.buffer          = buf;
      nf.type            = 'highpass';
      nf.frequency.value = 1800;
      ng.gain.setValueAtTime(0.18, bt);
      ng.gain.exponentialRampToValueAtTime(0.001, bt + 0.14);
      ns.connect(nf);
      nf.connect(ng);
      ng.connect(gain);
      ns.start(bt);
      ns.stop(bt + 0.20);

      // Snare body tone
      const osc = ctx.createOscillator();
      const og  = ctx.createGain();
      osc.frequency.value = 210;
      og.gain.setValueAtTime(0.09, bt);
      og.gain.exponentialRampToValueAtTime(0.001, bt + 0.08);
      osc.connect(og);
      og.connect(gain);
      osc.start(bt);
      osc.stop(bt + 0.10);
    });

    // ── Hi-hat (every eighth-note) ────────────────────────────────────────
    for (let i = 0; i < 8; i++)
    {
      const et  = t + i * EIGHTH;
      const ns  = ctx.createBufferSource();
      const buf = this.makeNoiseBuf(0.04);
      const nf  = ctx.createBiquadFilter();
      const ng  = ctx.createGain();
      ns.buffer          = buf;
      nf.type            = 'highpass';
      nf.frequency.value = 8000;
      // Accented on-beats, quiet off-beats
      const vol = (i % 2 === 0) ? 0.055 : 0.028;
      ng.gain.setValueAtTime(vol, et);
      ng.gain.exponentialRampToValueAtTime(0.001, et + 0.035);
      ns.connect(nf);
      nf.connect(ng);
      ng.connect(gain);
      ns.start(et);
      ns.stop(et + 0.04);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private playThud(freq: number, gain: number, duration: number): void
  {
    const ctx = this.ctx!;
    const buf = this.makeNoiseBuf(duration);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = freq * 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain!);
    src.start();
    src.stop(ctx.currentTime + duration + 0.05);

    const osc = ctx.createOscillator();
    const og  = ctx.createGain();
    osc.frequency.value = freq;
    og.gain.setValueAtTime(gain * 0.5, ctx.currentTime);
    og.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration * 0.5);
    osc.connect(og);
    og.connect(this.masterGain!);
    osc.start();
    osc.stop(ctx.currentTime + duration * 0.5 + 0.05);
  }

  private makeNoiseBuf(duration: number): AudioBuffer
  {
    const ctx     = this.ctx!;
    const samples = Math.ceil(ctx.sampleRate * Math.max(0.05, duration));
    const buf     = ctx.createBuffer(1, samples, ctx.sampleRate);
    const data    = buf.getChannelData(0);
    for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }
}
