/**
 * ThemeController
 *
 * Maps MoodState → visual parameters (colour palettes, bloom, speed, etc.)
 * All transitions are smoothed so visuals never snap abruptly.
 */

// Each theme defines 3 gradient stops (hsl) + visual scalars
const THEMES = {
  energetic: {
    hue: [15, 35, 5],        // orange-red-gold
    sat: [1.0, 0.9, 1.0],
    lit: [0.55, 0.60, 0.50],
    bloomStr: 0.78,
    bgHue: 10,
    targetHue: 25,
    particleAlpha: 0.195,
    trailDecay: 0.88,
  },
  euphoric: {
    hue: [285, 310, 260],    // magenta-pink-violet
    sat: [1.0, 1.0, 0.9],
    lit: [0.60, 0.55, 0.60],
    bloomStr: 0.90,
    bgHue: 280,
    targetHue: 290,
    particleAlpha: 0.202,
    trailDecay: 0.87,
  },
  calm: {
    hue: [195, 210, 175],    // sky-teal-mint
    sat: [0.7, 0.8, 0.6],
    lit: [0.50, 0.55, 0.45],
    bloomStr: 0.34,
    bgHue: 200,
    targetHue: 195,
    particleAlpha: 0.163,
    trailDecay: 0.92,
  },
  melancholic: {
    hue: [230, 245, 210],    // deep-blue-indigo
    sat: [0.6, 0.5, 0.5],
    lit: [0.40, 0.35, 0.40],
    bloomStr: 0.28,
    bgHue: 235,
    targetHue: 235,
    particleAlpha: 0.148,
    trailDecay: 0.94,
  },
  aggressive: {
    hue: [355, 10, 340],     // red-crimson-hot-pink
    sat: [1.0, 1.0, 0.9],
    lit: [0.50, 0.55, 0.50],
    bloomStr: 1.00,
    bgHue: 350,
    targetHue: 355,
    particleAlpha: 0.218,
    trailDecay: 0.84,
  },
  mysterious: {
    hue: [260, 185, 275],    // dark-purple-cyan
    sat: [0.8, 0.7, 0.7],
    lit: [0.40, 0.45, 0.38],
    bloomStr: 0.50,
    bgHue: 265,
    targetHue: 265,
    particleAlpha: 0.172,
    trailDecay: 0.92,
  },
};

export class ThemeController {
  constructor() {
    // Current smoothed theme parameters
    this.bloomStrength    = 0.55;
    this.particleAlpha    = 0.177;
    this.trailDecay       = 0.9;
    this.bgBrightness     = 0.0;   // 0 = black, up to 0.08
    this.targetHue        = 200;

    // Three colour slots, each is [h, s, l] smoothed
    this.colours = [
      [195, 0.7, 0.5],
      [210, 0.8, 0.55],
      [175, 0.6, 0.45],
    ];

    this._currentTheme = 'calm';
    this._blendRate = 0.015; // per-frame lerp weight
  }

  /**
   * Call each frame with the latest MoodState.
   * Smoothly blends toward the dominant mood's theme.
   */
  update(moodState) {
    if (!moodState) return;

    const mood  = moodState.mood ?? 'calm';
    const theme = THEMES[mood] ?? THEMES.calm;

    const t = this._blendRate * (1 + moodState.flux * 2);

    this.bloomStrength = lerp(this.bloomStrength, theme.bloomStr * (1 + moodState.energy * 0.22), t);
    this.particleAlpha = lerp(this.particleAlpha, theme.particleAlpha, t);
    this.trailDecay    = lerp(this.trailDecay,    theme.trailDecay,    t);
    this.bgBrightness  = lerp(this.bgBrightness,  moodState.energy * 0.04, 0.05);
    this.targetHue     = lerp(this.targetHue,     theme.targetHue,    t * 0.5);

    for (let i = 0; i < 3; i++) {
      this.colours[i][0] = lerpHue(this.colours[i][0], theme.hue[i], t);
      this.colours[i][1] = lerp(this.colours[i][1], theme.sat[i], t);
      this.colours[i][2] = lerp(this.colours[i][2], theme.lit[i] + moodState.brightness * 0.08, t);
    }
  }

  /**
   * Returns an [r,g,b] triple (0-1) for the primary colour, energy-brightened.
   */
  getPrimaryRGB(energy = 0) {
    return hslToRgb(
      this.colours[0][0] / 360,
      this.colours[0][1],
      Math.min(0.95, this.colours[0][2] + energy * 0.2),
    );
  }

  getSecondaryRGB(energy = 0) {
    return hslToRgb(
      this.colours[1][0] / 360,
      this.colours[1][1],
      Math.min(0.95, this.colours[1][2] + energy * 0.15),
    );
  }

  getAccentRGB(energy = 0) {
    return hslToRgb(
      this.colours[2][0] / 360,
      this.colours[2][1],
      Math.min(0.95, this.colours[2][2] + energy * 0.1),
    );
  }

  /** CSS hsl string for HUD */
  getMoodCSSColor() {
    const [h, s, l] = this.colours[0];
    return `hsl(${h.toFixed(0)},${(s * 100).toFixed(0)}%,${(l * 100).toFixed(0)}%)`;
  }
}

/* ── Colour math ──────────────────────────────────────────────── */

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpHue(a, b, t) {
  // Shortest path around the hue circle
  let diff = b - a;
  if (diff > 180)  diff -= 360;
  if (diff < -180) diff += 360;
  return (a + diff * t + 360) % 360;
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [r, g, b];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1/6) return p + (q - p) * 6 * t;
  if (t < 1/2) return q;
  if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
  return p;
}
