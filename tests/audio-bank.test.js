import test from 'node:test';
import assert from 'node:assert/strict';
import { createClipBank, AUDIO_CLIPS, AUDIO_BANK_LICENCE, AUDIO_BANK_NOTICE } from '../src/ui/audio-bank.js';

// A tiny fake Web Audio context: enough shape for the bank, and it records what was started.
function fakeContext() {
  const started = [];
  return {
    currentTime: 5, destination: { id: 'destination' }, sampleRate: 44100, started,
    createBufferSource: () => ({ buffer: null, connect() {}, start(t) { started.push(t); } }),
    createGain: () => ({ gain: { value: 1 }, connect() {} }),
    decodeAudioData: async (buffer) => ({ bytes: buffer.byteLength }),
  };
}
function fakeFetch(ok = true) {
  const asked = [];
  return {
    asked,
    fetchImpl: async (url) => { asked.push(url); return { ok, status: ok ? 200 : 404, arrayBuffer: async () => new ArrayBuffer(8) }; },
  };
}

test('the bank exposes only the exact clip names the server serves', () => {
  assert.equal(AUDIO_BANK_LICENCE, 'CC0-1.0');
  assert.match(AUDIO_BANK_NOTICE, /Kenney/);
  assert.equal(new Set(AUDIO_CLIPS).size, AUDIO_CLIPS.length, 'clip names are unique');
  assert.ok(AUDIO_CLIPS.every((name) => /^[a-z0-9-]+$/.test(name)), 'every clip name is a safe path segment');
});

test('a clip is fetched once, decoded once and played through the given destination', async () => {
  const context = fakeContext();
  const destination = { id: 'master' };
  const net = fakeFetch();
  const bank = createClipBank({ context, destination, fetchImpl: net.fetchImpl });
  const first = await bank.play('ui-click', { gain: 0.5 });
  const second = await bank.play('ui-click');
  assert.equal(net.asked.length, 1, 'the second play reuses the decoded clip');
  assert.equal(bank.loaded(), 1);
  assert.deepEqual(context.started, [5, 5], 'both plays started on the context clock');
  assert.ok(first && second, 'a BufferSource is returned for each play');
});

test('an unknown clip is refused and a missing clip never breaks the caller', async () => {
  const context = fakeContext();
  const bank = createClipBank({ context, fetchImpl: fakeFetch(false).fetchImpl });
  await assert.rejects(() => bank.play('nope'), /Unknown clip/);
  await assert.rejects(() => bank.play('ui-click'), /unavailable/);
  const results = await bank.warm(); // warm() must resolve (never reject) however many clips are missing
  assert.equal(results.length, AUDIO_CLIPS.length);
  assert.ok(results.every((r) => r.status === 'rejected'), 'every clip failed and that is reported, not thrown');
  assert.equal(bank.loaded(), 0);
});

test('a context without the required primitives is refused loudly', () => {
  assert.throws(() => createClipBank({}), /Web Audio context/);
  assert.throws(() => createClipBank({ context: { createBufferSource() {} } }), /Web Audio context/);
});
