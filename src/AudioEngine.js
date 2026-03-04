/**
 * AudioEngine
 * Wraps Web Audio API + Meyda feature extraction.
 * Provides real-time FFT data and perceptual features to the rest of the app.
 */

import Meyda from 'meyda';

// Feature set extracted on every frame
const MEYDA_FEATURES = [
  'rms',           // Root mean square – overall loudness / energy
  'zcr',           // Zero-crossing rate – noisiness / percussiveness
  'spectralCentroid',   // Brightness of the sound
  'spectralRolloff',    // High-frequency content
  'mfcc',          // Timbre fingerprint (13 coefficients)
  'chroma',        // Pitch class profile (12 values, one per semitone)
  'perceptualSpread',   // Perceived width of spectrum
  'energy',        // Total signal energy
];

const FFT_SIZE = 2048;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.analyser = null;
    this.beatAnalyser = null;
    this.meydaAnalyser = null;

    // Raw FFT buffers
    this.frequencyData = new Uint8Array(FFT_SIZE / 2);
    this.timeDomainData = new Uint8Array(FFT_SIZE / 2);
    this._beatFreqData  = new Uint8Array(512);    // sized up in _initFromNode
    this._prevSpectrum  = new Float32Array(FFT_SIZE / 2);
    this._spectralFlux  = 0;
    this._fluxEma       = 0;

    // Extracted features (latest frame)
    this.features = {};

    // Beat detection state
    this._energyHistory = new Float32Array(30); // ~0.5 s window – tighter for fast songs
    this._energyPtr = 0;
    this._energyCount = 0;
    this.isBeat = false;
    this._beatCooldown = 0;      // ms – prevents double-triggering
    this.bpm = 0;
    this._beatTimestamps = [];
    this._beatIntervals = [];
    this._bpmEstimate = 0;
    this._lastBeatTime = 0;

    this._started = false;
    this._featureListeners = [];
  }

  /* ── Public API ──────────────────────────────────────────── */

  /**
   * Call SYNCHRONOUSLY during a user-gesture (e.g. button click) to create
   * the AudioContext before any async work begins.  Safe to call multiple times.
   */
  primeContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
  }

  async startMic() {
    this.primeContext();
    await this.ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this._initFromStream(stream);
  }

  async startFile(file) {
    this.primeContext();
    await this.ctx.resume();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.loop = true;
    this._initFromNode(source);
    source.start(0);
  }

  /** Returns normalised [0-1] frequency band energies as Float32Array(8) */
  getBands() {
    const buf = this.frequencyData;
    const len = buf.length;
    const bands = 8;
    const bandSize = Math.floor(len / bands);
    const out = new Float32Array(bands);
    for (let b = 0; b < bands; b++) {
      let sum = 0;
      for (let i = 0; i < bandSize; i++) {
        sum += buf[b * bandSize + i];
      }
      out[b] = (sum / bandSize) / 255;
    }
    return out;
  }

  /** Full normalised FFT spectrum [0-1] */
  getSpectrum() {
    const out = new Float32Array(this.frequencyData.length);
    for (let i = 0; i < out.length; i++) {
      out[i] = this.frequencyData[i] / 255;
    }
    return out;
  }

  /** Time-domain waveform [0-1] */
  getWaveform() {
    const out = new Float32Array(this.timeDomainData.length);
    for (let i = 0; i < out.length; i++) {
      out[i] = this.timeDomainData[i] / 255;
    }
    return out;
  }

  onFeatures(cb) {
    this._featureListeners.push(cb);
  }

  /* ── Private ─────────────────────────────────────────────── */

  _initFromStream(stream) {
    // ctx already created & resumed by startMic()
    const source = this.ctx.createMediaStreamSource(stream);
    this._initFromNode(source);
  }

  _initFromNode(sourceNode) {
    this.source = sourceNode;

    // Analyser for raw FFT
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.75;  // for visuals
    sourceNode.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // Separate analyser with low smoothing for crisp beat detection
    this.beatAnalyser = this.ctx.createAnalyser();
    this.beatAnalyser.fftSize = 1024;
    this.beatAnalyser.smoothingTimeConstant = 0.1;
    sourceNode.connect(this.beatAnalyser);

    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
    this.timeDomainData = new Uint8Array(this.analyser.frequencyBinCount);
    this._beatFreqData = new Uint8Array(this.beatAnalyser.frequencyBinCount);
    this._prevSpectrum = new Float32Array(this.analyser.frequencyBinCount);
    this._spectralFlux = 0;
    this._fluxEma = 0;
    this._energyHistory.fill(0);
    this._energyPtr = 0;
    this._energyCount = 0;
    this._beatTimestamps = [];
    this._beatIntervals = [];
    this._bpmEstimate = 0;
    this.bpm = 0;
    this._lastBeatTime = 0;

    // Meyda for perceptual features
    this.meydaAnalyser = Meyda.createMeydaAnalyzer({
      audioContext: this.ctx,
      source: sourceNode,
      bufferSize: 512,
      featureExtractors: MEYDA_FEATURES,
      callback: (feats) => this._onMeydaFeatures(feats),
    });
    this.meydaAnalyser.start();

    this._started = true;
    this._tick();
  }

  _tick() {
    if (!this._started) return;
    this.analyser.getByteFrequencyData(this.frequencyData);
    this.analyser.getByteTimeDomainData(this.timeDomainData);
    this.beatAnalyser.getByteFrequencyData(this._beatFreqData);
    this._updateSpectralFlux();
    this._detectBeat();
    requestAnimationFrame(() => this._tick());
  }

  _updateSpectralFlux() {
    const spec = this.frequencyData;
    const prev = this._prevSpectrum;

    if (!spec || !prev || spec.length !== prev.length) {
      this._spectralFlux = 0;
      this._fluxEma *= 0.95;
      return;
    }

    let flux = 0;
    for (let i = 0; i < spec.length; i++) {
      const curr = spec[i] / 255;
      const delta = curr - prev[i];
      if (delta > 0) flux += delta;
      prev[i] = curr;
    }

    flux /= spec.length || 1;
    this._spectralFlux = flux;
    this._fluxEma = this._fluxEma * 0.82 + flux * 0.18;
  }

  _onMeydaFeatures(feats) {
    if (!feats) return;

    const safeFeatures = {
      ...feats,
      spectralFlux: Number.isFinite(feats.spectralFlux) ? feats.spectralFlux : this._fluxEma,
    };

    this.features = safeFeatures;
    for (const cb of this._featureListeners) cb(safeFeatures);
  }

  _detectBeat() {
    // Use low-smoothing beat analyser: bottom 12% of bins = bass/kick range
    const data   = this._beatFreqData;
    const bassEnd = Math.floor(data.length * 0.12);
    let bassEnergy = 0;
    for (let i = 1; i < bassEnd; i++) {
      bassEnergy += (data[i] / 255) ** 2;
    }
    bassEnergy /= (bassEnd - 1);

    const hist = this._energyHistory;
    const histLen = hist.length;
    const filled = Math.min(this._energyCount, histLen);

    let avgEnergy = 0;
    if (filled > 0) {
      for (let i = 0; i < filled; i++) avgEnergy += hist[i];
      avgEnergy /= filled;
    }

    let variance = 0;
    if (filled > 0) {
      for (let i = 0; i < filled; i++) {
        const d = hist[i] - avgEnergy;
        variance += d * d;
      }
      variance /= filled;
    }

    const stdDev = Math.sqrt(variance);
    const threshold = Math.max(avgEnergy + stdDev * 1.05, avgEnergy * 1.08 + 0.0028);
    const now = performance.now();
    const wasBeat = this.isBeat;

    const cooldownMs = this._bpmEstimate > 0
      ? Math.max(190, 60000 / (this._bpmEstimate * 1.9))
      : 200;
    const cooldownOk = (now - (this._lastBeatTime ?? 0)) > cooldownMs;
    this.isBeat = bassEnergy > threshold && bassEnergy > 0.005 && cooldownOk;

    hist[this._energyPtr] = bassEnergy;
    this._energyPtr = (this._energyPtr + 1) % histLen;
    this._energyCount = Math.min(this._energyCount + 1, histLen);

    if (this.isBeat && !wasBeat) {
      const intervalMs = this._lastBeatTime > 0 ? now - this._lastBeatTime : 0;
      this._lastBeatTime = now;
      this._beatTimestamps.push(now);
      if (this._beatTimestamps.length > 16) this._beatTimestamps.shift();

      if (intervalMs >= 190 && intervalMs <= 2000) {
        this._beatIntervals.push(intervalMs);
        if (this._beatIntervals.length > 20) this._beatIntervals.shift();
      }

      if (this._beatIntervals.length >= 4) {
        const normalized = this._beatIntervals
          .map((ms) => {
            let bpm = 60000 / ms;
            while (bpm < 70) bpm *= 2;
            while (bpm > 190) bpm /= 2;
            return bpm;
          })
          .filter((bpm) => bpm >= 70 && bpm <= 190)
          .sort((a, b) => a - b);

        if (normalized.length) {
          const q1 = normalized[Math.floor((normalized.length - 1) * 0.25)];
          const q3 = normalized[Math.floor((normalized.length - 1) * 0.75)];
          const iqr = Math.max(1, q3 - q1);
          const filtered = normalized.filter((bpm) => bpm >= q1 - iqr && bpm <= q3 + iqr);
          const target = filtered.reduce((s, v) => s + v, 0) / (filtered.length || 1);

          let corrected = target;
          if (this._bpmEstimate > 0) {
            const candidates = [target, target * 2, target / 2]
              .filter((bpm) => bpm >= 70 && bpm <= 190);
            if (candidates.length) {
              corrected = candidates.reduce((best, cand) => {
                return Math.abs(cand - this._bpmEstimate) < Math.abs(best - this._bpmEstimate) ? cand : best;
              }, candidates[0]);
            }
          }

          this._bpmEstimate = this._bpmEstimate > 0
            ? this._bpmEstimate * 0.78 + corrected * 0.22
            : corrected;

          this.bpm = Math.round(Math.max(50, Math.min(220, this._bpmEstimate)));
        }
      }
    }
  }
}
