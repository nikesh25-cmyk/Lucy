import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const WORLD = 'frontier:0:0';
const SIZE = 48;
const TYPES = new Set(['stone', 'wood', 'glass', 'brick', 'sand', 'grass', 'path']);
const apiBase = process.env.NEMO_API || 'http://127.0.0.1:3000';

export function nativeToNemo(pos) {
  const x = pos?.x, y = pos?.z, z = pos?.y;
  if (![x, y, z].every(Number.isInteger) || x < 0 || x >= SIZE || y < 0 || y >= SIZE || z < 0 || z > 7) throw Object.assign(new Error('Outside the native sector boundary.'), {status: 400});
  return {x, y, z};
}
export function nemoToNative(pos) { return {x: pos.x, y: pos.z, z: pos.y}; }

export function createBridge({api = apiBase, fetcher = fetch, clock = Date.now, modKey = process.env.NEMO_MOD_KEY} = {}) {
  if (typeof modKey !== 'string' || modKey.length < 32) throw new Error('A random NEMO_MOD_KEY of at least 32 characters is required.');
  const pending = new Map(), players = new Map();
  async function call(path, token, method = 'GET', payload) {
    const response = await fetcher(new URL('/api/v1' + path, api), {method, headers: {'Authorization': `Bearer ${token}`, ...(payload ? {'Content-Type': 'application/json', 'Origin': new URL(api).origin} : {})}, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(5000)});
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error || body.message || `NemoWorld ${response.status}`), {status: response.status});
    return body;
  }
  async function owner(token, agentId) {
    const me = await call('/me', token);
    const agent = me.agents.find(item => item.id === agentId && item.kind === 'human' && item.status === 'active');
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
    try {
      if (request.socket.remoteAddress !== '127.0.0.1' && request.socket.remoteAddress !== '::1' && request.socket.remoteAddress !== '::ffff:127.0.0.1') throw Object.assign(new Error('Loopback only.'), {status: 403});
      if (url.pathname === '/' && request.method === 'GET') {
        response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"});
        response.end(`<!doctype html><html><meta charset="utf-8"><title>NemoWorld native pairing</title><style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:1rem;background:#102921;color:#f4eedb}input,button{font:inherit;padding:.7rem;display:block;width:100%;box-sizing:border-box;margin:.6rem 0}button{background:#d6b970;border:0;cursor:pointer}code{font-size:1.5rem}</style><h1>Pair a Luanti player</h1><p>Sign in to NemoWorld in another tab. Use an active human avatar already in frontier:0:0. Your operator session token stays in this local browser form and bridge memory.</p><form id="pair" autocomplete="off"><label>Operator session token<input id="token" type="password" required autocomplete="off"></label><label>Human avatar ID<input id="agent" required autocomplete="off"></label><button>Create two-minute code</button></form><p id="result" role="status"></p><script>document.querySelector('#pair').onsubmit=async e=>{e.preventDefault();const r=await fetch('/pair/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.querySelector('#token').value,agent_id:document.querySelector('#agent').value})});document.querySelector('#token').value='';const b=await r.json();document.querySelector('#result').textContent=r.ok?'In Luanti, type /nemo_pair '+b.code:b.error}</script></html>`);
        return;
      }
      if (url.pathname === '/health') return send(200, {world_id: WORLD, size: SIZE, paired_players: players.size});
      if (request.method === 'POST' && request.headers['content-type'] !== 'application/json') throw Object.assign(new Error('JSON required.'), {status: 415});
      if (url.pathname === '/pair/start' && request.headers.origin && request.headers.origin !== `http://127.0.0.1:${request.socket.localPort}`) throw Object.assign(new Error('Local origin required.'), {status: 403});
      if (url.pathname.startsWith('/native/') && request.headers['x-nemo-mod-key'] !== modKey) throw Object.assign(new Error('Native mod authentication required.'), {status: 401});
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 8192) throw Object.assign(new Error('Payload too large.'), {status: 413}); chunks.push(chunk); }
      const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (url.pathname === '/pair/start' && request.method === 'POST') {
        if (!/^[a-f0-9]{64}$/.test(input.token || '')) throw Object.assign(new Error('Operator session token required.'), {status: 400});
        await owner(input.token, input.agent_id);
        for (const [candidate, pair] of pending) if (pair.expires <= clock()) pending.delete(candidate);
        if (pending.size >= 16) throw Object.assign(new Error('Too many pending local pairings.'), {status: 429});
        const code = randomBytes(6).toString('hex');
        pending.set(code, {token: input.token, agentId: input.agent_id, expires: clock() + 120000});
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
