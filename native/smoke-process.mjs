// Lifecycle and loopback ports for disposable real-engine smokes. Raw evidence stays available to
// assertions; only failure messages are redacted. An overflowing capture fails rather than hiding
// evidence by silently keeping only the end of the log.
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { writeFile } from 'node:fs/promises';

const observed = new WeakMap();
const exited = child => child.exitCode !== null || child.signalCode !== null;

function observe(child) {
  if (observed.has(child)) return observed.get(child);
  const state = { done: exited(child), error: null, listeners: new Set() };
  const notify = () => { for (const listener of state.listeners) listener(); };
  child.on('error', error => { state.error = error; if (!child.pid) state.done = true; notify(); });
  child.once('exit', () => { state.done = true; notify(); });
  child.once('close', () => { state.done = true; notify(); });
  observed.set(child, state);
  return state;
}

const waitForExit = (state, timeoutMs) => {
  if (state.done) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = value => { clearTimeout(timer); state.listeners.delete(ready); resolve(value); };
    const ready = () => { if (state.done) finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    state.listeners.add(ready);
    ready();
  });
};

/** Already-signaled and failed-spawn children are terminal too; never wait for an old exit event. */
export async function stopSmokeChild(child, { timeoutMs = 2000, killTimeoutMs = 2000 } = {}) {
  if (!child) return;
  const state = observe(child);
  if (state.done || exited(child)) return;
  child.kill('SIGINT');
  if (await waitForExit(state, timeoutMs)) return;
  child.kill('SIGKILL');
  if (!await waitForExit(state, killTimeoutMs)) throw new Error('Luanti smoke engine did not exit after bounded SIGINT and SIGKILL cleanup.');
}

function redact(text, secrets) {
  let safe = text;
  for (const secret of secrets) if (typeof secret === 'string' && secret) safe = safe.split(secret).join('[redacted]');
  return safe.replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/(\b(?:token|password|nemo_bridge_key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]');
}

/** Start observing before the asynchronous spawn/error events can fire. */
export function startSmokeEngine(binary, args, { secrets = [], maxLogBytes = 262144, ...options } = {}) {
  const child = spawn(binary, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = observe(child), chunks = [];
  let bytes = 0, overflow = false;
  const collect = value => {
    const chunk = Buffer.from(value), remaining = maxLogBytes - bytes;
    if (chunk.length > remaining) overflow = true;
    if (remaining > 0) { const saved = chunk.subarray(0, remaining); chunks.push(saved); bytes += saved.length; }
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const raw = () => Buffer.concat(chunks, bytes).toString('utf8');
  const failure = reason => new Error(`Luanti smoke ${redact(reason, secrets)}.\n${redact(raw(), secrets).slice(-4000)}`);
  const logs = () => { if (overflow) throw failure(`log capture exceeded ${maxLogBytes} bytes; refusing incomplete evidence`); return raw(); };

  const waitForMarker = (marker, { timeoutMs = 30000 } = {}) => new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      for (const stream of [child.stdout, child.stderr]) stream.off('data', inspect);
      for (const event of ['exit', 'error', 'close']) child.off(event, inspect);
      if (error) reject(error); else resolve(raw());
    };
    const inspect = () => {
      if (overflow) return finish(failure(`log capture exceeded ${maxLogBytes} bytes; refusing incomplete evidence`));
      if (raw().includes(marker)) return finish();
      if (state.error) return finish(failure(`could not reach ${marker}: ${state.error.code || state.error.name}: ${state.error.message}`));
      if (state.done || exited(child)) return finish(failure(`exited before ${marker} (code=${child.exitCode}, signal=${child.signalCode})`));
    };
    const timer = setTimeout(() => finish(failure(`timed out waiting for ${marker} after ${timeoutMs} ms`)), timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', inspect);
    for (const event of ['exit', 'error', 'close']) child.on(event, inspect);
    inspect();
  });
  return { child, get logs() { return logs(); }, waitForMarker, stop: options => stopSmokeChild(child, options) };
}

/** Hold a kernel-selected IPv4 loopback UDP port until its engine config is ready to launch. */
export async function reserveLoopbackUdpPort() {
  const socket = createSocket('udp4');
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ address: '127.0.0.1', port: 0, exclusive: true }, () => { socket.off('error', reject); resolve(); });
  });
  const { address, port } = socket.address();
  let released = null;
  return { address, port, release() { return released ||= new Promise(resolve => socket.close(resolve)); } };
}

/** The engine cannot inherit a Node dgram socket: release its reservation immediately before spawn. */
export async function startLoopbackSmokeEngine(binary, args, { configPath, configText, ...options }) {
  const reservation = await reserveLoopbackUdpPort();
  try {
    await writeFile(configPath, configText(reservation.port), { mode: 0o600 });
    await reservation.release();
    return startSmokeEngine(binary, args, options);
  } finally { await reservation.release(); }
}
