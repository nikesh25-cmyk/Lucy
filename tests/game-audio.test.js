import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameAudio, DEFAULT_VOLUME, clampVolume } from '../src/game-audio.js';

function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}

function fakeAudioContext() {
  const parameter = () => ({ value: 0, cancelScheduledValues() {}, setTargetAtTime(value) { this.value = value; } });
  const node = () => ({ connect() {}, start() {}, stop() {}, frequency: parameter(), detune: parameter(), gain: parameter(), Q: parameter() });
  return { currentTime: 0, state: 'running', destination: {}, createGain: node, createBiquadFilter: node, createOscillator: node };
}

function fakeDocument() {
  const make = tag => ({ tagName: tag, children: [], listeners: {}, setAttribute() {}, append(...children) { this.children.push(...children); }, addEventListener(type, fn) { this.listeners[type] = fn; }, dispatch(type) { this.listeners[type]?.({}); } });
  return { createElement: make };
}

test('audio is safe and unavailable without Web Audio', () => {
  const audio = createGameAudio({ storage: storage(), AudioContext: null });
  assert.equal(audio.available, false);
  assert.equal(audio.start(), false);
  assert.equal(audio.getState().running, false);
});

test('preferences clamp, persist, and survive a new controller', () => {
  const persisted = storage();
  const audio = createGameAudio({ storage: persisted, AudioContext: null });
  assert.equal(audio.setVolume(4), 1);
  assert.equal(audio.setMuted(true), true);
  const restored = createGameAudio({ storage: persisted, AudioContext: null });
  assert.equal(restored.getState().volume, 1);
  assert.equal(restored.getState().muted, true);
  assert.equal(clampVolume('bad'), DEFAULT_VOLUME);
});

test('phase changes are accepted before opt-in starts', () => {
  const audio = createGameAudio({ storage: storage(), AudioContext: null, phase: 'night' });
  assert.equal(audio.setPhase('dawn'), true);
  assert.equal(audio.setPhase('not-a-phase'), false);
  assert.equal(audio.getState().phase, 'dawn');
});

test('first sound-control click starts ambience without muting it', () => {
  const audio = createGameAudio({ storage: storage(), audioContextFactory: fakeAudioContext });
  const controls = audio.createControls(fakeDocument());
  const mute = controls.children[0];
  mute.dispatch('click');
  assert.equal(audio.getState().running, true);
  assert.equal(audio.getState().muted, false);
  assert.equal(mute.textContent, 'Mute sound');
  audio.stop();
  assert.equal(audio.getState().running, false);
});
