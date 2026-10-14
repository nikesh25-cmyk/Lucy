import { createHash } from 'node:crypto';
const reject = (message) => { throw Object.assign(new Error(message), { status: 403 }); };
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
// A socket address that is the local machine: the whole 127.0.0.0/8 range, IPv6 `::1`, and the
// IPv4-mapped forms a dual-stack listener reports. Anything else — including an address the runtime
// did not report — is not loopback.
const loopbackPeer = (request) => {
  const raw = request.socket?.remoteAddress;
  if (typeof raw !== 'string') return false;
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  if (address === '::1') return true;
  const octets = address.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
};

export function hostingConfiguration(environment = process.env) {
  const value = environment.LUCY_PUBLIC_ORIGIN || environment.RENDER_EXTERNAL_URL || '';
  let publicOrigin = null, publicHost = null;
  if (value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('LUCY_PUBLIC_ORIGIN must be a canonical HTTPS origin.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || loopbackHosts.has(url.hostname)) throw new Error('LUCY_PUBLIC_ORIGIN must be a public HTTPS origin without a path or credentials.');
    publicOrigin = url.origin;
    publicHost = url.host;
  }
  const bindHost = environment.LUCY_BIND_HOST || (publicOrigin ? '0.0.0.0' : '127.0.0.1');
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(bindHost)) throw new Error('LUCY_BIND_HOST must be 127.0.0.1, ::1, or 0.0.0.0.');
  if (!publicOrigin && bindHost === '0.0.0.0') throw new Error('Configure LUCY_PUBLIC_ORIGIN before exposing the server.');
  const setupCode = environment.LUCY_SETUP_CODE || null;
  if (setupCode && (typeof setupCode !== 'string' || setupCode.length < 24 || setupCode.length > 256)) throw new Error('LUCY_SETUP_CODE must contain 24–256 characters.');
  return { publicOrigin, publicHost, bindHost, setupCode };
}

export function validateRequestOrigin(request, server, hosting) {
  const rawHost = request.headers.host;
  if (!rawHost || /[\s,@/\\?#%]/.test(rawHost)) reject('A valid Host header is required.');
  let host;
  try { host = new URL(`http://${rawHost}`); } catch { reject('A valid Host header is required.'); }
  if (host.username || host.password || host.pathname !== '/' || host.search || host.hash) reject('A valid Host header is required.');
  const local = loopbackHosts.has(host.hostname) && Number(host.port || 80) === server.address()?.port;
  // The one exception to the public-host rule is the loopback health probe. It is decided by the
  // socket that connected, never by the Host header, because that header is client-supplied: a
  // caller that cannot reach this server over loopback gets no exception, whatever Host it names.
  const internalHealth = request.method === 'GET' && new URL(request.url, 'http://localhost').pathname === '/api/v1/health' && local && loopbackPeer(request);
  let expectedOrigin;
  if (hosting.publicOrigin) {
    if (host.host !== hosting.publicHost && !internalHealth) reject('Host does not match the configured public origin.');
    expectedOrigin = hosting.publicOrigin;
  } else {
    if (!local) reject('This local server requires a loopback Host header matching its port.');
    expectedOrigin = host.origin;
  }
  // Forwarded host and protocol headers never establish trust. HTTPS is defined
  // by the configured origin, even when a TLS proxy connects over HTTP locally.
  if (request.headers.origin && request.headers.origin !== expectedOrigin) reject('Cross-origin requests are rejected.');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !request.headers.origin && !request.headers.authorization && request.headers['x-api-client'] !== 'operator') reject('Browser writes require the same Origin; API clients must identify themselves.');
}

export function createAuthenticationLimiter({ publicMode = false, clock = Date.now } = {}) {
  const windows = new Map(); let active = 0;
  const fail = () => { throw Object.assign(new Error('Too many authentication attempts; wait a minute.'), { status: 429 }); };
  const consume = (key, limit) => {
    const timestamp = clock();
    let entry = windows.get(key);
    if (!entry || timestamp - entry.start >= 60000) {
      if (windows.size >= 10000) {
        for (const [oldKey, old] of windows) if (timestamp - old.start >= 60000) windows.delete(oldKey);
        if (windows.size >= 10000) fail();
      }
      entry = { start: timestamp, count: 0 }; windows.set(key, entry);
    }
    if (++entry.count > limit) fail();
  };
  return {
    begin(peer) {
      consume('global', 300);
      consume(`peer:${peer}`, publicMode ? 120 : 15);
      if (active >= 8) fail();
      active++;
      let finished = false;
      return () => { if (!finished) { active--; finished = true; } };
    },
    account(email) {
      const identity = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : '';
      consume(`account:${createHash('sha256').update(identity).digest('hex')}`, 15);
    },
  };
}
