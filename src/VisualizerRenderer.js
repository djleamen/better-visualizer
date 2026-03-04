/**
 * VisualizerRenderer
 *
 * Three.js scene that hosts:
 *   1.  Particle cloud  – physics-driven points with glow shader
 *   2.  Frequency ring  – inner circular FFT bars
 *   3.  Waveform ribbon – outer waveform ring
 *   4.  Center orb      – pulsing icosphere reacting to beat
 *   5.  Background mesh – large slow-moving backdrop particles
 *
 * Post-processing: UnrealBloomPass for the iconic iTunes glow.
 */

import * as THREE from 'three';
import { EffectComposer }    from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }        from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass }   from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass }        from 'three/examples/jsm/postprocessing/OutputPass.js';

/* ── Custom shaders ─────────────────────────────────────────── */

const PARTICLE_VERT = /* glsl */`
  attribute float aLife;
  attribute float aSize;
  attribute vec3  aColor;

  varying float vLife;
  varying vec3  vColor;

  void main() {
    vLife  = aLife;
    vColor = aColor;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (400.0 / -mvPosition.z) * (0.3 + aLife * 0.7);
    gl_Position  = projectionMatrix * mvPosition;
  }
`;

const PARTICLE_FRAG = /* glsl */`
  varying float vLife;
  varying vec3  vColor;
  uniform float uAlpha;

  void main() {
    // Soft gaussian disc
    vec2  uv   = gl_PointCoord - 0.5;
    float dist = length(uv);
    if (dist > 0.5) discard;

    float alpha = smoothstep(0.5, 0.0, dist);
    // Fade in/out with life
    float lifeFade = sin(vLife * 3.14159);
    gl_FragColor = vec4(vColor, alpha * lifeFade * uAlpha);
  }
`;

const FREQ_VERT = /* glsl */`
  attribute float aIntensity;
  varying float vIntensity;
  void main() {
    vIntensity  = aIntensity;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FREQ_FRAG = /* glsl */`
  uniform vec3  uColor;
  varying float vIntensity;
  void main() {
    gl_FragColor = vec4(uColor * (0.5 + vIntensity * 0.8), 0.9);
  }
`;

/* ── Constants ──────────────────────────────────────────────── */
const FREQ_BARS   = 128;
const FREQ_RADIUS = 1.5;
const WAVE_RADIUS = 2.2;
const WAVE_SEGS   = 256;

export class VisualizerRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this._time = 0;

    this._setupRenderer();
    this._setupScene();
    this._setupCamera();
    this._setupParticleCloud();
    this._setupFreqRing();
    this._setupWaveformRing();
    this._setupCenterOrb();
    this._setupBloom();
    this._handleResize();

    window.addEventListener('resize', () => this._handleResize());
  }

  /* ── Setup ─────────────────────────────────────────────────── */

  _setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  _setupScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000005);
  }

  _setupCamera() {
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 100);
    this.camera.position.set(0, 0, 5);
    this._camTargetX = 0;
    this._camTargetY = 0;
  }

  _setupParticleCloud() {
    // Geometry & attributes – sized for max particle count
    // Actual data is fed from ParticleSystem each frame
    this._particleCount = 2200;
    const geo = new THREE.BufferGeometry();

    const positions = new Float32Array(this._particleCount * 3);
    const colors    = new Float32Array(this._particleCount * 3);
    const sizes     = new Float32Array(this._particleCount);
    const lives     = new Float32Array(this._particleCount);

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aColor',   new THREE.BufferAttribute(colors,    3));
    geo.setAttribute('aSize',    new THREE.BufferAttribute(sizes,     1));
    geo.setAttribute('aLife',    new THREE.BufferAttribute(lives,     1));

    const mat = new THREE.ShaderMaterial({
      vertexShader:   PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: {
        uAlpha: { value: 0.177 },
      },
      transparent:    true,
      depthWrite:     false,
      blending:       THREE.AdditiveBlending,
    });

    this.particleMesh = new THREE.Points(geo, mat);
    this.scene.add(this.particleMesh);

    this._pGeo = geo;
    this._pPositions = positions;
    this._pColors    = colors;
    this._pSizes     = sizes;
    this._pLives     = lives;
  }

  _setupFreqRing() {
    // Each bar = 2 vertices (inner + outer), drawn as LineSegments
    const vertCount = FREQ_BARS * 2;
    const positions  = new Float32Array(vertCount * 3);
    const intensities = new Float32Array(vertCount);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',   new THREE.BufferAttribute(positions,   3));
    geo.setAttribute('aIntensity', new THREE.BufferAttribute(intensities, 1));

    const mat = new THREE.ShaderMaterial({
      vertexShader:   FREQ_VERT,
      fragmentShader: FREQ_FRAG,
      uniforms: { uColor: { value: new THREE.Vector3(0.3, 0.8, 1.0) } },
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });

    this.freqMesh = new THREE.LineSegments(geo, mat);
    this.scene.add(this.freqMesh);

    this._freqGeo        = geo;
    this._freqPositions  = positions;
    this._freqIntensities = intensities;
  }

  _setupWaveformRing() {
    const positions = new Float32Array(WAVE_SEGS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setDrawRange(0, WAVE_SEGS);

    const mat = new THREE.LineBasicMaterial({
      color:      0x88ccff,
      transparent: true,
      opacity:     0.4,
      blending:    THREE.AdditiveBlending,
      depthWrite:  false,
    });

    this.waveMesh = new THREE.Line(geo, mat);
    this.scene.add(this.waveMesh);

    this._waveGeo       = geo;
    this._wavePositions = positions;
  }

  _setupCenterOrb() {
    const geo = new THREE.IcosahedronGeometry(0.25, 5);
    const mat = new THREE.MeshStandardMaterial({
      color:       0xffffff,
      emissive:    new THREE.Color(0x4488ff),
      emissiveIntensity: 0.6,
      wireframe:   false,
      roughness:   0.2,
      metalness:   0.8,
    });

    this.orbMesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.orbMesh);

    // Point light at orb
    this.orbLight = new THREE.PointLight(0x4488ff, 2, 6);
    this.scene.add(this.orbLight);
  }

  _setupBloom() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.45,  // strength
      0.16,  // radius – tight glow, not a wash
      0.88,  // threshold – only hot-white pixels bloom
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  /* ── Per-frame render ───────────────────────────────────────── */

  /**
   * @param {ParticleSystem} particles
   * @param {AudioEngine}    audioEngine
   * @param {object}         moodState
   * @param {ThemeController} theme
   * @param {number}         dt
   */
  render(particles, audioEngine, moodState, theme, dt) {
    if (!moodState) return;

    this._time += dt;

    this._updateParticleCloud(particles, moodState, theme);
    this._updateFreqRing(audioEngine, theme);
    this._updateWaveformRing(audioEngine, theme);
    this._updateCenterOrb(moodState, theme);
    this._updateCamera(moodState, dt);
    this._updateBackground(moodState, theme);
    this._updateBloom(theme);

    this.composer.render();
  }

  /* ── Sub-renderers ──────────────────────────────────────────── */

  _updateParticleCloud(particles, moodState, theme) {
    const { px, py, pz, life, size, hue, count } = particles;
    const pri = theme.getPrimaryRGB(moodState.energy);
    const sec = theme.getSecondaryRGB(moodState.energy);
    const acc = theme.getAccentRGB(moodState.energy);

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      this._pPositions[i3]     = px[i];
      this._pPositions[i3 + 1] = py[i];
      this._pPositions[i3 + 2] = pz[i];

      // Hue blend: choose colour slot by hue bucket
      const t   = ((hue[i] % 120) / 120);
      const src = hue[i] < 120 ? pri : hue[i] < 240 ? sec : acc;
      const alt = hue[i] < 120 ? sec : hue[i] < 240 ? acc : pri;

      this._pColors[i3]     = lerp(src[0], alt[0], t);
      this._pColors[i3 + 1] = lerp(src[1], alt[1], t);
      this._pColors[i3 + 2] = lerp(src[2], alt[2], t);

      this._pSizes[i] = size[i] * (0.26 + moodState.energy * 0.16);
      this._pLives[i] = life[i];
    }

    this.particleMesh.material.uniforms.uAlpha.value = theme.particleAlpha;

    this._pGeo.attributes.position.needsUpdate = true;
    this._pGeo.attributes.aColor.needsUpdate   = true;
    this._pGeo.attributes.aSize.needsUpdate    = true;
    this._pGeo.attributes.aLife.needsUpdate    = true;
  }

  _updateFreqRing(audioEngine, theme) {
    const spectrum = audioEngine.getSpectrum();
    const step = Math.floor(spectrum.length / FREQ_BARS);
    const pri  = theme.getPrimaryRGB();

    this.freqMesh.material.uniforms.uColor.value.set(pri[0], pri[1], pri[2]);

    for (let i = 0; i < FREQ_BARS; i++) {
      const angle     = (i / FREQ_BARS) * Math.PI * 2;
      const intensity = spectrum[i * step] ?? 0;
      const innerR    = FREQ_RADIUS;
      const outerR    = FREQ_RADIUS + intensity * 1.2;

      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const vi2 = i * 2;

      this._freqPositions[vi2 * 3]     = cos * innerR;
      this._freqPositions[vi2 * 3 + 1] = sin * innerR;
      this._freqPositions[vi2 * 3 + 2] = 0;

      this._freqPositions[(vi2 + 1) * 3]     = cos * outerR;
      this._freqPositions[(vi2 + 1) * 3 + 1] = sin * outerR;
      this._freqPositions[(vi2 + 1) * 3 + 2] = 0;

      this._freqIntensities[vi2]     = intensity;
      this._freqIntensities[vi2 + 1] = intensity;
    }

    this._freqGeo.attributes.position.needsUpdate   = true;
    this._freqGeo.attributes.aIntensity.needsUpdate = true;
  }

  _updateWaveformRing(audioEngine, theme) {
    const waveform = audioEngine.getWaveform();
    const step = Math.floor(waveform.length / WAVE_SEGS);
    const sec  = theme.getSecondaryRGB();

    this.waveMesh.material.color.setRGB(sec[0], sec[1], sec[2]);

    for (let i = 0; i < WAVE_SEGS; i++) {
      const angle = (i / WAVE_SEGS) * Math.PI * 2;
      const w     = (waveform[i * step] ?? 0.5) - 0.5;
      const r     = WAVE_RADIUS + w * 0.6;

      this._wavePositions[i * 3]     = Math.cos(angle) * r;
      this._wavePositions[i * 3 + 1] = Math.sin(angle) * r;
      this._wavePositions[i * 3 + 2] = 0;
    }
    this._waveGeo.attributes.position.needsUpdate = true;
  }

  _updateCenterOrb(moodState, theme) {
    const scale = 1 + moodState.energy * 0.5 + (moodState.beatPulse ? 0.4 : 0);
    this.orbMesh.scale.setScalar(lerp(this.orbMesh.scale.x, scale, 0.15));

    const [r, g, b] = theme.getPrimaryRGB(moodState.energy);
    this.orbMesh.material.emissive.setRGB(r, g, b);
    this.orbMesh.material.emissiveIntensity = 0.35 + moodState.energy * 0.75;
    this.orbLight.color.setRGB(r, g, b);
    this.orbLight.intensity = 0.2 + moodState.energy * 0.9;

    // Slow wobble rotation
    this.orbMesh.rotation.x += 0.003 + moodState.speed * 0.008;
    this.orbMesh.rotation.y += 0.005 + moodState.speed * 0.010;
  }

  _updateCamera(moodState, dt) {
    // Gentle auto-rotation + subtle drift
    const t = this._time;
    this._camTargetX = Math.sin(t * 0.08) * 0.3;
    this._camTargetY = Math.cos(t * 0.05) * 0.2;

    this.camera.position.x = lerp(this.camera.position.x, this._camTargetX, 0.02);
    this.camera.position.y = lerp(this.camera.position.y, this._camTargetY, 0.02);
    this.camera.lookAt(0, 0, 0);
  }

  _updateBackground(moodState, theme) {
    const b = theme.bgBrightness ?? 0;
    this.scene.background.setRGB(b * 0.3, b * 0.3, b * 0.5);
  }

  _updateBloom(theme) {
    // Hard cap so the scene never washes out
    this.bloomPass.strength = lerp(this.bloomPass.strength, Math.min(theme.bloomStrength, 0.95), 0.08);
  }

  /* ── Resize ──────────────────────────────────────────────────── */

  _handleResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
