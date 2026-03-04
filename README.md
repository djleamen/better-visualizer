# better-visualizer

> ML-powered music visualizer with real-time mood detection and physics-based fluid visuals. Inspired by the Apple Music/iTunes visualizer — but smarter and more customizable.

## Features

- **Real-time audio** – microphone input or drop any audio file
- **ML mood detection** – Meyda extracts perceptual audio features (energy, spectral centroid, MFCCs, chroma, ZCR, flux) every ~512 samples; a weighted classifier maps them onto 6 mood archetypes in real time
- **Adaptive theming** – colour palette, bloom intensity, particle speed, and trail decay all smoothly transition based on detected mood
- **Physics particle system** – 7 000 particles with spring-orbit forces, frequency-band attractors, vortex, turbulence, and beat-triggered shockwaves
- **Three.js renderer + post-processing** – UnrealBloomPass gives the iconic iTunes glow; frequency ring, waveform ribbon, and pulsing center orb complete the scene

## Mood archetypes

| Mood | Colours | Visual character |
|------|---------|-----------------|
| Energetic | Orange · Red · Gold | Fast, warm, high bloom |
| Euphoric | Magenta · Pink · Violet | Soaring, saturated, swirling |
| Calm | Sky · Teal · Mint | Slow, flowing, low bloom |
| Melancholic | Deep Blue · Indigo | Heavy, dark, sparse |
| Aggressive | Red · Crimson | Sharp, fast, max bloom |
| Mysterious | Dark Purple · Cyan | Sparse, shifting, deep |

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173), then click **Microphone** or drag in an audio file.

To capture system audio on macOS install a virtual audio device (e.g. BlackHole or Loopback) and select it as the microphone source.

## Stack

- [Three.js](https://threejs.org/) — 3D rendering + UnrealBloom post-processing
- [Meyda](https://meyda.js.org/) — real-time audio feature extraction
- [Vite](https://vitejs.dev/) — build & dev server
Music / audio visualizer app
