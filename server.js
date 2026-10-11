import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Platform } from './src/platform.js';
import { acquireProcessLock, backupDatabase } from './src/recovery.js';
import { hostingConfiguration, validateRequestOrigin, createAuthenticationLimiter } from './src/hosting.js';
import { worldAtmosphere } from './src/atmosphere.js';

const root = dirname(fileURLToPath(import.meta.url));
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/missions', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/world.js', ['world.js', 'text/javascript; charset=utf-8']],
  ['/assets/fonts/dm-sans-latin-wght-normal.woff2', ['assets/fonts/dm-sans-latin-wght-normal.woff2', 'font/woff2']],
  ['/assets/fonts/space-grotesk-latin-wght-normal.woff2', ['assets/fonts/space-grotesk-latin-wght-normal.woff2', 'font/woff2']],
]);
for (const name of ['compass', 'map', 'earth', 'users-round', 'house', 'sprout', 'book-open', 'shield-check', 'settings', 'log-in', 'menu', 'clipboard-list', 'sparkles', 'chevron-right', 'x']) {
  files.set(`/assets/icons/${name}.svg`, [`assets/icons/${name}.svg`, 'image/svg+xml']);
}
const writes = new Map([
  ['/invites', ['invite', null]], ['/agents', ['createAgent', null]],
  ['/agents/control', ['agentControl', null]], ['/runtime/start', ['runtime', null]],
  ['/move', ['moveAgent', 'move']], ['/messages', ['message', 'chat']],
  ['/missions', ['createMission', null]], ['/missions/status', ['missionStatus', null]],
  ['/tasks', ['createTask', null]], ['/claims', ['claim', 'contribute']],
  ['/claims/release', ['releaseClaim', 'contribute']], ['/submissions', ['submit', 'contribute']],
  ['/reviews', ['review', null]], ['/adoptions', ['adoption', null]],
  ['/reports', ['report', 'contribute']], ['/moderation', ['moderate', null]],
  ['/appeals', ['appeal', null]], ['/appeals/decide', ['decideAppeal', null]],
  ['/operations/pause', ['pause', null]], ['/operations/accounts', ['accountControl', null]],
  ['/jobs', ['job', 'contribute']], ['/auth/logout', ['logout', null]],
  ['/emotes', ['emote', 'move']],
  ['/circles', ['createCircle', 'contribute']], ['/circles/membership', ['circleMembership', 'contribute']],
  ['/projects', ['createProject', 'contribute']], ['/projects/pledges', ['projectPledge', 'contribute']], ['/projects/milestones', ['projectMilestone', 'contribute']],
  ['/events', ['createEvent', 'contribute']], ['/events/rsvp', ['eventRSVP', 'contribute']], ['/thanks', ['giveThanks', 'contribute']],
  ['/community/manage', ['manageCommunity', null]],
  ['/journey/profile', ['updateProfile', 'contribute']], ['/journey/journal', ['writeJournal', 'contribute']],
  ['/journey/garden', ['gardenAction', 'build']], ['/journey/craft', ['craftItem', 'build']],
]);
const gets = new Set(['/health', '/bootstrap', '/world', '/worlds', '/missions', '/gallery', '/me', '/history', '/safety', '/operations', '/export', '/runtime/status', '/community', '/journey']);

function headers(response, hosting) {
  if (hosting.publicOrigin) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function body(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) fail(415, 'Use application/json.');
  if (Number(request.headers['content-length']) > 65536) fail(413, 'Request exceeds 64 KiB.');
  const chunks = []; let length = 0;
  const deadline = setTimeout(() => request.destroy(Object.assign(new Error('Request body deadline exceeded.'), { status: 408 })), 15_000);
  deadline.unref();
  try {
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 65536) fail(413, 'Request exceeds 64 KiB.');
      chunks.push(chunk);
    }
  } finally { clearTimeout(deadline); }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Expected a JSON object.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Expected a JSON object.');
  return input;
}
function tokenFrom(request) {
  const authorization = request.headers.authorization;
  if (authorization) {
    if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) fail(401, 'Invalid authorization header.');
    return authorization.slice(7);
  }
  const cookie = request.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith('world_session='));
  return cookie?.slice(14);
}
function cookie(response, token, expires, hosting) {
  response.setHeader('Set-Cookie', `world_session=${token}; Path=/; HttpOnly; SameSite=Strict${hosting.publicOrigin ? '; Secure' : ''}; Max-Age=${Math.max(0, Math.floor((expires - Date.now()) / 1000))}`);
}

export function createApp({ platform = new Platform(process.env.LUCY_DATABASE || join(root, 'data', 'world.sqlite')), backupDir = join(root, 'data', 'backups'), publicOrigin = process.env.LUCY_PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || '', setupCode = process.env.LUCY_SETUP_CODE } = {}) {
  const hosting = hostingConfiguration({ LUCY_PUBLIC_ORIGIN: publicOrigin, LUCY_SETUP_CODE: setupCode });
  const setupRequired = platform.get('SELECT COUNT(*) AS n FROM accounts').n === 0;
  if (hosting.publicOrigin && setupRequired && !hosting.setupCode) throw new Error('Set the private LUCY_SETUP_CODE before starting a public server with no administrator.');
  platform.publicMode = Boolean(hosting.publicOrigin);
  platform.setupCode = hosting.setupCode;
  const authLimiter = createAuthenticationLimiter({ publicMode: Boolean(hosting.publicOrigin) });
  const server = createServer(async (request, response) => {
    headers(response, hosting);
    try {
      validateRequestOrigin(request, server, hosting);
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      if (!path.startsWith('/api/')) {
        const file = files.get(path);
        if (!file) return json(response, 404, { error: 'Not found.' });
        if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); return json(response, 405, { error: 'Method not allowed.' }); }
        const data = await readFile(join(root, file[0]));
        response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
        return response.end(request.method === 'HEAD' ? undefined : data);
      }
      if (!path.startsWith('/api/v1/')) return json(response, 404, { error: 'Not found.' });
      const route = path.slice(7);
      const match = /^\/agents\/([^/]+)\/(travel|build|home|heartbeat|posture)$/.exec(route);
      let agentId;
      if (match) { try { agentId = decodeURIComponent(match[1]); } catch { fail(400, 'Invalid agent identifier.'); } }
      const dynamic = match ? { id: agentId, action: match[2], method: match[2] === 'home' ? 'PATCH' : 'POST', scope: { travel: 'move', build: 'build', home: 'build', heartbeat: 'read', posture: 'move' }[match[2]] } : null;
      const specialWrite = ['/auth/register', '/auth/login', '/operations/backup'].includes(route);
      if (!gets.has(route) && !writes.has(route) && !specialWrite && !dynamic) return json(response, 404, { error: 'Not found.' });
      if (!(request.method === 'GET' && gets.has(route)) && !(request.method === 'POST' && (writes.has(route) || specialWrite)) && !(request.method === 'DELETE' && route === '/me') && !(dynamic && request.method === dynamic.method)) {
        response.setHeader('Allow', [gets.has(route) ? 'GET' : null, writes.has(route) || specialWrite ? 'POST' : null, route === '/me' ? 'DELETE' : null, dynamic?.method].filter(Boolean).join(', '));
        return json(response, 405, { error: 'Method not allowed.' });
      }
      if (route === '/health') {
        platform.get('SELECT 1');
        return json(response, 200, { status: 'ok', storage: 'sqlite', model_configured: Boolean(process.env.LUCY_MODEL_NAME) });
      }
      if (route === '/bootstrap') {
        const setupRequired = platform.get('SELECT COUNT(*) AS n FROM accounts').n === 0;
        return json(response, 200, { setup_required: setupRequired, setup_code_required: setupRequired && Boolean(hosting.publicOrigin) });
      }
      if (route === '/auth/register' || route === '/auth/login') {
        let endAttempt;
        try {
          endAttempt = authLimiter.begin(request.socket.remoteAddress);
          const input = await body(request);
          authLimiter.account(input.email);
          const result = await platform[route.endsWith('register') ? 'register' : 'login'](input);
          cookie(response, result.token, result.expires_at, hosting);
          const { token, ...safe } = result;
          return json(response, route.endsWith('register') ? 201 : 200, request.headers['x-api-client'] === 'operator' ? result : safe);
        } catch (error) {
          if (error.status === 429) response.setHeader('Retry-After', '60');
          throw error;
        } finally { endAttempt?.(); }
      }
      const token = tokenFrom(request);
      const publicRoute = ['/world', '/worlds', '/missions', '/gallery', '/community'].includes(route) && request.method === 'GET';
      const scope = request.method === 'GET' ? (route === '/runtime/status' ? null : 'read') : dynamic?.scope || writes.get(route)?.[1];
      let actor = token ? platform.authenticate(token, scope) : publicRoute ? null : platform.authenticate(token, scope);
      if (actor?.kind === 'runtime' && ((request.method === 'POST' && !scope) || dynamic?.action === 'home' || ['/me', '/export', '/operations', '/safety'].includes(route) || request.method === 'DELETE')) fail(403, 'A human operator session is required.');
      if (request.method === 'GET') {
        const result = platform.transaction(() => {
          let value;
          if (route === '/world') { value = platform.world(actor, Object.fromEntries(url.searchParams)); value.atmosphere = worldAtmosphere(platform.clock()); }
          else if (route === '/worlds') value = platform.worldList(actor, Object.fromEntries(url.searchParams));
          else if (route === '/community') value = platform.community(actor, Object.fromEntries(url.searchParams));
          else if (route === '/journey') value = platform.journey(actor, Object.fromEntries(url.searchParams));
          else if (route === '/missions') value = platform.missionList(actor);
          else if (route === '/gallery') value = platform.gallery();
          else if (route === '/export') value = platform.exportAccount(actor);
          else if (route === '/runtime/status') value = platform.runtimeStatus(actor);
          else value = platform[route.slice(1)](actor);
          if (actor && route !== '/runtime/status') platform.charge(actor);
          return value;
        });
        return json(response, 200, result);
      }
      if (request.method === 'DELETE') {
        const result = platform.transaction(() => platform.deleteAccount(actor));
        cookie(response, '', 0, hosting);
        return json(response, 200, result);
      }
      const input = await body(request);
      // Parsing yields to other requests: check revocation and budgets again before writing.
      actor = platform.authenticate(token, scope);
      if (route === '/operations/backup') {
        platform.operations(actor); // Role check before touching any files.
        const filename = `world-${Date.now()}-${randomUUID()}.sqlite`;
        backupDatabase(platform.db, join(backupDir, filename));
        platform.transaction(() => platform.audit(actor.account.id, 'backup.created', filename));
        return json(response, 201, { filename });
      }
      const [method] = writes.get(route) || [];
      const result = platform.transaction(() => {
        let value;
        if (dynamic) value = platform[{ travel: 'travel', build: 'build', home: 'homeSettings', heartbeat: 'heartbeat', posture: 'posture' }[dynamic.action]](actor, dynamic.id, input);
        else if (route === '/agents/control') value = platform.agentControl(actor, input.agent_id, input.status);
        else if (route === '/runtime/start') value = platform.runtime(actor, input.agent_id, input);
        else if (route === '/missions/status') value = platform.missionStatus(actor, input.mission_id, input.status);
        else if (route === '/claims/release') value = platform.releaseClaim(actor, input.claim_id);
        else if (route === '/operations/pause') {
          if (typeof input.paused !== 'boolean') fail(400, 'paused must be a boolean.');
          value = platform.pause(actor, input.paused);
        } else if (['/claims', '/submissions'].includes(route)) value = platform[method](actor, input, request.headers['idempotency-key']);
        else value = platform[method](actor, input);
        platform.charge(actor);
        return value;
      });
      if (route === '/auth/logout') cookie(response, '', 0, hosting);
      return json(response, dynamic?.action === 'build' || ['/invites', '/agents', '/runtime/start', '/missions', '/tasks', '/claims', '/submissions', '/reviews', '/reports', '/appeals', '/adoptions', '/jobs'].includes(route) ? 201 : 200, result);
    } catch (error) {
      if (!error.status) console.error('HTTP request failed:', error.code || error.name || 'UnknownError');
      const status = error.status || (error.code === 'ERR_SQLITE_ERROR' && /constraint/i.test(error.message) ? 409 : 500);
      if (!response.headersSent) json(response, status, { error: status === 500 ? 'Server error.' : status === 409 && !error.status ? 'This record conflicts with an existing record.' : error.message });
      else response.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return { server, platform };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let platform, releaseLock, server;
  try {
    const hosting = hostingConfiguration();
    const databasePath = process.env.LUCY_DATABASE || join(root, 'data', 'world.sqlite');
    releaseLock = acquireProcessLock(join(dirname(databasePath), 'server.lock'));
    platform = new Platform(databasePath);
    ({ server } = createApp({ platform, backupDir: join(dirname(databasePath), 'backups'), publicOrigin: hosting.publicOrigin || '', setupCode: hosting.setupCode }));
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      server.close(() => { platform.close(); releaseLock(); });
      server.closeIdleConnections();
    };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    server.once('error', (error) => { platform.close(); releaseLock(); console.error(error.message); process.exitCode = 1; });
    server.listen(Number(process.env.PORT || 3000), hosting.bindHost, () => console.log(`Shared World is ready at ${hosting.publicOrigin || `http://127.0.0.1:${server.address().port}`}`));
  } catch (error) {
    platform?.close(); releaseLock?.(); console.error(error.message); process.exitCode = 1;
  }
}
