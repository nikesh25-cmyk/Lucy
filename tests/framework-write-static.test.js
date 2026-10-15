// Static assertions over `server.js` and the schema: the declarations the router carries are all
// reachable, `publicRoute` is a subset of the declared read routes, the contract in
// `src/framework/write-contract.js` matches the router's own literals exactly, and the schema version
// a fresh database reports is the number the operations rehearsal and the recovery tests assume.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writesFixture } from './framework/writes-harness.js';
import { WRITE_ROUTES, SCOPES, POLICY_FIELDS, CONTRACT_BASE_COMMIT, policyFor } from '../src/framework/write-contract.js';

const root = new URL('..', import.meta.url).pathname;
const source = await readFile(join(root, 'server.js'), 'utf8');
const literals = (text, pattern) => [...text.matchAll(pattern)].map((match) => match[1]);
const WRITES = [...source.match(/const writes = new Map\(\[([\s\S]*?)\n\]\);?/)[1].matchAll(/\['([^']+)',\s*\[([^,\]]+),\s*([^\]]+)\]\]/g)].map((match) => ({ route: match[1], method: match[2].trim().replaceAll("'", ''), scope: match[3].trim() === 'null' ? null : match[3].trim().replaceAll("'", '') }));
const GETS = literals(source.match(/const gets = new Set\(\[([\s\S]*?)\]\);/)[1], /'([^']+)'/g);
const PUBLIC = literals(source.match(/const publicRoute = \[([\s\S]*?)\]\.includes\(route\)/)[1], /'([^']+)'/g);
const SPECIAL = literals(source.match(/const specialWrite = \[([^\]]*)\]\.includes\(route\)/)[1], /'([^']+)'/g);
const DYNAMIC = source.match(/\/\^\\\/agents\\\/\(\[\^\/\]\+\)\\\/\(([^)]+)\)\$\//)[1].split('|');
const DYNAMIC_SCOPES = Object.fromEntries([...source.match(/scope: \{ ([^}]+) \}\[match\[2\]\]/)[1].matchAll(/(\w+): (?:'(\w+)'|null)/g)].map((match) => [match[1], match[2] || null]));
// How the handler reaches a route: an explicit comparison in the request handler, or the fall-through
// that resolves the declared platform method by name.
const explicitlyHandled = (route) => new RegExp(`route\\s*===\\s*'${route.replaceAll('/', '\\/')}'`).test(source) || new RegExp(`route\\s*===\\s*'${route.replaceAll('/', '\\/')}'`).test(source.replaceAll(' ', ''));
const methodIsLive = (platform, name) => typeof platform[name] === 'function';

test('every literal in the gets, writes and publicRoute declarations is reachable by the handler', async (t) => {
  const f = await writesFixture(t);
  const failures = [];
  for (const entry of WRITES) {
    if (!explicitlyHandled(entry.route) && !methodIsLive(f.platform, entry.method)) failures.push(`writes ${entry.route} → no handler branch and no platform.${entry.method}`);
  }
  for (const route of GETS) {
    if (!explicitlyHandled(route) && !methodIsLive(f.platform, route.slice(1))) failures.push(`gets ${route} → no handler branch and no platform.${route.slice(1)}`);
  }
  for (const route of SPECIAL) if (!explicitlyHandled(route)) failures.push(`specialWrite ${route} → no handler branch`);
  for (const action of DYNAMIC) {
    const method = { travel: 'travel', build: 'build', home: 'homeSettings', heartbeat: 'heartbeat', posture: 'posture', look: 'lookAgent', climb: 'climbAgent' }[action];
    if (!methodIsLive(f.platform, method)) failures.push(`dynamic ${action} → no platform.${method}`);
    if (!(action in DYNAMIC_SCOPES)) failures.push(`dynamic ${action} → no scope entry`);
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('publicRoute is a subset of the declared GET routes, and the contract matches the router', async (t) => {
  const f = await writesFixture(t);
  const outside = PUBLIC.filter((route) => !GETS.includes(route));
  assert.deepEqual(outside, [], `publicRoute entries that are not declared reads: ${outside.join(', ')}`);

  const declared = new Set([
    ...WRITES.map((entry) => `POST ${entry.route}`),
    ...DYNAMIC.map((action) => `${action === 'home' ? 'PATCH' : 'POST'} /agents/:id/${action}`),
    ...SPECIAL.map((route) => `POST ${route}`),
    'DELETE /me',
  ]);
  const contracted = new Set(WRITE_ROUTES.map((entry) => `${entry.method} ${entry.route}`));
  assert.deepEqual([...declared].filter((key) => !contracted.has(key)).sort(), [], 'declared writes missing from the contract');
  assert.deepEqual([...contracted].filter((key) => !declared.has(key)).sort(), [], 'contract entries the router does not declare');
  assert.equal(contracted.size, WRITE_ROUTES.length, 'each write route is declared once');

  // Scope and actor fields must agree with the router's own declarations rather than repeat them.
  for (const entry of WRITE_ROUTES) {
    const declaredScope = entry.route.startsWith('/agents/') ? DYNAMIC_SCOPES[entry.route.split('/').at(-1)] : WRITES.find((item) => item.route === entry.route)?.scope;
    assert.equal(entry.scope, declaredScope === undefined ? null : declaredScope, `${entry.route} scope must be the router's scope`);
    for (const field of POLICY_FIELDS) assert.ok(field in entry, `${entry.route} is missing the declared policy field ${field}`);
    assert.ok(entry.scope === null || SCOPES.includes(entry.scope), `${entry.route} declares an unknown scope ${entry.scope}`);
    assert.equal(entry.operator_only, entry.route === '/agents/:id/home' || (entry.scope === null && !entry.public), `${entry.route} operator_only must follow the runtime refusal`);
    assert.equal(entry.runtime, entry.scope !== null && !entry.operator_only, `${entry.route} runtime reachability must follow its scope and operator gate`);
    assert.equal(entry.session, !entry.public, `${entry.route} session reachability must follow its public flag`);
    assert.equal(entry.durable_before_response, true, `${entry.route} must answer only after its effect is committed`);
    if (entry.read_scope_write) assert.equal(entry.scope, 'read', `${entry.route} is not a read-scope write`);
  }
  assert.equal(CONTRACT_BASE_COMMIT, '27c0d72');
  assert.equal(policyFor('/move', 'POST').scope, 'move');
  assert.equal(policyFor('/move', 'GET'), undefined);
});

test('a fresh database reports the schema version the rehearsal and recovery tests assume', async (t) => {
  const f = await writesFixture(t);
  const fresh = f.platform.get('PRAGMA user_version').user_version;
  const database = await readFile(join(root, 'src/database.js'), 'utf8');
  const pragma = [...database.matchAll(/PRAGMA user_version=(\d+)/g)].map((match) => Number(match[1]));
  const recovery = await readFile(join(root, 'src/recovery.js'), 'utf8');
  const declared = [...recovery.matchAll(/schema_version:\s*(\d+)/g)].map((match) => Number(match[1]));
  const accepted = [...recovery.match(/accepted_schema_versions: Object\.freeze\(\[([^\]]+)\]\)/)[1].matchAll(/\d+/g)].map((match) => Number(match[0]));
  const rehearsal = await readFile(join(root, 'scripts/ops-rehearsal.mjs'), 'utf8');
  const recoveryTest = await readFile(join(root, 'tests/recovery.test.js'), 'utf8');
  const assumed = [...rehearsal.matchAll(/schema_version === (\d+)/g), ...recoveryTest.matchAll(/schema_version === (\d+)/g)].map((match) => Number(match[1]));

  assert.ok(pragma.length, 'database.js must state the schema number it migrates to');
  assert.equal(Math.max(...pragma), fresh, 'the fresh database must report the version database.js sets');
  assert.equal(Math.max(...declared), fresh, 'the current schema number in recovery.js must be the fresh one');
  assert.equal(Math.max(...accepted), fresh, 'the newest accepted schema version must be the current one');
  assert.equal(Math.max(...assumed), fresh, 'the rehearsal and the recovery tests must assume the current schema');
  assert.ok(assumed.every((version) => accepted.includes(version)), `the rehearsal assumes a schema version recovery.js does not accept: ${assumed.filter((version) => !accepted.includes(version))}`);
  assert.ok(pragma.includes(fresh) && declared.includes(fresh) && assumed.includes(fresh), 'the current number must appear in every place that states it');
});
