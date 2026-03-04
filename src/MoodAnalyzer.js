/**
 * MoodAnalyzer
 *
 * Real-time mood / tone classification from Meyda audio features.
 *
 * Architecture:
 *   1.  Extract a normalised feature vector each frame.
 *   2.  Compute weighted scores for 6 mood archetypes.
 *   3.  Blend over time (exponential moving average) so transitions are smooth.
 *   4.  Output a `MoodState` object consumed by ThemeController.
 *
 * The six moods and their visual personalities:
 *   energetic  – fast, bright, warm (reds / oranges)
 *   euphoric   – soaring, saturated (purples / pinks)
 *   calm       – slow, cool, flowing (teals / blues)
 *   melancholic– heavy, dark, slow (deep blues / indigo)
 *   aggressive – sharp, fast, high-contrast (red / white)
 *   mysterious – dark, sparse, shifting (dark purple / cyan)
 */

// Smooth factor – higher = slower transitions (0-1)
const SMOOTH = 0.70;  // fast enough to react within a bar

// Feature targets per mood
//  [ energy, zcr, spectralCentroid_norm, spectralFlux, mfcc0_norm, chromaVariance ]
// mfcc0 reflects "density/fullness" more than valence, so melancholic should not peak on it.
const MOOD_PROFILES = {
  energetic:  [0.86, 0.56, 0.70, 0.80, 0.62, 0.38],
  euphoric:   [0.72, 0.42, 0.82, 0.56, 0.52, 0.88],
  calm:       [0.24, 0.18, 0.34, 0.14, 0.36, 0.30],
  melancholic:[0.14, 0.14, 0.24, 0.10, 0.26, 0.24],
  aggressive: [0.94, 0.82, 0.62, 0.94, 0.68, 0.14],
  mysterious: [0.34, 0.28, 0.48, 0.30, 0.46, 0.74],
};

const MOOD_KEYS = Object.keys(MOOD_PROFILES);

export class MoodAnalyzer {
  constructor() {
    // Smoothed scores per mood [0-1]
    this.scores = Object.fromEntries(MOOD_KEYS.map(k => [k, 1 / MOOD_KEYS.length]));

    // Current dominant mood
    this.mood = 'calm';
    this.confidence = 0;

    // Smoothed feature vector
    this._smoothed = new Float32Array(6);

    // Rolling spectral centroid for normalisation
    this._centroidHistory = [];
    this._centroidMax = 8000; // Hz estimate, will adapt

    // Adaptive per-feature peaks to keep values in useful ranges across songs
    this._featurePeaks = {
      energy: 0.08,
      zcr: 40,
      flux: 0.01,
      chromaVar: 0.01,
    };
  }

  /**
   * Feed latest Meyda feature snapshot.
   * Call this every time Meyda fires (every ~512 samples).
   */
  update(features, audioEngine) {
    if (!features) return;

    const vec = this._buildVector(features);

    // Exponential smoothing of each feature
    for (let i = 0; i < 6; i++) {
      this._smoothed[i] = this._smoothed[i] * SMOOTH + vec[i] * (1 - SMOOTH);
    }

    const sv = this._smoothed;

    // Score each mood via cosine-style weighted similarity
    const rawScores = {};
    for (const mood of MOOD_KEYS) {
      const profile = MOOD_PROFILES[mood];
      let score = 0;
      for (let i = 0; i < 6; i++) {
        score += (1 - Math.abs(sv[i] - profile[i])) / 6;
      }
      // Power sharpen improves mood contrast so we don't hover around one neutral class
      rawScores[mood] = Math.pow(Math.max(0.0001, score), 2.1);
    }

    // Context priors: avoid melancholic over-triggering on mid-tempo, high-drive tracks.
    const bpm = audioEngine?.bpm ?? 0;
    const tempoNorm = bpm > 0 ? clamp((bpm - 72) / 92) : 0.5;
    const drive = clamp(
      sv[0] * 0.52 +
      sv[3] * 0.28 +
      sv[1] * 0.12 +
      sv[2] * 0.08
    );
    const darkness = clamp((1 - sv[2]) * 0.62 + (1 - sv[3]) * 0.38);

    const priors = {
      energetic:   1 + drive * 0.55 + tempoNorm * 0.18,
      euphoric:    1 + sv[2] * 0.20 + sv[5] * 0.26 + tempoNorm * 0.10,
      calm:        1 + (1 - drive) * 0.20 + (1 - tempoNorm) * 0.16,
      melancholic: 1 + darkness * 0.45 + (1 - drive) * 0.18 + (1 - tempoNorm) * 0.22 - drive * 0.62 - tempoNorm * 0.38,
      aggressive:  1 + drive * 0.62 + sv[1] * 0.18 + tempoNorm * 0.12,
      mysterious:  1 + darkness * 0.18 + sv[5] * 0.30 + (1 - tempoNorm) * 0.08,
    };

    for (const mood of MOOD_KEYS) {
      rawScores[mood] *= clamp(priors[mood] ?? 1, 0.25, 2.0);
    }

    // Normalise to sum=1, then smooth over time
    const total = Object.values(rawScores).reduce((a, b) => a + b, 0) || 1;
    for (const mood of MOOD_KEYS) {
      const target = rawScores[mood] / total;
      this.scores[mood] = this.scores[mood] * 0.58 + target * 0.42;  // fast reaction
    }

    // Dominant mood
    let best = 'calm', bestScore = 0;
    for (const mood of MOOD_KEYS) {
      if (this.scores[mood] > bestScore) {
        bestScore = this.scores[mood];
        best = mood;
      }
    }
    this.mood = best;
    this.confidence = bestScore;
  }

  /**
   * Returns a fully interpolated `MoodState` object.
   * All numeric fields are smooth floats ready for visual use.
   */
  getMoodState(audioEngine) {
    const scores = this.scores;
    const s = this._smoothed;

    return {
      mood:         this.mood,
      confidence:   this.confidence,
      scores:       { ...scores },

      // -- Derived visual parameters (all [0-1]) --
      energy:       clamp(s[0]),
      noisiness:    clamp(s[1]),
      brightness:   clamp(s[2]),
      flux:         clamp(s[3]),
      warmth:       clamp(scores.energetic + scores.aggressive * 0.5 - scores.calm * 0.3),
      mysticism:    clamp(scores.mysterious + scores.melancholic * 0.5),
      euphoria:     clamp(scores.euphoric),

      // -- Speed: fast for energetic/aggressive, slow for calm/melancholic --
      speed: clamp(
        scores.energetic * 1.0 +
        scores.aggressive * 1.2 +
        scores.euphoric * 0.7 -
        scores.calm * 0.5 -
        scores.melancholic * 0.3
      ),

      // BPM smoothed
      bpm: audioEngine?.bpm ?? 0,

      // Beat pulse [0-1]
      beatPulse: audioEngine?.isBeat ? 1 : 0,
    };
  }

  /* ── Private ─────────────────────────────────────────────── */

  _buildVector(f) {
    // RMS loudness – adaptively normalised per song dynamics
    const rms = Math.max(0, f.rms ?? 0);
    const energy = this._adaptiveNorm(rms, 'energy', 0.08, 0.996, 1.10);

    // ZCR: support both count-scale and pre-normalized variants
    let zcrRaw = f.zcr ?? 0;
    if (zcrRaw <= 1.2) zcrRaw *= 512;
    const zcr = this._adaptiveNorm(zcrRaw, 'zcr', 40, 0.996, 1.06);

    // Spectral centroid: adaptive max normalisation
    const cent = f.spectralCentroid ?? 0;
    this._centroidMax = Math.max(1800, this._centroidMax * 0.998, cent * 1.06);
    const centNorm = clamp(cent / (this._centroidMax || 8000));

    // Spectral flux: provided by AudioEngine as safe normalized onset proxy
    const fluxRaw = Math.max(0, f.spectralFlux ?? 0);
    const flux = this._adaptiveNorm(fluxRaw, 'flux', 0.01, 0.995, 1.12);

    // MFCC[0] – large negative for quiet/sparse, large positive for dense/loud.
    // Compress with tanh so one feature cannot dominate mood selection.
    const mfcc0 = clamp((Math.tanh((f.mfcc?.[0] ?? 0) / 140) + 1) * 0.5);

    // Chroma variance: values in [0,1], max variance = 0.25, normalise to [0,1]
    const chroma = f.chroma ?? new Array(12).fill(0);
    const chromaMean = chroma.reduce((a, b) => a + b, 0) / 12;
    const chromaVarRaw = chroma.reduce((a, b) => a + (b - chromaMean) ** 2, 0) / 12;
    const chromaVar = this._adaptiveNorm(chromaVarRaw, 'chromaVar', 0.01, 0.997, 1.10);

    return [energy, zcr, centNorm, flux, mfcc0, chromaVar];
  }

  _adaptiveNorm(value, key, floor = 1, decay = 0.996, growth = 1.08) {
    const prevPeak = this._featurePeaks[key] ?? floor;
    const nextPeak = Math.max(floor, prevPeak * decay, value * growth);
    this._featurePeaks[key] = nextPeak;
    return clamp(value / nextPeak);
  }
}

function clamp(v, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, v || 0));
}
