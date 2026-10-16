import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalAI } from './local-ai.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const host = '127.0.0.1';
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('NemoWorld needs Node.js 24 or newer. Install it from https://nodejs.org, then open the launcher again.');
  process.exit(1);
}

async function availablePort(port) {
  const probe = createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', (error) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

async function openBrowser(url) {
  if (process.env.LUCY_OPEN_BROWSER === '0') return;
  const command = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32'
    ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url];
  const browser = spawn(command[0], command.slice(1), { stdio: 'ignore', shell: false });
  browser.on('error', () => console.log('Open the address shown above in your browser.'));
  browser.unref();
}

async function launch() {
  const basePort = Number(process.env.PORT || 3000);
  if (!Number.isInteger(basePort) || basePort < 1024 || basePort > 65525) throw new Error('PORT must be an integer from 1024 to 65525.');
  let port = basePort;
  while (port < basePort + 10 && !await availablePort(port)) port++;
  if (port === basePort + 10) throw new Error('No available local port. Close another application or set PORT to a different number.');
  let url = `http://${host}:${port}`;
  const controller = new AbortController();
  const cancelStartup = () => controller.abort();
  process.once('SIGINT', cancelStartup);
  process.once('SIGTERM', cancelStartup);
  let localAI;
  try { localAI = await startLocalAI(root, { signal: controller.signal }); }
  catch (error) {
    if (controller.signal.aborted) return;
    console.error(`Local AI unavailable: ${error.message} World guides will use their rules.`);
  } finally {
    process.removeListener('SIGINT', cancelStartup);
    process.removeListener('SIGTERM', cancelStartup);
  }
  const child = spawn(process.execPath, [join(root, 'server.js')], {
    cwd: root, stdio: ['inherit', 'pipe', 'inherit'], shell: false,
    env: { ...process.env, ...localAI?.env, PORT: String(port), LUCY_BIND_HOST: host, LUCY_PUBLIC_ORIGIN: '', RENDER_EXTERNAL_URL: '', LUCY_LOCAL_PORT_FALLBACK: '1' },
  });
  let ready = false;
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    buffer = (buffer + chunk.toString()).slice(-2048);
    if (!ready && buffer.includes('NemoWorld is ready at ')) {
      ready = true;
      url = /NemoWorld is ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer)?.[1] || url;
      console.log(`\nYour world: ${url}\nKeep this window open. Press Ctrl+C to stop; your world is saved.\nCreate your administrator account in the browser on first launch.\n`);
      void openBrowser(url);
    }
  });
  const stop = () => { if (child.exitCode === null) child.kill('SIGTERM'); localAI?.stop(); };
  if (localAI) localAI.child.once('exit', () => console.log('Local AI stopped. Restart the launcher to restore model responses.'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const [code, signal] = await once(child, 'exit');
    process.exitCode = code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1);
  } finally {
    localAI?.stop();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

launch().catch((error) => { console.error(error.message); process.exitCode = 1; });
