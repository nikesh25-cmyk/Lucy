import {createServer} from 'node:http';
import {randomBytes, createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {palette} from '../src/content.js';

const WORLD = 'frontier:0:0';
const SIZE = 48;
const TYPES = new Set(palette('frontier'));
const frontierWorld = /^frontier:(-?\d+):(-?\d+)$/;
const apiBase = process.env.NEMO_API || 'http://127.0.0.1:3000';

// Canonical finite frontier ID prefilter. Actual existence/open status comes from the authenticated
// /me owner response; this helper intentionally does not claim that a syntactically valid sector exists.
function isSupportedFrontierWorldId(value) {
  const match = frontierWorld.exec(value || '');
  if (!match) return false;
  const x = Number(match[1]), y = Number(match[2]);
  return Number.isInteger(x) && Number.isInteger(y) && x >= -8 && x <= 7 && y >= -8 && y <= 7;
}

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
  const pending = new Map(), loginSessions = new Map(), loginAttempts = new Map(), players = new Map(), pairingAttempts = new Map();
  const csrfToken = randomBytes(24).toString('hex');
  async function call(path, token, method = 'GET', payload, key) {
    const response = await fetcher(new URL('/api/v1' + path, localApi), {method, headers: {'Authorization': `Bearer ${token}`, ...(payload ? {'Content-Type': 'application/json', 'Origin': localApi} : {}), ...(key ? {'Idempotency-Key': key} : {})}, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(5000), redirect: 'error'});
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
  async function current(player, pairId) {
    const pair = players.get(player);
    if (!pair || pair.expires <= clock() || typeof pairId !== 'string' || pair.pairId !== pairId) throw Object.assign(new Error('Pair this player again.'), {status: 401});
    const agent = await owner(pair.token, pair.agentId); // checks revocation before every action
    if (players.get(player) !== pair) throw Object.assign(new Error('This pairing was replaced.'), {status: 401});
    if (!isSupportedFrontierWorldId(agent.world_id)) throw Object.assign(new Error('Enter an opened frontier area in NemoWorld first.'), {status: 409});
    return {pair, agent};
  }
  const ownClaim = (claim, pair) => claim?.agent_id === pair.agentId;
  const claimView = claim => claim && ({id:claim.id, task_id:claim.task_id, task_title:claim.task_title, status:claim.status, expires_at:claim.expires_at});
  const submittedBody = input => ({
    claim_id:input.claim_id, artifact:input.artifact.trim(), method:input.method.trim(),
    limitations:input.limitations.trim(), rights:input.rights.trim(),
    sources:input.sources.map(source => ({url:new URL(source.url).href, location:source.location.trim(), date:source.date?.trim() || ''})),
  });
  const sameSubmission = (submission, body) => submission.artifact === body.artifact && submission.method === body.method
    && submission.limitations === body.limitations && submission.rights === body.rights
    && JSON.stringify(submission.sources) === JSON.stringify(body.sources);
  const retryKey = (kind, fields) => `${kind}:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`;
  async function sectorViews(pair, agent) {
    const windows = [];
    for (const y of [0, 14, 28, 34]) for (const x of [0, 20, 28]) windows.push(call(`/world?world_id=${agent.world_id}&agent_id=${pair.agentId}&x=${x}&y=${y}`, pair.token));
    const views = await Promise.all(windows);
    if (!views.every(view => view.frontier && view.world?.id === agent.world_id)) {
      throw Object.assign(new Error('This frontier area is not open in NemoWorld.'), {status: 409});
    }
    const latest = await owner(pair.token, pair.agentId);
    if (!isSupportedFrontierWorldId(latest.world_id)) throw Object.assign(new Error('Human avatar left the opened frontier.'), {status: 409});
    return {views, agent: latest, worldId: agent.world_id};
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
        response.end(`<!doctype html><html><meta charset="utf-8"><meta name="csrf-token" content="${csrfToken}"><title>NemoWorld native pairing</title><style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:1rem;background:#102921;color:#f4eedb}input,select,button{font:inherit;padding:.7rem;display:block;width:100%;box-sizing:border-box;margin:.6rem 0}button{background:#d6b970;border:0;cursor:pointer}code{font-size:1.5rem}</style><h1>Pair a Luanti player</h1><p>Sign in with your NemoWorld operator account. The bridge keeps the session only in memory on this computer and never shows or copies its raw token.</p><form id="login" autocomplete="off"><label>Email<input id="email" type="email" required maxlength="320" autocomplete="username"></label><label>Password<input id="password" type="password" required maxlength="128" autocomplete="current-password"></label><button>Sign in and load human avatars</button></form><form id="pair" autocomplete="off" hidden><label>Active human avatar<select id="agent" required></select></label><button>Create two-minute code</button></form><p id="result" role="status"></p><script>const csrf=document.querySelector('meta[name=csrf-token]').content,headers={'Content-Type':'application/json','X-CSRF-Token':csrf},loginForm=document.querySelector('#login'),pairForm=document.querySelector('#pair'),result=document.querySelector('#result');let loginId;loginForm.onsubmit=async e=>{e.preventDefault();const password=document.querySelector('#password');const r=await fetch('/pair/login',{method:'POST',headers,body:JSON.stringify({email:document.querySelector('#email').value,password:password.value})});password.value='';const b=await r.json();if(!r.ok){result.textContent=b.error;return}loginId=b.login_id;const select=document.querySelector('#agent');select.replaceChildren(...b.agents.map(a=>new Option(a.name+' ('+a.id+')',a.id)));pairForm.hidden=!b.agents.length;result.textContent=b.agents.length?'Choose an active human avatar in an opened frontier area.':'No active human avatar is available in an opened frontier area.'};pairForm.onsubmit=async e=>{e.preventDefault();const r=await fetch('/pair/start',{method:'POST',headers,body:JSON.stringify({login_id:loginId,agent_id:document.querySelector('#agent').value})});const b=await r.json();result.textContent=r.ok?'In Luanti, type /nemo_pair '+b.code:b.error}</script></html>`);
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
        const available = agents.filter(item => item.status === 'active' && isSupportedFrontierWorldId(item.world_id));
        if (!available.length) throw Object.assign(new Error('Move an active human avatar into an opened frontier area, then sign in here again.'), {status: 403});
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
        const attempt = (pairingAttempts.get(input.player) || 0) + 1;
        pairingAttempts.set(input.player, attempt);
        const pair = pending.get(input.code); pending.delete(input.code);
        if (!pair || pair.expires <= clock()) throw Object.assign(new Error('Pair code expired.'), {status: 401});
        const agent = await owner(pair.token, pair.agentId);
        if (pairingAttempts.get(input.player) !== attempt) throw Object.assign(new Error('A newer pairing replaced this request.'), {status: 409});
        if (!isSupportedFrontierWorldId(agent.world_id)) throw Object.assign(new Error('Pair an active human avatar in an opened frontier area.'), {status: 409});
        players.clear(); // one local native player session per bridge instance
        const pairId = randomBytes(16).toString('hex');
        players.set(input.player, {...pair, pairId, expires: Math.min(pair.expires + 18 * 60000, clock() + 20 * 60000)});
        return send(200, {paired: true, pair_id:pairId, world_id: agent.world_id});
      }
      if (url.pathname === '/native/state' && request.method === 'POST') {
        const {pair, agent: initialAgent} = await current(input.player, input.pair_id);
        let result = await sectorViews(pair, initialAgent);
        if (result.agent.world_id !== result.worldId) result = await sectorViews(pair, result.agent);
        if (result.agent.world_id !== result.worldId) throw Object.assign(new Error('Avatar moved while native sector loaded; retry.'), {status: 409});
        const {views, agent} = result;
        const worldId = agent.world_id;
        const blocks = [...new Map(views.flatMap(view => view.blocks).map(block => [`${block.x}:${block.y}:${block.z}`, block])).values()];
        const terrain = [...new Map(views.flatMap(view => (view.terrain || []).flatMap((row, ry) => row.map((type, rx) => ({x:view.camera.x+rx,y:view.camera.y+ry,type})))).map(tile => [`${tile.x}:${tile.y}`,tile])).values()];
        const participants = [...new Map(views.flatMap(view => view.participants || []).filter(item => item.id && item.id !== pair.agentId).map(item => [item.id,{id:item.id,name:item.name,kind:item.kind,x:item.x,y:item.y,z:item.z || 0}])).values()];
        const gates = [...new Map(views.flatMap(view => view.frontier?.neighbors || []).map(gate => [gate.direction, gate])).values()];
        const frontier = views.find(view => view.frontier)?.frontier;
        const creative = {palette:frontier?.palette || [],blueprints:frontier?.blueprints || [],
          parcels:frontier?.parcels || [],my_plot:frontier?.my_plot || null,limits:frontier?.limits || {},
          unlimited_items:true,coin_reward:0};
        return send(200, {world_id: worldId, size: SIZE, blocks, terrain, participants, gates, creative, player: {x: agent.x, y: agent.y, z: agent.z}});
      }
      if (url.pathname === '/native/plot' && request.method === 'POST') {
        const {pair, agent} = await current(input.player, input.pair_id);
        const prefix = agent.world_id.replace('frontier:','plot:') + ':';
        if (typeof input.plot_id !== 'string' || !input.plot_id.startsWith(prefix)) throw Object.assign(new Error('Choose an available plot in your current frontier sector.'),{status:409});
        // The paired human session and existing land authority decide ownership, availability and
        // the one-plot limit. Never accept a caller-supplied account or resident identity.
        const result=await call('/land/assign',pair.token,'POST',{plot_id:input.plot_id,purpose:input.purpose,description:input.description || ''});
        return send(200,{accepted:true,result});
      }
      if (url.pathname === '/native/missions' && request.method === 'POST') {
        // The native client reads the same mission directory and the paired human's own active claim
        // as the browser. No mission or claim store is copied into Luanti; both read one authority.
        const {pair} = await current(input.player, input.pair_id);
        const directory = await call('/missions?limit=12', pair.token);
        return send(200, {
          tasks: (directory.tasks || []).filter(task => task.status === 'open').map(({id, mission_id, title, status, lease_minutes}) => ({id, mission_id, title, status, lease_minutes})),
          active_claim: ownClaim(directory.active_claim, pair) ? claimView(directory.active_claim) : null,
        });
      }
      if (url.pathname === '/native/claim' && request.method === 'POST') {
        const {pair} = await current(input.player, input.pair_id);
        if (typeof input.task_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.task_id)) throw Object.assign(new Error('Choose a listed mission task.'), {status: 400});
        const directory = await call('/missions?limit=12', pair.token);
        if (directory.active_claim) {
          if (!ownClaim(directory.active_claim, pair)) throw Object.assign(new Error('Another avatar on this account has the active claim.'), {status: 409});
          if (directory.active_claim.task_id !== input.task_id) throw Object.assign(new Error('Finish or release your current claim before choosing another task.'), {status: 409});
          return send(200, {claim:claimView(directory.active_claim)});
        }
        // A new lease gets a new key. A released or expired lease must never replay an old row.
        // An uncertain response is resolved by reading the account's active lease on retry.
        const key = `native-claim:${randomBytes(20).toString('hex')}`;
        const claim = await call('/claims', pair.token, 'POST', {task_id: input.task_id, agent_id: pair.agentId}, key);
        return send(200, {claim:claimView(claim)});
      }
      if (url.pathname === '/native/submit' && request.method === 'POST') {
        const {pair} = await current(input.player, input.pair_id);
        const textField = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000;
        if (typeof input.claim_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.claim_id)
          || typeof input.artifact !== 'string' || !input.artifact.trim() || input.artifact.length > 16000
          || !textField(input.method) || !textField(input.limitations) || !textField(input.rights)
          || !Array.isArray(input.sources) || !input.sources.length || input.sources.length > 10
          || input.sources.some(source => !source || typeof source.url !== 'string' || typeof source.location !== 'string'
            || !source.location.trim() || (source.date !== undefined && typeof source.date !== 'string'))) {
          throw Object.assign(new Error('Provide a claim, a deliverable, a method, limitations, rights and one to ten sources.'), {status: 400});
        }
        let body;
        try { body = submittedBody(input); } catch { throw Object.assign(new Error('Source URL is invalid.'), {status: 400}); }
        const [directory, history] = await Promise.all([call('/missions?limit=12', pair.token), call('/history', pair.token)]);
        const active = directory.active_claim;
        if (active && active.id === input.claim_id && !ownClaim(active, pair)) throw Object.assign(new Error('This claim belongs to another avatar.'), {status: 404});
        const historicalClaim = (history.claims || []).find(claim => claim.id === input.claim_id)
          || (active?.id === input.claim_id ? active : null);
        if (!historicalClaim || !ownClaim(historicalClaim, pair)) throw Object.assign(new Error('This paired avatar has no such claim.'), {status: 404});
        const versions = (history.submissions || []).filter(submission => submission.claim_id === input.claim_id);
        const latest = versions.reduce((found, row) => !found || row.version > found.version ? row : found, null);
        if (!active || active.id !== input.claim_id) {
          // The server accepted a prior attempt. Return that exact saved result only for an
          // identical retransmission; a different artifact needs a requested-changes state.
          if (historicalClaim.status === 'submitted' && latest && sameSubmission(latest, body)) return send(200, {submission:{id:latest.id, status:latest.status}});
          throw Object.assign(new Error('Claim is not active for this avatar. Inspect contribution history before retrying.'), {status: 409});
        }
        if (!['leased', 'changes_requested'].includes(active.status)) throw Object.assign(new Error('Claim is not ready for submission.'), {status: 409});
        if (active.status === 'changes_requested' && !latest) throw Object.assign(new Error('Prior version is outside the bounded history. Inspect it before revising.'), {status: 409});
        // The same content at the same version gets the same durable key across bridge restarts.
        // A reviewed revision increments version, so a legitimate second submission is not replayed.
        const version = (latest?.version || 0) + 1;
        const key = retryKey('native-submit', {agent_id:pair.agentId, claim_id:input.claim_id, version, body});
        const submission = await call('/submissions', pair.token, 'POST', body, key);
        return send(200, {submission: {id:submission.id, status:submission.status}});
      }
      if (url.pathname === '/native/messages' && request.method === 'POST') {
        // Older `/world` responses are account-scoped, so an operator with several avatars could
        // see a sibling's private thread. Fail closed until the API explicitly attests that it
        // applied the paired avatar's message scope; mission chatter is not native direct chat.
        const {pair, agent} = await current(input.player, input.pair_id);
        const view = await call(`/world?world_id=${agent.world_id}&agent_id=${pair.agentId}`, pair.token);
        const avatarScoped = view.message_scope_agent_id === pair.agentId;
        const participants = (view.participants || []).filter(item => item.id && item.id !== pair.agentId).map(item => ({id:item.id, name:item.name}));
        const messages = (view.messages || [])
          .filter(message => message.channel === 'public' || avatarScoped && ['private','nearby'].includes(message.channel)
            || message.channel === 'private' && message.agent_id === pair.agentId)
          .slice(-20).map(message => ({id:message.id, channel:message.channel, author:message.author, text:message.text, at:message.created_at, mine:message.agent_id === pair.agentId}));
        return send(200, {world_id: agent.world_id, participants, messages});
      }
      if (url.pathname === '/native/say' && request.method === 'POST') {
        const {pair, agent} = await current(input.player, input.pair_id);
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 500) throw Object.assign(new Error('Type a message under 500 characters.'), {status: 400});
        const payload = {agent_id: pair.agentId, text: input.text.trim(), channel: 'public'};
        if (input.to !== undefined) {
          if (typeof input.to !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.to)) throw Object.assign(new Error('Choose a resident you can see.'), {status: 400});
          // A native client may only address a resident it can see in its own current world.
          const view = await call(`/world?world_id=${agent.world_id}&agent_id=${pair.agentId}`, pair.token);
          if (!(view.participants || []).some(item => item.id === input.to && item.id !== pair.agentId)) throw Object.assign(new Error('That resident is not here.'), {status: 404});
          payload.channel = 'private'; payload.recipient_id = input.to;
        }
        const result = await call('/messages', pair.token, 'POST', payload);
        return send(200, {message: {id: result.id, channel: payload.channel}});
      }
      if (url.pathname === '/native/action' && request.method === 'POST') {
        const {pair, agent} = await current(input.player, input.pair_id);
        const worldId = agent.world_id;
        let path, payload;
        if (input.action === 'move' && ['up','down','left','right'].includes(input.direction)) {
          path = '/move'; payload = {agent_id: pair.agentId, direction: input.direction};
        } else if (input.action === 'blueprint' && typeof input.blueprint === 'string' && /^[a-z0-9_-]{1,80}$/.test(input.blueprint)) {
          path = '/frontier/build'; payload = {agent_id:pair.agentId,world_id:worldId,...nativeToNemo(input.pos),blueprint:input.blueprint,preview:input.preview === true};
        } else if (input.action === 'place' && TYPES.has(input.type)) {
          path = '/frontier/build'; payload = {agent_id: pair.agentId, world_id: worldId, ...nativeToNemo(input.pos), type: input.type};
        } else if (input.action === 'remove') {
          path = '/frontier/build'; payload = {agent_id: pair.agentId, world_id: worldId, ...nativeToNemo(input.pos), remove: true};
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
