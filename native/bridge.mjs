import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const WORLD = 'frontier:0:0';
const SIZE = 48;
const TYPES = new Set(['stone', 'wood', 'glass', 'brick', 'sand', 'grass', 'path']);
const apiBase = process.env.NEMO_API || 'http://127.0.0.1:3000';

// This bridge holds a human operator credential in memory. Keep every authenticated request on
// literal loopback, even when an environment variable is mistyped or the local API redirects.
export function localApiOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('NEMO_API must be a local HTTP origin.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('NEMO_API must be a literal http://127.0.0.1 origin with no credentials or path.');
  }
  return url.origin;
}

export function nativeToNemo(pos) {
  const x = pos?.x, y = pos?.z, z = pos?.y;
  if (![x, y, z].every(Number.isInteger) || x < 0 || x >= SIZE || y < 0 || y >= SIZE || z < 0 || z > 7) throw Object.assign(new Error('Outside the native sector boundary.'), {status: 400});
  return {x, y, z};
}
export function nemoToNative(pos) { return {x: pos.x, y: pos.z, z: pos.y}; }

export function createBridge({api = apiBase, fetcher = fetch, clock = Date.now, modKey = process.env.NEMO_MOD_KEY} = {}) {
  if (typeof modKey !== 'string' || modKey.length < 32) throw new Error('A random NEMO_MOD_KEY of at least 32 characters is required.');
  const localApi = localApiOrigin(api);
  const pending = new Map(), loginSessions = new Map(), loginAttempts = new Map(), players = new Map();
  const csrfToken = randomBytes(24).toString('hex');
  async function call(path, token, method = 'GET', payload) {
    const response = await fetcher(new URL('/api/v1' + path, localApi), {method, headers: {'Authorization': `Bearer ${token}`, ...(payload ? {'Content-Type': 'application/json', 'Origin': localApi} : {})}, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(5000), redirect: 'error'});
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error || body.message || `NemoWorld ${response.status}`), {status: response.status});
    return body;
  }
  async function login(email, password) {
    const response = await fetcher(new URL('/api/v1/auth/login', localApi), {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Origin': localApi, 'X-API-Client': 'operator'},
      body: JSON.stringify({email, password}), signal: AbortSignal.timeout(5000), redirect: 'error'
    });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error || body.message || `NemoWorld ${response.status}`), {status: response.status});
    if (!/^[a-f0-9]{64}$/.test(body.token || '')) throw Object.assign(new Error('NemoWorld did not return an operator session.'), {status: 502});
    return body.token;
  }
  async function owner(token, agentId) {
    const me = await call('/me', token);
    const agent = (Array.isArray(me.agents) ? me.agents : []).find(item => item.id === agentId && item.kind === 'human' && item.status === 'active');
    if (!agent) throw Object.assign(new Error('Pair an active human avatar owned by this operator.'), {status: 403});
    return agent;
  }
  async function current(player) {
    const pair = players.get(player);
    if (!pair || pair.expires <= clock()) throw Object.assign(new Error('Pair this player again.'), {status: 401});
    const agent = await owner(pair.token, pair.agentId); // checks revocation before every action
    if (agent.world_id !== WORLD) throw Object.assign(new Error('Enter frontier:0:0 in NemoWorld first.'), {status: 409});
    return {pair, agent};
  }
  async function route(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, value) => {response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); response.end(JSON.stringify(value));};
    const localOrigin = `http://127.0.0.1:${request.socket.localPort}`;
    const browserProtection = () => {
      if (request.headers.origin !== localOrigin || request.headers['x-csrf-token'] !== csrfToken) throw Object.assign(new Error('Local origin and CSRF token required.'), {status: 403});
    };
    try {
      if (request.socket.remoteAddress !== '127.0.0.1' && request.socket.remoteAddress !== '::1' && request.socket.remoteAddress !== '::ffff:127.0.0.1') throw Object.assign(new Error('Loopback only.'), {status: 403});
      if (url.pathname === '/' && request.method === 'GET') {
        response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"});
        response.end(`<!doctype html><html><meta charset="utf-8"><meta name="csrf-token" content="${csrfToken}"><title>NemoWorld native pairing</title><style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:1rem;background:#102921;color:#f4eedb}input,select,button{font:inherit;padding:.7rem;display:block;width:100%;box-sizing:border-box;margin:.6rem 0}button{background:#d6b970;border:0;cursor:pointer}code{font-size:1.5rem}</style><h1>Pair a Luanti player</h1><p>Sign in with your NemoWorld operator account. The bridge keeps the session only in memory on this computer and never shows or copies its raw token.</p><form id="login" autocomplete="off"><label>Email<input id="email" type="email" required maxlength="320" autocomplete="username"></label><label>Password<input id="password" type="password" required maxlength="128" autocomplete="current-password"></label><button>Sign in and load human avatars</button></form><form id="pair" autocomplete="off" hidden><label>Active human avatar<select id="agent" required></select></label><button>Create two-minute code</button></form><p id="result" role="status"></p><script>const csrf=document.querySelector('meta[name=csrf-token]').content,headers={'Content-Type':'application/json','X-CSRF-Token':csrf},loginForm=document.querySelector('#login'),pairForm=document.querySelector('#pair'),result=document.querySelector('#result');let loginId;loginForm.onsubmit=async e=>{e.preventDefault();const password=document.querySelector('#password');const r=await fetch('/pair/login',{method:'POST',headers,body:JSON.stringify({email:document.querySelector('#email').value,password:password.value})});password.value='';const b=await r.json();if(!r.ok){result.textContent=b.error;return}loginId=b.login_id;const select=document.querySelector('#agent');select.replaceChildren(...b.agents.map(a=>new Option(a.name+' ('+a.id+')',a.id)));pairForm.hidden=!b.agents.length;result.textContent=b.agents.length?'Choose an active human avatar already in frontier:0:0.':'No active human avatar is available for this operator.'};pairForm.onsubmit=async e=>{e.preventDefault();const r=await fetch('/pair/start',{method:'POST',headers,body:JSON.stringify({login_id:loginId,agent_id:document.querySelector('#agent').value})});const b=await r.json();result.textContent=r.ok?'In Luanti, type /nemo_pair '+b.code:b.error}</script></html>`);
        return;
      }
      if (url.pathname === '/health') return send(200, {world_id: WORLD, size: SIZE, paired_players: players.size});
      if (request.method === 'POST' && request.headers['content-type'] !== 'application/json') throw Object.assign(new Error('JSON required.'), {status: 415});
      if (url.pathname === '/pair/start' && request.headers.origin && request.headers.origin !== localOrigin) throw Object.assign(new Error('Local origin required.'), {status: 403});
      if (url.pathname.startsWith('/native/') && request.headers['x-nemo-mod-key'] !== modKey) throw Object.assign(new Error('Native mod authentication required.'), {status: 401});
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 8192) throw Object.assign(new Error('Payload too large.'), {status: 413}); chunks.push(chunk); }
      const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (url.pathname === '/pair/login' && request.method === 'POST') {
        browserProtection();
        if (typeof input.email !== 'string' || input.email.length < 3 || input.email.length > 320 || typeof input.password !== 'string' || input.password.length < 1 || input.password.length > 128) throw Object.assign(new Error('Email and password are required.'), {status: 400});
        const now = clock(), address = request.socket.remoteAddress;
        const recent = (loginAttempts.get(address) || []).filter(time => time > now - 60000);
        if (recent.length >= 5) throw Object.assign(new Error('Too many local sign-in attempts. Try again shortly.'), {status: 429});
        recent.push(now); loginAttempts.set(address, recent);
        const token = await login(input.email, input.password);
        const me = await call('/me', token);
        const agents = (Array.isArray(me.agents) ? me.agents : []).filter(item => item.kind === 'human').map(item => ({id:item.id, name:item.name || item.id, status:item.status, world_id:item.world_id}));
        const available = agents.filter(item => item.status === 'active' && item.world_id === WORLD);
        if (!available.length) throw Object.assign(new Error(`Move an active human avatar into ${WORLD} in NemoWorld, then sign in here again.`), {status: 403});
        for (const [handle, session] of loginSessions) if (session.expires <= now) loginSessions.delete(handle);
        if (loginSessions.size >= 16) throw Object.assign(new Error('Too many pending local sign-ins. Try again shortly.'), {status: 429});
        const loginId = randomBytes(24).toString('hex');
        loginSessions.set(loginId, {token, expires: now + 10 * 60000});
        return send(200, {login_id: loginId, agents: available});
      }
      if (url.pathname === '/pair/start' && request.method === 'POST') {
        if (typeof input.agent_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.agent_id)) throw Object.assign(new Error('Human avatar ID required.'), {status: 400});
        let pairToken = input.token;
        if (input.login_id !== undefined) {
          browserProtection();
          if (!/^[a-f0-9]{48}$/.test(input.login_id)) throw Object.assign(new Error('Local sign-in session required.'), {status: 400});
          const session = loginSessions.get(input.login_id); loginSessions.delete(input.login_id);
          if (!session || session.expires <= clock()) throw Object.assign(new Error('Local sign-in session expired.'), {status: 401});
          pairToken = session.token;
        } else if (!/^[a-f0-9]{64}$/.test(pairToken || '')) throw Object.assign(new Error('Operator session token required.'), {status: 400});
        await owner(pairToken, input.agent_id);
        for (const [candidate, pair] of pending) if (pair.expires <= clock()) pending.delete(candidate);
        if (pending.size >= 16) throw Object.assign(new Error('Too many pending local pairings.'), {status: 429});
        const code = randomBytes(6).toString('hex');
        pending.set(code, {token: pairToken, agentId: input.agent_id, expires: clock() + 120000});
        return send(200, {code, expires_in_seconds: 120});
      }
      if (url.pathname === '/native/pair' && request.method === 'POST') {
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(input.player || '')) throw Object.assign(new Error('Invalid native player.'), {status: 400});
        const pair = pending.get(input.code); pending.delete(input.code);
        if (!pair || pair.expires <= clock()) throw Object.assign(new Error('Pair code expired.'), {status: 401});
        await owner(pair.token, pair.agentId);
        players.clear(); // one local native player session per bridge instance
        players.set(input.player, {...pair, expires: Math.min(pair.expires + 18 * 60000, clock() + 20 * 60000)});
        return send(200, {paired: true, world_id: WORLD});
      }
      if (url.pathname === '/native/state' && request.method === 'POST') {
        const {pair, agent} = await current(input.player);
        const windows = [];
        for (const y of [0, 14, 28, 34]) for (const x of [0, 20, 28]) windows.push(call(`/world?world_id=${WORLD}&agent_id=${pair.agentId}&x=${x}&y=${y}`, pair.token));
        const views = await Promise.all(windows);
        const blocks = [...new Map(views.flatMap(view => view.blocks).map(block => [`${block.x}:${block.y}:${block.z}`, block])).values()];
        const terrain = [...new Map(views.flatMap(view => (view.terrain || []).flatMap((row, ry) => row.map((type, rx) => ({x:view.camera.x+rx,y:view.camera.y+ry,type})))).map(tile => [`${tile.x}:${tile.y}`,tile])).values()];
        const participants = [...new Map(views.flatMap(view => view.participants || []).filter(item => item.id && item.id !== pair.agentId).map(item => [item.id,{id:item.id,name:item.name,kind:item.kind,x:item.x,y:item.y,z:item.z || 0}])).values()];
        return send(200, {world_id: WORLD, size: SIZE, blocks, terrain, participants, player: {x: agent.x, y: agent.y, z: agent.z}});
      }
      if (url.pathname === '/native/action' && request.method === 'POST') {
        const {pair} = await current(input.player);
        let path, payload;
        if (input.action === 'move' && ['up','down','left','right'].includes(input.direction)) {
          path = '/move'; payload = {agent_id: pair.agentId, direction: input.direction};
        } else if (input.action === 'place' && TYPES.has(input.type)) {
          path = '/frontier/build'; payload = {agent_id: pair.agentId, world_id: WORLD, ...nativeToNemo(input.pos), type: input.type};
        } else if (input.action === 'remove') {
          path = '/frontier/build'; payload = {agent_id: pair.agentId, world_id: WORLD, ...nativeToNemo(input.pos), remove: true};
        } else throw Object.assign(new Error('Unsupported native action.'), {status: 400});
        const result = await call(path, pair.token, 'POST', payload);
        return send(200, {accepted: true, result});
      }
      send(404, {error: 'Unknown bridge route.'});
    } catch (error) { send(error.status >= 400 && error.status < 600 ? error.status : 502, {error: error.message}); }
  }
  return createServer(route);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.NEMO_BRIDGE_PORT || 3999);
  createBridge().listen(port, '127.0.0.1', () => process.stdout.write(`NemoWorld native bridge listening on 127.0.0.1:${port}\n`));
}
