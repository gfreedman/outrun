/**
 * audio.ts
 *
 * AudioManager — all game sounds generated via the Web Audio API.
 *
 * Architecture
 * ────────────
 * Three engine oscillators (sawtooth) run through a WaveShaper (distortion)
 * then a lowpass filter tracking RPM — gives organic V8 growl, not a buzz.
 * One-shots (beep, crash) are spawned as transient nodes.
 * A rumble oscillator is toggled on/off when the player goes off-road.
 * A persistent screech loop (noise + bandpass) fades in/out with corner load.
 * Background music is a scheduled 4-bar OutRun-style synth loop.
 */

// ── Music pattern constants ──────────────────────────────────────────────────
//
// Inspired by Hiroshi Kawaguchi's OutRun OST (Magical Sound Shower / Passing Breeze).
//
// Key design decisions vs. the old implementation:
//   OLD: Scale runs (A B C# E D…) → sounds like Zelda/fantasy.
//   NEW: Arpeggio leaps + stepwise resolution → OutRun city-pop / boogie character.
//
//   OLD: 4 quarter-note bass hits → static and tame.
//   NEW: 8 eighth-note bass hits, root/fifth bounce → propulsive Caribbean groove.
//
//   OLD: No chord stabs → lacks the signature OutRun off-beat punch.
//   NEW: Staccato triads on the "and" of beats 1 & 3 → instant OutRun recognition.
//
//   OLD: Music gain 0.10 (buried under engine).
//   NEW: Music gain 0.33 (dominant, as in the arcade cabinet).
//
//   OLD: 155 BPM — slightly rushed.
//   NEW: 140 BPM — Magical Sound Shower authentic pace.

const BPM       = 140;
const BEAT      = 60 / BPM;       // ≈ 0.429 s
const EIGHTH    = BEAT / 2;       // ≈ 0.214 s
const SIXTEENTH = BEAT / 4;       // ≈ 0.107 s
const BAR       = BEAT * 4;       // ≈ 1.714 s

// D major — warm, driving, OutRun sunshine palette.
// Chord cycle: I (D) → IV (G) → V (A) → I (D)
const D2  =  73.42;
const G2  =  98.00;
const A2  = 110.00;
const B2  = 123.47;
const D3  = 146.83;
const E3  = 164.81;
const F3s = 185.00;
const G3  = 196.00;
const A3  = 220.00;
const B3  = 246.94;
const C4s = 277.18;
const D4  = 293.66;
const E4  = 329.63;
const F4s = 369.99;
const G4  = 392.00;
const A4  = 440.00;
const B4  = 493.88;
const C5s = 554.37;
const D5  = 587.33;
const E5  = 659.25;
const F5s = 739.99;
const A5  = 880.00;

// ── Lead melody (8 eighth notes per bar) ─────────────────────────────────────
// Arpeggio leaps + stepwise resolution — the OutRun melodic fingerprint.
// Each bar has a distinct emotional colour: launch / answer / climb / resolve.
const MELODY: number[][] = [
  [D5,  F5s, A5,  F5s, D5,  A4,  F4s, A4 ],  // I   — D: arpeggio launch, bounce back
  [B4,  D5,  G4,  B4,  D5,  G4,  B4,  D5 ],  // IV  — G: call-and-answer riff
  [A4,  C5s, E5,  A5,  E5,  C5s, A4,  E4 ],  // V   — A: climbing tension arc
  [F5s, D5,  A4,  F4s, D4,  F4s, A4,  D5 ],  // I   — D: sweeping resolution
];

// ── Bass (8 eighth notes per bar) ────────────────────────────────────────────
// Root/fifth bounce on every eighth — the OutRun groove foundation.
const BASS: number[][] = [
  [D2,  D3,  A2,  D3,  D2,  A2,  D3,  A2 ],  // I   — D root/fifth
  [G2,  G3,  D3,  G2,  G3,  D3,  B2,  G2 ],  // IV  — G with B2 colour note
  [A2,  A3,  E3,  A2,  A3,  E3,  C4s, A2 ],  // V   — A with C#4 tension
  [D2,  A2,  D3,  A2,  F3s, D3,  A2,  D2 ],  // I   — D full resolution
];

// ── Chord stabs (triads hit on off-beats) ────────────────────────────────────
// "And" of beats 1 and 3: the signature OutRun rhythmic punch.
const STAB_CHORDS: number[][] = [
  [D4,  F4s, A4 ],  // D major
  [G3,  B3,  D4 ],  // G major
  [A3,  C4s, E4 ],  // A major
  [D4,  F4s, A4 ],  // D resolve
];

// ── Arpeggio (16th-note YM2151 FM-chip shimmer) ───────────────────────────────
const ARPEGGIO: number[][] = [
  [D4,  F4s, A4,  D5 ],  // D major
  [G3,  B3,  D4,  G4 ],  // G major
  [A3,  C4s, E4,  A4 ],  // A major
  [D4,  A4,  F4s, D5 ],  // D (mirrored)
];

// ────────────────────────────────────────────────────────────────────────────

export class AudioManager
{
  private ctx:         AudioContext | null = null;
  private masterGain:  GainNode    | null = null;
  private enabled      = true;
  private initialized  = false;

  // ── Engine oscillators ──────────────────────────────────────────────────
  // Three harmonics: fundamental (f), 2f, 3f.
  // Signal chain: sawtooth oscs → individual gains → WaveShaper (distortion)
  // → lowpass filter (RPM-tracked) → master engine gain.
  // Distortion adds harmonic richness; low cutoff ceiling kills the whine.

  private engFundOsc:    OscillatorNode  | null = null;  // 1f
  private eng2ndOsc:     OscillatorNode  | null = null;  // 2f
  private eng3rdOsc:     OscillatorNode  | null = null;  // 3f
  private engFundGain:   GainNode        | null = null;
  private eng2ndGain:    GainNode        | null = null;
  private eng3rdGain:    GainNode        | null = null;
  private engDistortion: WaveShaperNode  | null = null;
  private engFilter:     BiquadFilterNode| null = null;
  private engMasterGain: GainNode        | null = null;

  // ── Off-road rumble ────────────────────────────────────────────────────

  private rumbleOsc:   OscillatorNode | null = null;
  private rumbleGain:  GainNode       | null = null;

  // ── Tire screech (persistent loop, gain-controlled) ───────────────────

  private screechGain: GainNode | null = null;

  // ── Background music ──────────────────────────────────────────────────

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
    this.startPersistentScreech();
  }

  setEnabled(v: boolean): void
  {
    this.enabled = v;
    if (this.masterGain) this.masterGain.gain.value = v ? 1 : 0;
  }

  // ── Engine ────────────────────────────────────────────────────────────────

  /**
   * Returns a soft-clipping distortion curve.
   * `amount` controls saturation intensity (50 = light, 200 = heavy).
   */
  private makeDistortionCurve(amount: number): Float32Array
  {
    const n    = 256;
    const curve = new Float32Array(n);
    const k    = amount;
    for (let i = 0; i < n; i++)
    {
      const x    = (i * 2) / n - 1;
      curve[i]   = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  private startEngineOscillators(): void
  {
    const ctx = this.ctx!;

    // Highpass at 20 Hz — removes inaudible DC / sub-bass mud
    const hipass = ctx.createBiquadFilter();
    hipass.type            = 'highpass';
    hipass.frequency.value = 20;

    // Shared lowpass filter — cutoff tracks RPM; ceiling is 650 Hz (no whine)
    const filt = ctx.createBiquadFilter();
    filt.type            = 'lowpass';
    filt.frequency.value = 150;  // very dark at idle
    filt.Q.value         = 1.6;
    this.engFilter = filt;

    // WaveShaper distortion — organic saturation, adds growl harmonics
    const shaper = ctx.createWaveShaper();
    shaper.curve     = this.makeDistortionCurve(120);
    shaper.oversample = '2x';
    this.engDistortion = shaper;

    // Master engine gain (post-filter)
    const master = ctx.createGain();
    master.gain.value = 0;
    this.engMasterGain = master;

    // Chain: distortion → highpass → filter → master → destination
    shaper.connect(hipass);
    hipass.connect(filt);
    filt.connect(master);
    master.connect(this.masterGain!);

    // Build each harmonic: sawtooth → individual gain → distortion input
    const makeHarmonic = (baseFreq: number, initGain: number): [OscillatorNode, GainNode] =>
    {
      const osc  = ctx.createOscillator();
      const g    = ctx.createGain();
      osc.type            = 'sawtooth';
      osc.frequency.value = baseFreq;
      g.gain.value        = initGain;
      osc.connect(g);
      g.connect(shaper);
      osc.start();
      return [osc, g];
    };

    // Fundamental: 25 Hz idle → 65 Hz at top speed (deep, chest-thumping)
    [this.engFundOsc, this.engFundGain] = makeHarmonic(25,  1.0);
    // 2nd harmonic: 2× fundamental — body of the V8 motor
    [this.eng2ndOsc,  this.eng2ndGain]  = makeHarmonic(50,  0.8);
    // 3rd harmonic: 3× fundamental — bite and snarl at high RPM
    [this.eng3rdOsc,  this.eng3rdGain]  = makeHarmonic(75,  0.4);
  }

  /**
   * Called each frame with the current speed ratio (0–1).
   * Fundamental: 25 Hz (idle) → 65 Hz (redline).
   * Filter cutoff: 150 Hz → 650 Hz — bright enough to hear, no whine.
   */
  updateEngine(speedRatio: number): void
  {
    if (!this.initialized || !this.ctx) return;

    const now = this.ctx.currentTime;
    const T   = 0.07;   // smoothing time constant

    if (speedRatio < 0.01)
    {
      if (this.engMasterGain)
        this.engMasterGain.gain.setTargetAtTime(0, now, T);
      return;
    }

    // Fundamental: deep idle to growling top-end
    const fundamental = 25 + speedRatio * 40;   // 25 → 65 Hz

    this.engFundOsc!.frequency.setTargetAtTime(fundamental,     now, T);
    this.eng2ndOsc! .frequency.setTargetAtTime(fundamental * 2, now, T);
    this.eng3rdOsc! .frequency.setTargetAtTime(fundamental * 3, now, T);

    // Filter cutoff: opens up with RPM, hard-capped at 650 Hz (no whine)
    const cutoff = 150 + speedRatio * speedRatio * 500;  // 150 → 650 Hz
    this.engFilter!.frequency.setTargetAtTime(cutoff, now, T * 2);

    // Master volume — gentle ramp from quiet idle to solid driving level
    const vol = 0.05 + speedRatio * 0.25;
    this.engMasterGain!.gain.setTargetAtTime(vol, now, T);

    // Harmonic mix: emphasise 2nd harmonic (V8 character); 3rd grows at high RPM
    this.engFundGain!.gain.setTargetAtTime(1.0,                      now, T);
    this.eng2ndGain! .gain.setTargetAtTime(0.75 + speedRatio * 0.15, now, T);
    this.eng3rdGain! .gain.setTargetAtTime(0.25 + speedRatio * 0.40, now, T);
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

  // ── Tire screech (persistent, gain-controlled) ────────────────────────────

  /**
   * Creates a looping noise → bandpass node at startup with gain = 0.
   * updateScreech() adjusts gain each frame — no node spawning on each call.
   */
  private startPersistentScreech(): void
  {
    const ctx    = this.ctx!;
    const buf    = this.makeNoiseBuf(2.0);  // 2 s noise buffer, looped
    const src    = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain   = ctx.createGain();

    src.buffer = buf;
    src.loop   = true;

    // Bandpass centred on 1500 Hz with narrow Q — cuts through engine noise
    filter.type            = 'bandpass';
    filter.frequency.value = 1500;
    filter.Q.value         = 5;

    gain.gain.value = 0;   // silent until updateScreech raises it

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain!);
    src.start();

    this.screechGain = gain;
  }

  /**
   * Call every physics frame with the lateral grip ratio (centForce / availGrip).
   * ratio < 0.5  → silent
   * ratio 0.5–1.0 → fade in
   * ratio ≥ 1.0  → full screech
   * Pass 0 when off a curve or below speed threshold.
   */
  updateScreech(lateralRatio: number): void
  {
    if (!this.initialized || !this.ctx || !this.screechGain) return;

    const ONSET    = 0.50;  // ratio at which screech begins
    const MAX_GAIN = 0.32;  // loudness at full grip saturation

    const t       = Math.max(0, (lateralRatio - ONSET) / (1.0 - ONSET));
    const target  = Math.min(1, t) * MAX_GAIN;

    this.screechGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.06);
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
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // ── Low thud — body impact ─────────────────────────────────────────────
    this.playThud(110, 0.18, 0.30);

    // ── Mid scrape — metal on asphalt, 600–1400 Hz bandpass ───────────────
    const scrapeBuf = this.makeNoiseBuf(0.45);
    const scrapeSrc = ctx.createBufferSource();
    scrapeSrc.buffer = scrapeBuf;
    const scrapeF = ctx.createBiquadFilter();
    scrapeF.type            = 'bandpass';
    scrapeF.frequency.value = 950;
    scrapeF.Q.value         = 0.8;
    const scrapeG = ctx.createGain();
    scrapeG.gain.setValueAtTime(0.20, now);
    scrapeG.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    scrapeSrc.connect(scrapeF);
    scrapeF.connect(scrapeG);
    scrapeG.connect(this.masterGain!);
    scrapeSrc.start(now);
    scrapeSrc.stop(now + 0.50);

    // ── High scratch — glass / debris, >4 kHz, short burst ────────────────
    const scratchBuf = this.makeNoiseBuf(0.18);
    const scratchSrc = ctx.createBufferSource();
    scratchSrc.buffer = scratchBuf;
    const scratchF = ctx.createBiquadFilter();
    scratchF.type            = 'highpass';
    scratchF.frequency.value = 4200;
    const scratchG = ctx.createGain();
    scratchG.gain.setValueAtTime(0.14, now);
    scratchG.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    scratchSrc.connect(scratchF);
    scratchF.connect(scratchG);
    scratchG.connect(this.masterGain!);
    scratchSrc.start(now);
    scratchSrc.stop(now + 0.22);
  }

  playCrashObject(): void
  {
    if (!this.initialized || !this.ctx) return;
    this.playThud(200, 0.11, 0.25);
  }

  playBarney(): void
  {
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance('Oh no!');
    u.pitch  = 1.4;   // slightly goofy high pitch
    u.rate   = 0.85;  // slightly slower than normal — exaggerated cartoon delivery
    u.volume = 1.0;
    speechSynthesis.speak(u);
  }

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
    this.musicGain.gain.linearRampToValueAtTime(0.33, this.ctx.currentTime + 1.5);
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
   * Schedules upcoming bars to keep the buffer ahead of playback.
   */
  tickMusic(): void
  {
    if (!this.initialized || !this.ctx || !this.musicPlaying || !this.musicGain) return;

    const now = this.ctx.currentTime;
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

    // ── Lead melody (sawtooth + resonant lowpass — bright FM arcade lead) ─
    // Staccato: 50% duty, very fast attack — punchy not smooth.
    // Arpeggio leaps give OutRun character vs. the old scale-run approach.
    MELODY[bar].forEach((freq, i) =>
    {
      const osc  = ctx.createOscillator();
      const filt = ctx.createBiquadFilter();
      const g    = ctx.createGain();

      osc.type             = 'sawtooth';
      osc.frequency.value  = freq;
      filt.type            = 'lowpass';
      filt.frequency.value = freq * 3.0;  // brighter than before
      filt.Q.value         = 6;

      const et = t + i * EIGHTH;
      g.gain.setValueAtTime(0,    et);
      g.gain.linearRampToValueAtTime(0.22, et + 0.003);  // snappy 3 ms attack
      g.gain.setValueAtTime(0.22, et + EIGHTH * 0.48);   // hard staccato cut
      g.gain.linearRampToValueAtTime(0,   et + EIGHTH * 0.68);

      osc.connect(filt); filt.connect(g); g.connect(gain);
      osc.start(et); osc.stop(et + EIGHTH + 0.01);
    });

    // ── Bass (sawtooth + tight lowpass — 8th-note root/fifth bounce) ──────
    // 8 eighth notes per bar (not 4 quarter notes) = the OutRun groove feel.
    BASS[bar].forEach((freq, i) =>
    {
      const osc  = ctx.createOscillator();
      const filt = ctx.createBiquadFilter();
      const g    = ctx.createGain();

      osc.type             = 'sawtooth';
      osc.frequency.value  = freq;
      filt.type            = 'lowpass';
      filt.frequency.value = 520;
      filt.Q.value         = 2.5;

      const et = t + i * EIGHTH;
      g.gain.setValueAtTime(0,    et);
      g.gain.linearRampToValueAtTime(0.38, et + 0.006);  // very fast slap attack
      g.gain.setValueAtTime(0.38, et + EIGHTH * 0.38);   // staccato
      g.gain.linearRampToValueAtTime(0,   et + EIGHTH * 0.62);

      osc.connect(filt); filt.connect(g); g.connect(gain);
      osc.start(et); osc.stop(et + EIGHTH + 0.01);
    });

    // ── Chord stabs (square + bandpass — off-beat OutRun punch) ───────────
    // "And" of beat 1 (0.5×BEAT) and "and" of beat 3 (2.5×BEAT).
    // Three simultaneous oscillators = full triad stab.
    [0.5, 2.5].forEach(pos =>
    {
      const et = t + pos * BEAT;
      STAB_CHORDS[bar].forEach(freq =>
      {
        const osc  = ctx.createOscillator();
        const filt = ctx.createBiquadFilter();
        const g    = ctx.createGain();
        osc.type             = 'square';
        osc.frequency.value  = freq;
        filt.type            = 'bandpass';
        filt.frequency.value = freq * 1.8;
        filt.Q.value         = 0.7;
        g.gain.setValueAtTime(0,    et);
        g.gain.linearRampToValueAtTime(0.09, et + 0.004);
        g.gain.exponentialRampToValueAtTime(0.001, et + 0.11);
        osc.connect(filt); filt.connect(g); g.connect(gain);
        osc.start(et); osc.stop(et + 0.13);
      });
    });

    // ── Arpeggio (16th-note YM2151 FM-chip shimmer — texture layer) ───────
    const arpNotes = ARPEGGIO[bar];
    for (let i = 0; i < 16; i++)
    {
      const freq = arpNotes[i % 4];
      const et   = t + i * SIXTEENTH;
      const osc  = ctx.createOscillator();
      const filt = ctx.createBiquadFilter();
      const g    = ctx.createGain();
      osc.type             = 'square';
      osc.frequency.value  = freq;
      filt.type            = 'bandpass';
      filt.frequency.value = freq * 2.0;
      filt.Q.value         = 1.2;
      g.gain.setValueAtTime(0,     et);
      g.gain.linearRampToValueAtTime(0.042, et + 0.004);
      g.gain.setValueAtTime(0.042, et + SIXTEENTH * 0.50);
      g.gain.linearRampToValueAtTime(0,     et + SIXTEENTH * 0.75);
      osc.connect(filt); filt.connect(g); g.connect(gain);
      osc.start(et); osc.stop(et + SIXTEENTH + 0.01);
    }

    // ── Kick drum (4-on-the-floor — hard, arcade-cabinet thump) ──────────
    for (let beat = 0; beat < 4; beat++)
    {
      const bt = t + beat * BEAT;
      // Body: pitched sine 120→38 Hz
      const osc = ctx.createOscillator();
      const og  = ctx.createGain();
      osc.frequency.setValueAtTime(120, bt);
      osc.frequency.exponentialRampToValueAtTime(38, bt + 0.08);
      og.gain.setValueAtTime(0.50, bt);
      og.gain.exponentialRampToValueAtTime(0.001, bt + 0.22);
      osc.connect(og); og.connect(gain);
      osc.start(bt); osc.stop(bt + 0.25);
      // Click transient
      const ns  = ctx.createBufferSource();
      ns.buffer = this.makeNoiseBuf(0.02);
      const nf  = ctx.createBiquadFilter();
      const ng  = ctx.createGain();
      nf.type = 'bandpass'; nf.frequency.value = 200; nf.Q.value = 1;
      ng.gain.setValueAtTime(0.20, bt);
      ng.gain.exponentialRampToValueAtTime(0.001, bt + 0.018);
      ns.connect(nf); nf.connect(ng); ng.connect(gain);
      ns.start(bt); ns.stop(bt + 0.025);
    }

    // ── Snare (beats 2 & 4) — crisp noise burst + pitched body ───────────
    [1, 3].forEach(beat =>
    {
      const bt = t + beat * BEAT;
      const ns  = ctx.createBufferSource();
      ns.buffer = this.makeNoiseBuf(0.14);
      const nf  = ctx.createBiquadFilter();
      const ng  = ctx.createGain();
      nf.type = 'highpass'; nf.frequency.value = 2200;
      ng.gain.setValueAtTime(0.30, bt);
      ng.gain.exponentialRampToValueAtTime(0.001, bt + 0.10);
      ns.connect(nf); nf.connect(ng); ng.connect(gain);
      ns.start(bt); ns.stop(bt + 0.15);
      // Snare body tone
      const osc = ctx.createOscillator();
      const og  = ctx.createGain();
      osc.frequency.value = 250;
      og.gain.setValueAtTime(0.14, bt);
      og.gain.exponentialRampToValueAtTime(0.001, bt + 0.06);
      osc.connect(og); og.connect(gain);
      osc.start(bt); osc.stop(bt + 0.07);
    });

    // ── Cowbell (beat 2 "and" & beat 4 "and" — OutRun Latin signature) ───
    // 562 Hz square with fast decay: the unmistakable arcade cowbell hit.
    [1.5, 3.5].forEach(pos =>
    {
      const et  = t + pos * BEAT;
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.type = 'square'; osc.frequency.value = 562;
      g.gain.setValueAtTime(0.13, et);
      g.gain.exponentialRampToValueAtTime(0.001, et + 0.07);
      osc.connect(g); g.connect(gain);
      osc.start(et); osc.stop(et + 0.08);
    });

    // ── Hi-hat (16th notes — dense pattern, OutRun energy driver) ────────
    for (let i = 0; i < 16; i++)
    {
      const et  = t + i * SIXTEENTH;
      const ns  = ctx.createBufferSource();
      ns.buffer = this.makeNoiseBuf(0.025);
      const nf  = ctx.createBiquadFilter();
      const ng  = ctx.createGain();
      nf.type = 'highpass'; nf.frequency.value = 9500;
      const vol = (i % 4 === 0) ? 0.070 : (i % 2 === 0) ? 0.040 : 0.018;
      ng.gain.setValueAtTime(vol, et);
      ng.gain.exponentialRampToValueAtTime(0.001, et + 0.022);
      ns.connect(nf); nf.connect(ng); ng.connect(gain);
      ns.start(et); ns.stop(et + 0.028);
    }

    // ── Open hi-hat accent ("and" of beats 1 & 3 — with chord stabs) ─────
    [0.5, 2.5].forEach(pos =>
    {
      const et  = t + pos * BEAT;
      const ns  = ctx.createBufferSource();
      ns.buffer = this.makeNoiseBuf(0.11);
      const nf  = ctx.createBiquadFilter();
      const ng  = ctx.createGain();
      nf.type = 'highpass'; nf.frequency.value = 7000;
      ng.gain.setValueAtTime(0.044, et);
      ng.gain.exponentialRampToValueAtTime(0.001, et + 0.10);
      ns.connect(nf); nf.connect(ng); ng.connect(gain);
      ns.start(et); ns.stop(et + 0.12);
    });
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
