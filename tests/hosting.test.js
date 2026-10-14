import test from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { Platform } from '../src/platform.js';
import { createApp } from '../server.js';
import { hostingConfiguration, validateRequestOrigin, createAuthenticationLimiter } from '../src/hosting.js';

const ORIGIN = 'https://world.example.test';
const CODE = 'private-test-setup-code-2026-abcdef';
const registration = (changes = {}) => ({ name: 'Owner', email: 'owner@example.test', password: 'hosting-test-password', consent: true, ...changes });

async function hostingFixture(t, { populated = false, setupCode = CODE } = {}) {
  const platform = new Platform(':memory:');
  if (populated) await platform.register(registration());
  const { server } = createApp({ platform, publicOrigin: ORIGIN, setupCode });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(() => { platform.close(); resolve(); }); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { method = 'GET', input, headers = {}, host = 'world.example.test' } = {}) => {
    return new Promise((resolve, reject) => {
      const request = httpRequest(`${base}/api/v1${route}`, {
        method,
        headers: { Host: host, ...(input ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {}), ...headers },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode, headers: new Headers(response.headers), raw, data: raw ? JSON.parse(raw) : null });
        });
      });
      request.on('error', reject);
      request.end(input ? JSON.stringify(input) : undefined);
    });
  };
  return { platform, server, base, request };
}

test('public hosting configuration requires one precise HTTPS origin', () => {
  assert.equal(hostingConfiguration({ RENDER_EXTERNAL_URL: ORIGIN }).publicOrigin, ORIGIN);
  assert.equal(hostingConfiguration({ LUCY_PUBLIC_ORIGIN: ORIGIN, RENDER_EXTERNAL_URL: 'https://ignored.example' }).publicOrigin, ORIGIN);
  assert.equal(hostingConfiguration({}).bindHost, '127.0.0.1');
  assert.equal(hostingConfiguration({ LUCY_PUBLIC_ORIGIN: ORIGIN }).bindHost, '0.0.0.0');
  for (const invalid of ['http://world.example.test', 'https://world.example.test/path', 'https://owner:password@world.example.test', 'https://world.example.test?token=secret', 'https://localhost']) {
    assert.throws(() => hostingConfiguration({ LUCY_PUBLIC_ORIGIN: invalid }), /HTTPS origin/);
  }
  assert.throws(() => hostingConfiguration({ LUCY_BIND_HOST: '0.0.0.0' }), /Configure/);
  assert.throws(() => hostingConfiguration({ LUCY_SETUP_CODE: 'short' }), /24/);
  const empty = new Platform(':memory:');
  try { assert.throws(() => createApp({ platform: empty, publicOrigin: ORIGIN, setupCode: '' }), /private LUCY_SETUP_CODE/); }
  finally { empty.close(); }
});

test('public bootstrap protects the first administrator and sets secure proxy cookies', async (t) => {
  const f = await hostingFixture(t);
  const bootstrap = await f.request('/bootstrap');
  assert.deepEqual(bootstrap.data, { setup_required: true, setup_code_required: true,registration_open:true,registration:{mode:'open',public_signup:false,first_admin_required:true} });
  assert.equal(bootstrap.raw.includes(CODE), false);
  assert.equal((await f.request('/auth/register', { method: 'POST', input: registration() })).status, 403);
  assert.equal((await f.request('/auth/register', { method: 'POST', input: registration({ setup_code: 'wrong-code' }) })).status, 403);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM accounts').n, 0);
  const registered = await f.request('/auth/register', { method: 'POST', input: registration({ setup_code: CODE }) });
  assert.equal(registered.status, 201);
  assert.equal(registered.data.account.role, 'admin');
  assert.equal(registered.data.token, undefined);
  assert.match(registered.headers.get('set-cookie'), /; Secure;/);
  assert.match(registered.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(registered.headers.get('strict-transport-security'), 'max-age=31536000');
  const cookie = registered.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('/me', { headers: { Cookie: cookie } })).data.account.email, 'owner@example.test');
  assert.deepEqual((await f.request('/bootstrap')).data, { setup_required: false, setup_code_required: false,registration_open:true,registration:{mode:'open',public_signup:true,first_admin_required:false} });
  const member=await f.request('/auth/register', { method: 'POST', input: registration({ email: 'stranger@example.test', setup_code: CODE,role:'admin' }) });assert.equal(member.status,201);assert.equal(member.data.account.role,'member');
});

test('public Host and Origin checks ignore forwarded headers while allowing internal health checks', async (t) => {
  const f = await hostingFixture(t, { populated: true, setupCode: '' });
  assert.equal((await f.request('/world', { host: 'evil.example', headers: { 'X-Forwarded-Host': 'world.example.test', 'X-Forwarded-Proto': 'https' } })).status, 403);
  assert.equal((await f.request('/world', { host: 'world.example.test:8443' })).status, 403);
  assert.equal((await f.request('/world', { headers: { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'http' } })).status, 200);
  assert.equal((await f.request('/auth/login', { method: 'POST', input: registration(), headers: { Origin: 'http://world.example.test', 'X-Forwarded-Proto': 'https' } })).status, 403);
  assert.equal((await f.request('/auth/login', { method: 'POST', input: registration(), headers: { Origin: 'https://evil.example' } })).status, 403);
  const localHost = `127.0.0.1:${f.server.address().port}`;
  assert.equal((await f.request('/health', { host: localHost })).status, 200);
  assert.equal((await f.request('/bootstrap', { host: localHost })).status, 403);
  assert.equal((await f.request('/health', { host: '127.0.0.1:1' })).status, 403);
  const scriptLogin = await f.request('/auth/login', { method: 'POST', input: registration(), headers: { Origin: '', 'X-API-Client': 'operator' } });
  assert.equal(scriptLogin.status, 200);
  assert.equal(typeof scriptLogin.data.token, 'string');
  assert.equal((await f.request('/me', { headers: { Authorization: `Bearer ${scriptLogin.data.token}` } })).status, 200);
});

test('competing public setup requests cannot create two administrators', async (t) => {
  const f = await hostingFixture(t);
  const results = await Promise.all(['first@example.test', 'second@example.test'].map((email) => f.request('/auth/register', { method: 'POST', input: registration({ email, setup_code: CODE }) })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201,201]);assert.deepEqual(results.map(r=>r.data.account.role).sort(),['admin','member']);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM accounts WHERE role='admin'").n, 1);
});

test('authentication limits allow distinct proxy users and bound account attempts and concurrency', () => {
  let time = 0;
  const limiter = createAuthenticationLimiter({ publicMode: true, clock: () => time });
  for (let index = 0; index < 20; index++) {
    const end = limiter.begin('shared-router');
    limiter.account(`person-${index}@example.test`); end();
  }
  for (let index = 0; index < 15; index++) limiter.account('target@example.test');
  assert.throws(() => limiter.account(' TARGET@example.test '), { status: 429 });
  const active = Array.from({ length: 8 }, () => limiter.begin('shared-router'));
  assert.throws(() => limiter.begin('shared-router'), { status: 429 });
  active.forEach((end) => end());
  time += 60000;
  assert.doesNotThrow(() => limiter.account('target@example.test'));
  const local = createAuthenticationLimiter();
  for (let index = 0; index < 15; index++) local.begin('localhost')();
  assert.throws(() => local.begin('localhost'), { status: 429 });
});

test('the loopback health exception requires a loopback peer, not only a loopback Host header', () => {
  const server = { address: () => ({ port: 8443 }) };
  const hosting = { publicOrigin: ORIGIN, publicHost: 'world.example.test' };
  const sent = (host, { path = '/api/v1/health', method = 'GET', remoteAddress, headers = {} } = {}) => ({ method, url: path, headers: { host, ...headers }, socket: { remoteAddress } });
  // The exception stands in for the public-host rule, so it is decided by the socket that connected.
  // A client-supplied Host header never substitutes for the peer: a caller that cannot reach the
  // server over loopback is refused, whatever Host it names.
  for (const host of ['127.0.0.1:8443', 'localhost:8443', '[::1]:8443']) {
    assert.throws(() => validateRequestOrigin(sent(host, { remoteAddress: '203.0.113.7' }), server, hosting), { status: 403 });
    assert.throws(() => validateRequestOrigin(sent(host, { remoteAddress: '10.0.0.5' }), server, hosting), { status: 403 });
  }
  // A socket that reports no peer address is not trusted either.
  assert.throws(() => validateRequestOrigin(sent('127.0.0.1:8443', { remoteAddress: undefined }), server, hosting), { status: 403 });
  // The loopback probe the exception exists for, and every IPv4-mapped form of it, still works.
  for (const remoteAddress of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
    assert.doesNotThrow(() => validateRequestOrigin(sent('127.0.0.1:8443', { remoteAddress }), server, hosting));
  }
  // The exception never widens the path or the method: every other route still needs the public host.
  assert.throws(() => validateRequestOrigin(sent('127.0.0.1:8443', { path: '/api/v1/world', remoteAddress: '127.0.0.1' }), server, hosting), { status: 403 });
  assert.throws(() => validateRequestOrigin(sent('127.0.0.1:8443', { path: '/api/v1/health', method: 'POST', remoteAddress: '127.0.0.1', headers: { origin: ORIGIN } }), server, hosting), { status: 403 });
  // A caller presenting the configured public host is unaffected from any peer.
  assert.doesNotThrow(() => validateRequestOrigin(sent('world.example.test', { path: '/api/v1/world', remoteAddress: '203.0.113.7' }), server, hosting));
});
