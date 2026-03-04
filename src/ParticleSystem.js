/**
 * ParticleSystem
 *
 * Pure-JS physics simulation for the visualizer's particle cloud.
 * No rendering dependency – all rendering is in VisualizerRenderer.
 *
 * Physics features:
 *  - Drag / friction
 *  - Harmonic oscillator (spring toward equilibrium orbit radius)
 *  - Frequency-band attractor poles on a circle
 *  - Beat-triggered explosion impulse
 *  - Turbulence noise (fast approximation)
 *  - Mood-driven gravity / vortex
 */

const TWO_PI = Math.PI * 2;

export class ParticleSystem {
  /**
   * @param {number} count - particle count
   */
  constructor(count = 7000) {
    this.count = count;

    // Flat typed arrays (SoA layout for cache efficiency)
    this.px = new Float32Array(count);  // positions
    this.py = new Float32Array(count);
    this.pz = new Float32Array(count);
    this.vx = new Float32Array(count);  // velocities
    this.vy = new Float32Array(count);
    this.vz = new Float32Array(count);
    this.life    = new Float32Array(count); // 0-1 normalised age
    this.maxLife = new Float32Array(count); // seconds
    this.size    = new Float32Array(count); // base size
    this.hue     = new Float32Array(count); // colour hue 0-360
    this.orbitR  = new Float32Array(count); // equilibrium orbit radius
    this.layer   = new Uint8Array(count);   // 0=background 1=mid 2=foreground

    // Beat state
    this._beatCooldown = 0;
    this._time = 0;

    // Attractor positions (8 poles, updated from frequency bands)
    this._attractorX = new Float32Array(8);
    this._attractorY = new Float32Array(8);
    this._attractorStr = new Float32Array(8);

    this._init();
  }

  /* ── Init ────────────────────────────────────────────────── */

  _init() {
    for (let i = 0; i < this.count; i++) {
      this._spawn(i, true);
    }
  }

  _spawn(i, randomiseAge = false) {
    const layer = i < this.count * 0.6 ? 0 : i < this.count * 0.85 ? 1 : 2;
    this.layer[i] = layer;

    const baseR  = layer === 0 ? rng(1, 3.5)
                 : layer === 1 ? rng(0.5, 2.5)
                 :               rng(0.2, 1.2);

    this.orbitR[i] = baseR;
    const theta = rng(0, TWO_PI);
    const phi   = rng(0, TWO_PI);

    this.px[i] = baseR * Math.cos(theta);
    this.py[i] = baseR * Math.sin(theta) * 0.5;
    this.pz[i] = baseR * Math.sin(phi) * 0.3;

    const speed = layer === 0 ? 0.002 : layer === 1 ? 0.005 : 0.01;
    this.vx[i] = rng(-speed, speed);
    this.vy[i] = rng(-speed, speed);
    this.vz[i] = rng(-speed, speed);

    this.maxLife[i] = rng(3, 12);
    this.life[i]    = randomiseAge ? Math.random() : 0;
    this.size[i]    = layer === 0 ? rng(0.5, 1.5)
                    : layer === 1 ? rng(1.5, 3.5)
                    :               rng(2.5, 5.0);
    this.hue[i] = rng(0, 360);
  }

  /* ── Public API ──────────────────────────────────────────── */

  /**
   * @param {number} dt           - delta time in seconds
   * @param {object} moodState    - from MoodAnalyzer
   * @param {Float32Array} bands  - 8 frequency band energies [0-1]
   * @param {Float32Array} spectrum - full FFT [0-1]
   */
  update(dt, moodState, bands, spectrum) {
    if (!moodState) return;

    this._time += dt;

    // Update attractors from frequency bands
    this._updateAttractors(bands, moodState);

    // Beat impulse
    const beatScale = moodState.beatPulse > 0 && this._beatCooldown <= 0 ? 1 : 0;
    if (beatScale > 0) this._beatCooldown = 0.15;
    if (this._beatCooldown > 0) this._beatCooldown -= dt;

    // Mood params
    const speed   = 0.3 + moodState.speed * 1.2;
    const drag    = 0.97 - moodState.energy * 0.02;
    const vortex  = moodState.euphoria * 0.4 + moodState.mysticism * 0.2;
    const chaos   = moodState.noisiness * 0.4;
    const gravity = (moodState.scores?.melancholic ?? 0) * -0.002;

    for (let i = 0; i < this.count; i++) {
      // Age particle
      this.life[i] += dt / this.maxLife[i];
      if (this.life[i] > 1) {
        this._spawn(i);
        continue;
      }

      const x = this.px[i];
      const y = this.py[i];
      const z = this.pz[i];

      // Spring back to orbit radius
      const dist = Math.sqrt(x * x + y * y + z * z) || 1e-6;
      const targetR = this.orbitR[i] * (1 + moodState.energy * 0.4);
      const springF = (targetR - dist) * 0.004 * speed;
      const nx = x / dist, ny = y / dist, nz = z / dist;

      let ax = nx * springF;
      let ay = ny * springF;
      let az = nz * springF;

      // Vortex (tangential force, keeps particles orbiting)
      if (vortex > 0) {
        const tx = -ny;
        const ty =  nx;
        ax += tx * vortex * speed * 0.008;
        ay += ty * vortex * speed * 0.008;
      }

      // Gravity (mood: melancholic pulls down)
      ay += gravity * speed;

      // Attractor poles
      for (let a = 0; a < 8; a++) {
        const dx = this._attractorX[a] - x;
        const dy = this._attractorY[a] - y;
        const d2 = dx * dx + dy * dy + 0.01;
        const f  = this._attractorStr[a] * 0.003 / d2;
        ax += dx * f;
        ay += dy * f;
      }

      // Beat impulse – radial shockwave
      if (beatScale > 0) {
        ax += nx * moodState.energy * 0.08;
        ay += ny * moodState.energy * 0.08;
        az += nz * moodState.energy * 0.04;
      }

      // Turbulence (cheap hash noise)
      if (chaos > 0) {
        ax += (noise(x * 3 + this._time)     - 0.5) * chaos * 0.01;
        ay += (noise(y * 3 + this._time + 7) - 0.5) * chaos * 0.01;
        az += (noise(z * 3 + this._time + 3) - 0.5) * chaos * 0.005;
      }

      // Integrate
      this.vx[i] = (this.vx[i] + ax * dt) * drag;
      this.vy[i] = (this.vy[i] + ay * dt) * drag;
      this.vz[i] = (this.vz[i] + az * dt) * drag;

      // Clamp velocity
      const maxV = 0.12 * speed;
      const spd  = Math.sqrt(this.vx[i]**2 + this.vy[i]**2 + this.vz[i]**2);
      if (spd > maxV) {
        const s = maxV / spd;
        this.vx[i] *= s; this.vy[i] *= s; this.vz[i] *= s;
      }

      this.px[i] += this.vx[i];
      this.py[i] += this.vy[i];
      this.pz[i] += this.vz[i];

      // Hue drift – tint toward mood target hue
      const targetHue = moodState._targetHue ?? 200;
      this.hue[i] = lerp(this.hue[i], targetHue + rng(-40, 40), 0.001);
    }
  }

  _updateAttractors(bands, moodState) {
    for (let a = 0; a < 8; a++) {
      const angle = (a / 8) * TWO_PI + this._time * 0.1;
      const r = 1.2 + bands[a] * 2.0;
      this._attractorX[a] = Math.cos(angle) * r;
      this._attractorY[a] = Math.sin(angle) * r;
      this._attractorStr[a] = bands[a] * moodState.energy;
    }
  }
}

/* ── Helpers ─────────────────────────────────────────────────── */

function rng(lo, hi) { return lo + Math.random() * (hi - lo); }
function lerp(a, b, t) { return a + (b - a) * t; }

// Cheap scalar noise using sine hash
function noise(x) {
  return (Math.sin(x * 127.1 + 311.7) * 43758.5453) % 1;
}
