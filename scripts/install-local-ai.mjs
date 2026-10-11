import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, stat, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_AI, sha256 } from './local-ai.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = join(root, '.runtime', 'ai');
const children = new Set();
const stop = () => { for (const child of children) child.kill('SIGTERM'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);

async function run(command, args) {
  const child = spawn(command, args, { shell: false, stdio: 'inherit' });
  children.add(child);
  try { const [code] = await once(child, 'exit'); if (code !== 0) throw new Error(`${command} stopped. Downloaded bytes are retained; run the installer again to resume.`); }
  finally { children.delete(child); }
}
async function download(url, path, expectedHash) {
  try { if (await sha256(path) === expectedHash) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await run('curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2', '--http1.1', '--speed-limit', '1024', '--speed-time', '90', '--retry', '3', '--continue-at', '-', '--max-time', '1800', url, '-o', path]);
  if (await sha256(path) !== expectedHash) throw new Error('Downloaded checksum does not match the official release. No model will be enabled. Remove the corrupt download and retry.');
}
async function install() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This local AI package currently supports Apple Silicon Macs. Other computers can configure an installed local Ollama model.');
  await mkdir(join(directory, 'models'), { recursive: true });
  const archive = join(directory, LOCAL_AI.archive), model = join(directory, 'models', LOCAL_AI.model);
  console.log('Installing project-local AI: llama.cpp (MIT) and Qwen3-4B (Apache 2.0). Download: 2.5 GB; allow at least 5 GB free space.');
  await download(`https://github.com/ggml-org/llama.cpp/releases/download/${LOCAL_AI.release}/${LOCAL_AI.archive}`, archive, LOCAL_AI.archiveSha256);
  await download(`https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/${LOCAL_AI.modelCommit}/${LOCAL_AI.model}?download=true`, model, LOCAL_AI.modelSha256);
  if ((await stat(model)).size !== LOCAL_AI.modelBytes) throw new Error('Model size does not match its official metadata.');
  await run('tar', ['-xzf', archive, '-C', directory]);
  const runtime = join(directory, `llama-${LOCAL_AI.release}`), files = {};
  for (const entry of await readdir(runtime, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === 'llama-server' || entry.name.endsWith('.dylib'))) files[entry.name] = await sha256(join(runtime, entry.name));
  }
  if (!files['llama-server']) throw new Error('Verified release has no llama-server.');
  await writeFile(join(directory, 'verified.json'), JSON.stringify({ installed: new Date().toISOString(), release: LOCAL_AI.release, archive_sha256: LOCAL_AI.archiveSha256, model_commit: LOCAL_AI.modelCommit, model_sha256: LOCAL_AI.modelSha256, executable_sha256: files['llama-server'], files }, null, 2) + '\n', { mode: 0o600 });
  console.log('Local AI installation verified. Open Start World.command to use it.');
}
install().catch(error => { console.error(error.message); process.exitCode = 1; });
