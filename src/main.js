/**
 * main.js – Entry point
 *
 * Bootstraps all subsystems and runs the main animation loop.
 */

import './style.css';
import { AudioEngine }      from './AudioEngine.js';
import { MoodAnalyzer }     from './MoodAnalyzer.js';
import { ParticleSystem }   from './ParticleSystem.js';
import { ThemeController }  from './ThemeController.js';
import { VisualizerRenderer } from './VisualizerRenderer.js';

/* ── DOM refs ────────────────────────────────────────────────── */
const canvas      = document.getElementById('visualizer-canvas');
const startScreen = document.getElementById('start-screen');
const hud         = document.getElementById('hud');
const hudToggle   = document.getElementById('hud-toggle');
const hudMood     = document.getElementById('mood-value');
const hudBpm      = document.getElementById('bpm-value');
const energyBar   = document.getElementById('energy-bar');
const btnMic      = document.getElementById('btn-mic');
const btnFile     = document.getElementById('btn-file');
const fileInput   = document.getElementById('file-input');
const startHint   = document.getElementById('start-hint');

/* ── Subsystems ──────────────────────────────────────────────── */
const audio     = new AudioEngine();
const mood      = new MoodAnalyzer();
const particles = new ParticleSystem(2200);
const theme     = new ThemeController();
const renderer  = new VisualizerRenderer(canvas);

/* ── State ───────────────────────────────────────────────────── */
let running  = false;
let lastTime = performance.now();
let moodState = null;
let hudExpanded = false;

function setHudExpanded(expanded) {
  hudExpanded = expanded;
  hud.classList.toggle('expanded', expanded);
  hudToggle?.setAttribute('aria-expanded', String(expanded));
}

hudToggle?.addEventListener('click', () => {
  setHudExpanded(!hudExpanded);
});

/* ── Feed Meyda features → MoodAnalyzer ─────────────────────── */
audio.onFeatures((features) => {
  mood.update(features, audio);
});

/* ── Animation loop ──────────────────────────────────────────── */
function loop(now) {
  if (!running) return;

  const dt = Math.min((now - lastTime) / 1000, 0.05); // cap at 50ms
  lastTime = now;

  // Refresh moodState
  moodState = mood.getMoodState(audio);
  // Pass targetHue into moodState so ParticleSystem can tint particles
  moodState._targetHue = theme.targetHue;

  // Update subsystems
  theme.update(moodState);
  particles.update(dt, moodState, audio.getBands(), audio.getSpectrum());

  // Render
  renderer.render(particles, audio, moodState, theme, dt);

  // HUD
  updateHUD(moodState);

  requestAnimationFrame(loop);
}

/* ── HUD ─────────────────────────────────────────────────────── */
function updateHUD(state) {
  const moodName = state.mood.charAt(0).toUpperCase() + state.mood.slice(1);
  if (hudMood.textContent !== moodName) {
    hudMood.textContent = moodName;
  }
  hudMood.style.color  = theme.getMoodCSSColor();

  const bpmStr = audio.bpm > 0 ? String(audio.bpm) : '—';
  if (hudBpm.textContent !== bpmStr) hudBpm.textContent = bpmStr;

  energyBar.style.width    = `${(state.energy * 100).toFixed(1)}%`;
  const [r, g, b] = theme.getPrimaryRGB(state.energy);
  const [r2,g2,b2] = theme.getSecondaryRGB();
  energyBar.style.background =
    `linear-gradient(90deg, rgb(${r*255|0},${g*255|0},${b*255|0}), rgb(${r2*255|0},${g2*255|0},${b2*255|0}))`;
}

/* ── Start ───────────────────────────────────────────────────── */
function startVisualizer() {
  running  = true;
  lastTime = performance.now();

  startScreen.classList.add('hidden');
  hud.classList.add('visible');
  setHudExpanded(false);

  requestAnimationFrame(loop);
}

btnMic.addEventListener('click', async () => {
  // Prime AudioContext SYNCHRONOUSLY during the user gesture
  audio.primeContext();
  btnMic.textContent = 'Connecting…';
  try {
    await audio.startMic();
    startVisualizer();
  } catch (err) {
    btnMic.innerHTML = `❌ ${err.message}`;
    setTimeout(() => location.reload(), 3000);
  }
});

// Prime AudioContext on label click (before the file picker even opens)
btnFile.addEventListener('click', () => {
  audio.primeContext();
});

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  startHint.textContent = `Loading “${file.name}”…`;
  try {
    await audio.startFile(file);
    startVisualizer();
  } catch (err) {
    startHint.textContent = `❌ ${err.message}`;
  }
});
