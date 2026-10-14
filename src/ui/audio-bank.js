/**
 * CC0 clip bank for NemoWorld.
 *
 * The ambient bed in `src/game-audio.js` is synthesised; this module adds the *sampled* half — short
 * CC0 sound effects and music jingles — without changing the ambient design. Clips are decoded once
 * and played through the same master node as the ambient bed, so one mute and one volume control
 * govern everything. Every dependency (fetch, AudioContext, decode) is injected, so the module is
 * unit-testable with no Web Audio and no network.
 *
 * Rights: every clip is CC0 1.0 Universal (Kenney, kenney.nl). See `assets/audio/manifest.json`,
 * `assets/audio/THIRD_PARTY.md` and `asset-pool/POOL.md`.
 */
export const AUDIO_BANK_LICENCE = 'CC0-1.0';
export const AUDIO_BANK_NOTICE = 'CC0 1.0 Universal — Kenney (kenney.nl). Clips live in assets/audio/.';

/** The exact clip names served from `/assets/audio/<name>.ogg`. Kept in step with the server allowlist. */
export const AUDIO_CLIPS = Object.freeze([
  'ui-click', 'ui-confirm', 'ui-close',
  'world-step-grass', 'world-step-stone', 'world-place', 'world-remove',
  'world-door-open', 'world-door-close', 'world-chop', 'world-coin',
  'music-jingle-1', 'music-jingle-2', 'music-jingle-3',
]);

/**
 * Create a clip bank over an existing AudioContext.
 * @param {object} options
 * @param {AudioContext} options.context   a live Web Audio context (required)
 * @param {AudioNode} [options.destination] the node to connect to (default: the context destination)
 * @param {Function} [options.fetchImpl]   fetch-like (url) => Response (default: global fetch)
 * @param {string}   [options.base]        clip base path (default: /assets/audio)
 * @param {Function} [options.decode]      (context, arrayBuffer) => Promise<AudioBuffer>
 */
export function createClipBank({ context, destination = null, fetchImpl = null, base = '/assets/audio', clips = AUDIO_CLIPS, decode = null } = {}) {
  if (!context || typeof context.createBufferSource !== 'function' || typeof context.decodeAudioData !== 'function') {
    throw new TypeError('A Web Audio context with decodeAudioData and createBufferSource is required.');
  }
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const decodeFn = decode || ((ctx, buffer) => ctx.decodeAudioData(buffer));
  const known = new Set(clips);
  const decoded = new Map();
  const inflight = new Map();

  async function load(name) {
    if (!known.has(name)) throw new Error(`Unknown clip: ${name}`);
    if (decoded.has(name)) return decoded.get(name);
    if (inflight.has(name)) return inflight.get(name);
    const pending = (async () => {
      const response = await doFetch(`${base}/${name}.ogg`);
      if (!response || response.ok === false) throw new Error(`Clip ${name} unavailable (HTTP ${response?.status ?? '?'}).`);
      const audio = await decodeFn(context, await response.arrayBuffer());
      decoded.set(name, audio);
      return audio;
    })().finally(() => inflight.delete(name));
    inflight.set(name, pending);
    return pending;
  }

  /** Load every clip, ignoring the ones that cannot be fetched; never rejects. */
  function warm() { return Promise.allSettled(clips.map((name) => load(name))); }

  /** Play one clip. Returns the BufferSource so a caller may stop it; `gain` is per-clip. */
  async function play(name, { gain = 1, when = 0 } = {}) {
    const audio = await load(name);
    const source = context.createBufferSource();
    source.buffer = audio;
    const target = destination || context.destination;
    if (typeof context.createGain === 'function') {
      const node = context.createGain();
      node.gain.value = gain;
      source.connect(node); node.connect(target);
    } else source.connect(target);
    source.start((context.currentTime || 0) + when);
    return source;
  }

  return {
    clips: [...clips],
    licence: AUDIO_BANK_LICENCE,
    notice: AUDIO_BANK_NOTICE,
    load,
    warm,
    play,
    loaded: () => decoded.size,
  };
}
