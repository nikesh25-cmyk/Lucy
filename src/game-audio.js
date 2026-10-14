/**
 * Small, opt-in sound bed for NemoWorld.
 *
 * No nodes are created until start() is called from a user gesture. The module
 * is deliberately independent from app.js so a world without Web Audio (or a
 * browser with audio disabled) continues to work normally.
 */

import { createClipBank } from './ui/audio-bank.js';

const STORAGE_KEY = 'nemoworld-audio';
const DEFAULT_VOLUME = 0.16;
const PHASES = {
  dawn: { frequency: 174, second: 261.63, brightness: 0.12 },
  day: { frequency: 196, second: 293.66, brightness: 0.22 },
  dusk: { frequency: 164.81, second: 246.94, brightness: 0.15 },
  night: { frequency: 130.81, second: 196, brightness: 0.07 },
};

function clampVolume(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : DEFAULT_VOLUME;
}

function safeStorage(storage) {
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    ? storage
    : null;
}

function loadPreferences(storage) {
  const fallback = { muted: false, volume: DEFAULT_VOLUME };
  if (!storage) return fallback;
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
    return { muted: value.muted === true, volume: clampVolume(value.volume) };
  } catch {
    return fallback;
  }
}

function savePreferences(storage, state) {
  if (!storage) return;
  try { storage.setItem(STORAGE_KEY, JSON.stringify({ muted: state.muted, volume: state.volume })); } catch { /* Private mode can reject storage. */ }
}

function contextFactory(options) {
  if (typeof options.audioContextFactory === 'function') return options.audioContextFactory;
  const AudioContextClass = options.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext;
  return AudioContextClass ? () => new AudioContextClass() : null;
}

function setParam(param, value, now, duration = 0.8) {
  if (!param) return;
  if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(now);
  if (typeof param.setTargetAtTime === 'function') param.setTargetAtTime(value, now, duration);
  else param.value = value;
}

export function createGameAudio(options = {}) {
  const storage = safeStorage(options.storage ?? globalThis.localStorage);
  const state = loadPreferences(storage);
  let phase = PHASES[options.phase] ? options.phase : 'day';
  let context = null;
  let master = null;
  let lowpass = null;
  let drone = null;
  let shimmer = null;
  let noise = null;
  let noiseGain = null;
  let running = false;
  let bank = null;

  const available = Boolean(contextFactory(options));
  const audibleGain = () => state.muted ? 0 : state.volume;

  function setOutput(now = context?.currentTime || 0, immediate = false) {
    setParam(master?.gain, audibleGain(), now, immediate ? 0.01 : 0.35);
  }

  function applyPhase(nextPhase, immediate = false) {
    if (!PHASES[nextPhase]) return false;
    phase = nextPhase;
    if (!running) return true;
    const tone = PHASES[phase];
    const now = context?.currentTime || 0;
    setParam(drone?.frequency, tone.frequency, now, immediate ? 0.01 : 3);
    setParam(shimmer?.frequency, tone.second, now, immediate ? 0.01 : 3);
    setParam(lowpass?.frequency, 650 + tone.brightness * 1800, now, immediate ? 0.01 : 3);
    setParam(noiseGain?.gain, tone.brightness * 0.018, now, immediate ? 0.01 : 3);
    return true;
  }

  function start() {
    if (running) return true;
    const makeContext = contextFactory(options);
    if (!makeContext) return false;
    try {
      context = makeContext();
      if (!context || typeof context.createGain !== 'function' || typeof context.createOscillator !== 'function') {
        stop();
        return false;
      }
      master = context.createGain();
      lowpass = typeof context.createBiquadFilter === 'function' ? context.createBiquadFilter() : null;
      drone = context.createOscillator();
      shimmer = context.createOscillator();
      master.gain.value = 0;
      if (lowpass) { lowpass.type = 'lowpass'; lowpass.frequency.value = 900; lowpass.Q.value = 0.35; }
      drone.type = 'sine'; shimmer.type = 'sine';
      drone.detune.value = -3; shimmer.detune.value = 4;
      const droneGain = context.createGain();
      const shimmerGain = context.createGain();
      droneGain.gain.value = 0.045; shimmerGain.gain.value = 0.018;
      drone.connect(droneGain); shimmer.connect(shimmerGain);
      if (lowpass) { droneGain.connect(lowpass); shimmerGain.connect(lowpass); lowpass.connect(master); }
      else { droneGain.connect(master); shimmerGain.connect(master); }
      if (typeof context.createBufferSource === 'function' && typeof context.createBuffer === 'function') {
        const buffer = context.createBuffer(1, Math.max(1, Math.floor((context.sampleRate || 44100) * 2)), context.sampleRate || 44100);
        const data = buffer.getChannelData(0);
        for (let index = 0; index < data.length; index += 1) data[index] = (Math.random() * 2 - 1) * 0.22;
        noise = context.createBufferSource(); noise.buffer = buffer; noise.loop = true;
        noiseGain = context.createGain(); noiseGain.gain.value = 0;
        noise.connect(noiseGain); noiseGain.connect(master);
      }
      master.connect(context.destination);
      // Sampled CC0 clips share this context and this master node, so the ambient bed's mute and
      // volume govern the sound effects too. Construction never fetches; a clip loads on first play.
      try { bank = createClipBank({ context, destination: master, ...(options.clipFetch ? { fetchImpl: options.clipFetch } : {}) }); }
      catch { bank = null; }
      drone.start(); shimmer.start(); noise?.start();
      running = true;
      applyPhase(phase, true); setOutput(context.currentTime || 0, true);
      if (context.state === 'suspended' && typeof context.resume === 'function') context.resume().catch(() => {});
      return true;
    } catch {
      dispose();
      return false;
    }
  }

  function stop() {
    if (running) try { drone?.stop(); shimmer?.stop(); noise?.stop(); } catch { /* Already stopped. */ }
    try { context?.close?.(); } catch { /* Best effort. */ }
    context = master = lowpass = drone = shimmer = noise = noiseGain = null;
    running = false;
  }

  function dispose() { stop(); bank = null; }
  function setMuted(muted) { state.muted = Boolean(muted); savePreferences(storage, state); setOutput(); return state.muted; }
  function setVolume(volume) { state.volume = clampVolume(volume); savePreferences(storage, state); setOutput(); return state.volume; }
  function toggle() { return setMuted(!state.muted); }

  /** Build keyboard-friendly controls for a host UI. The host still decides where to place them. */
  function createControls(documentRef = globalThis.document) {
    if (!documentRef?.createElement) return null;
    const group = documentRef.createElement('div');
    group.className = 'game-audio-controls';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'World ambience');
    const mute = documentRef.createElement('button');
    mute.type = 'button';
    const slider = documentRef.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = '1'; slider.step = '0.01';
    slider.setAttribute('aria-label', 'Ambience volume'); slider.value = String(state.volume);
    const refresh = () => {
      mute.textContent = !available ? 'Sound unavailable' : !running ? 'Enable sound' : state.muted ? 'Sound on' : 'Mute sound';
      mute.setAttribute('aria-pressed', String(state.muted));
      mute.disabled = !available;
      slider.disabled = !available;
      slider.value = String(state.volume);
    };
    // The first click is the explicit user gesture that unlocks Web Audio. Do not
    // immediately toggle the freshly-started bed into the muted state.
    mute.addEventListener('click', () => { if (!running) start(); else toggle(); refresh(); });
    slider.addEventListener('input', () => { if (!running) start(); setVolume(slider.value); refresh(); });
    refresh(); group.append(mute, slider);
    return group;
  }

  return {
    available,
    start,
    stop,
    dispose,
    toggle,
    setMuted,
    setVolume,
    setPhase: applyPhase,
    createControls,
    /** Play one sampled CC0 clip (see src/ui/audio-bank.js). Resolves to null while audio is off. */
    playClip: (name, clipOptions) => (running && bank ? bank.play(name, clipOptions).catch(() => null) : Promise.resolve(null)),
    /** The clip names this build can play. */
    clipNames: () => (bank ? bank.clips : []),
    getState: () => ({ available, running, muted: state.muted, volume: state.volume, phase }),
  };
}

export { DEFAULT_VOLUME, PHASES, clampVolume };
