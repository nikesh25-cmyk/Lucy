import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';

export const LOCAL_AI = Object.freeze({
  release: 'b11429',
  archive: 'llama-b11429-bin-macos-arm64.tar.gz',
  archiveSha256: '740288ec6887be94280a5dfa25b5e23a78285cab104519e6c7e218904ee82459',
  model: 'Qwen3-4B-Q4_K_M.gguf',
  modelCommit: 'bc640142c66e1fdd12af0bd68f40445458f3869b',
  modelSha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
  modelBytes: 2497280256,
});

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function freePort() {
  const probe = createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

// The installer writes the receipt only after verifying official release hashes.
// Every launch rechecks the model and executable; partial downloads never run.
export async function startLocalAI(root, { signal, log = console.log } = {}) {
  if (process.env.LUCY_MODEL_NAME || process.env.LUCY_LOCAL_AI === '0') return null;
  const directory = join(root, '.runtime', 'ai');
  let receipt;
  try { receipt = JSON.parse(await readFile(join(directory, 'verified.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Local AI receipt is unreadable. Run Enable Local AI.command again.');
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The bundled local AI runtime requires an Apple Silicon Mac.');
  const model = join(directory, 'models', LOCAL_AI.model);
  const executable = join(directory, `llama-${LOCAL_AI.release}`, 'llama-server');
  if (receipt.model_sha256 !== LOCAL_AI.modelSha256 || receipt.archive_sha256 !== LOCAL_AI.archiveSha256 || !/^[a-f0-9]{64}$/.test(receipt.executable_sha256 || '')) throw new Error('Local AI receipt does not match the pinned release.');
  log('Verifying local AI files…');
  if ((await stat(model)).size !== LOCAL_AI.modelBytes || await sha256(model) !== LOCAL_AI.modelSha256 || await sha256(executable) !== receipt.executable_sha256) throw new Error('Local AI checksum failed. Run Enable Local AI.command to repair the installation.');
  if (!receipt.files || receipt.files['llama-server'] !== receipt.executable_sha256) throw new Error('Local AI runtime receipt is incomplete.');
  for (const [name, hash] of Object.entries(receipt.files)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(hash) || await sha256(join(directory, `llama-${LOCAL_AI.release}`, name)) !== hash) throw new Error('Local AI runtime library checksum failed.');
  }
  signal?.throwIfAborted();
  const port = await freePort(), key = randomBytes(32).toString('hex');
  const child = spawn(executable, ['--model', model, '--host', '127.0.0.1', '--port', String(port), '--alias', 'lucy-local', '--ctx-size', '8192', '--parallel', '1', '--threads', '4', '--n-gpu-layers', '99', '--jinja', '--no-webui'], {
    cwd: directory, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, LLAMA_API_KEY: key },
  });
  let errorOutput = '', spawnError;
  child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-1000); });
  child.on('error', error => { spawnError = error; });
  const stop = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
  signal?.addEventListener('abort', stop, { once: true });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      signal?.throwIfAborted();
      if (spawnError || child.exitCode !== null) throw new Error('The local AI runtime could not start. ' + (spawnError?.code || errorOutput.slice(-300)));
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500), headers: { Authorization: `Bearer ${key}` } });
        if (response.ok) {
          log('Local Qwen AI is ready on this Mac.');
          return { child, stop, env: { LUCY_MODEL_BACKEND: 'llama.cpp', LUCY_MODEL_NAME: 'lucy-local', LUCY_MODEL_URL: url, LUCY_MODEL_KEY: key } };
        }
      } catch {}
      await delay(500, undefined, { signal });
    }
    throw new Error('Local AI startup timed out.');
  } catch (error) { stop(); throw error; }
  finally { signal?.removeEventListener('abort', stop); }
}
