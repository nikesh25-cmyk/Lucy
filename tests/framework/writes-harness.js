// A real-server harness for the write-contract tests. It is deliberately not named `*.test.js`:
// `node --test` must not discover it, because it exports fixtures rather than asserting anything by
// itself. Every test under `tests/framework-*.test.js` imports it, so all of them drive one server
// over real HTTP against a disposable temp database (the `tests/helpers.js` pattern) rather than
// calling platform methods directly.
import { join } from 'node:path';
import { createApp } from '../../server.js';
import { fixture, realMission, evidence, PASSWORD } from '../helpers.js';

export { PASSWORD, evidence, realMission };

export const ok = (condition, message) => { if (!condition) throw new Error(message); };

// The operator session kinds the contract names, plus the runtime credentials it distinguishes.
export const RUNTIME_SCOPES = Object.freeze({
  read: ['read'],
  move: ['read', 'move'],
  chat: ['read', 'chat'],
  contribute: ['read', 'contribute'],
  build: ['read', 'move', 'build'],
  vault: ['read', 'vault'],
  every: ['read', 'move', 'chat', 'contribute', 'build', 'vault'],
});

export async function writesFixture(t, { accounts = ['admin', 'alice', 'bob', 'reviewer', 'moderator'] } = {}) {
  const f = await fixture(t);
  const { server, platform } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const request = async (route, { method = 'POST', account, token, input, key, client = 'operator', cookie } = {}) => {
    const credential = token || (account ? f.credentials[account].token : null);
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(client ? { 'X-API-Client': client } : {}),
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    const raw = await response.text();
    return { status: response.status, headers: response.headers, raw, data: raw ? JSON.parse(raw) : null };
  };
  // One credential per scope set, so a route's own charge cannot starve another route's request.
  const runtime = {};
  for (const [name, scopes] of Object.entries(RUNTIME_SCOPES)) runtime[name] = null;
  const session = { accounts, platform, server, base, request, runtime, password: PASSWORD };
  return Object.assign(f, session, {
    withRuntime(name, agent, scopes = RUNTIME_SCOPES[name]) {
      runtime[name] = f.tx('runtime', f.actor('alice'), agent.id, { scopes, max_calls: 500, minutes: 20 });
      return runtime[name].token;
    },
  });
}
