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
const toast       = document.getElementById('toast');

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
// The start-screen hint is invisible once playback starts; mid-session
// messages go to a transient toast instead.
let toastTimer = 0;
function notify(message) {
  if (!running) {
    startHint.textContent = message;
    return;
  }
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
}

function startVisualizer() {
  if (running) return; // switching tracks reuses the loop already running
  running  = true;
  lastTime = performance.now();

  startScreen.classList.add('hidden');
  // `.hidden` only fades it out; make it inert so its controls (the Audio File
  // label is focusable) leave the tab order and can't be focused invisibly.
  startScreen.inert = true;
  hud.classList.add('visible');
  setHudExpanded(false);
  // Move focus off the now-hidden start screen onto a visible control.
  hudToggle?.focus();

  requestAnimationFrame(loop);
}

btnMic.addEventListener('click', async () => {
  // Prime AudioContext SYNCHRONOUSLY during the user gesture
  audio.primeContext();
  const label = btnMic.innerHTML;
  btnMic.textContent = 'Connecting…';
  // Disable while the permission prompt is open so an overlapping click can't
  // capture "Connecting…" as the label to restore, and so the label is always
  // restored (including when the request is superseded by a newer pick).
  btnMic.disabled = true;
  try {
    if (await audio.startMic()) startVisualizer();
    // A false result means a newer pick superseded this one and is handling
    // the UI; just fall through to restore the button below.
  } catch (err) {
    // Keep the user on the start screen with a reason instead of reloading.
    startHint.textContent = err.name === 'NotAllowedError'
      ? '❌ Microphone access was blocked — allow it in your browser and try again.'
      : `❌ ${err.message}`;
  } finally {
    btnMic.innerHTML = label;
    btnMic.disabled = false;
  }
});

// Prime AudioContext on label click (before the file picker even opens)
btnFile.addEventListener('click', () => {
  audio.primeContext();
});

// The file button is a <label>; make it reachable and operable by keyboard.
btnFile.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    audio.primeContext();
    fileInput.click();
  }
});

async function loadFile(file) {
  if (!file) return;
  notify(`Loading “${file.name}”…`);
  try {
    if (!(await audio.startFile(file))) return; // superseded by a newer pick
    const firstTrack = !running;
    startVisualizer();
    notify(firstTrack ? 'Drop another audio file anytime to switch tracks' : `Now playing “${file.name}”`);
  } catch (err) {
    notify(`❌ Couldn't play “${file.name}”: ${err.message}`);
  }
}

fileInput.addEventListener('change', (e) => loadFile(e.target.files?.[0]));

// Drag & drop an audio file anywhere — on the start screen or mid-session to
// switch tracks (AudioEngine tears down the previous source on re-init).
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  // An empty type means the OS didn't recognise the extension; let the
  // decoder decide rather than rejecting a playable file.
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type === '' || f.type.startsWith('audio/'));
  if (!file) {
    notify('❌ That doesn\'t look like an audio file');
    return;
  }
  audio.primeContext();
  loadFile(file);
});
