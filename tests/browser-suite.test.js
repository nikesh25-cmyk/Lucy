// Pure unit checks for the browser acceptance suite. They cover the rules the suite itself relies on
// before it is allowed to touch a database, and they import the script the same way a developer
// would, so `npm test` keeps passing with no node_modules directory present. Driving a browser is the
// job of `npm run browser`; this file deliberately does not start one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, selectedScenarios, productionDatabaseRefusal, throttleRefusal } from '../scripts/browser-suite.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = join(resolve(tmpdir()), 'nemoworld-browser-unit-fixture');

test('a genuine temporary workspace database is accepted', () => {
  assert.equal(productionDatabaseRefusal(join(workspace, 'world.sqlite'), ROOT, workspace), null);
  assert.equal(productionDatabaseRefusal(join(workspace, 'nested', 'world.sqlite'), ROOT, workspace), null);
});

test('an installed or shared database is refused', () => {
  for (const database of [
    join(ROOT, 'data', 'world.sqlite'),
    join(ROOT, 'outputs', 'Lucy', 'data', 'world.sqlite'),
    join(ROOT, 'backups', 'world.sqlite'),
    join(resolve(tmpdir()), 'another-run', 'world.sqlite'),
    'data/world.sqlite',
  ]) {
    const refusal = productionDatabaseRefusal(database, ROOT, workspace);
    assert.equal(typeof refusal, 'string', `${database} must be refused`);
    assert.ok(refusal.length > 0);
  }
});

test('a workspace that is itself a protected directory is refused', () => {
  const installed = join(ROOT, 'outputs', 'Lucy');
  const refusal = productionDatabaseRefusal(join(installed, 'data', 'world.sqlite'), ROOT, installed);
  assert.match(refusal, /protected directory/);
});

test('a missing database path or workspace is refused rather than guessed', () => {
  assert.match(productionDatabaseRefusal(undefined, ROOT, workspace), /no runtime database path/);
  assert.match(productionDatabaseRefusal('', ROOT, workspace), /no runtime database path/);
  assert.match(productionDatabaseRefusal(join(workspace, 'world.sqlite'), ROOT, ''), /no temporary workspace/);
});

test('the suite runs its scenarios in order, and a focused run keeps only the named ones', () => {
  const all = selectedScenarios();
  assert.deepEqual(all, SCENARIOS.map((scenario) => scenario.id));
  assert.equal(all.length, 24);
  assert.equal(new Set(all).size, 24);
  assert.equal(all[all.length - 1], 'signout-privacy', 'the sign-out scenario stays last');
  for (const scenario of SCENARIOS) {
    assert.equal(typeof scenario.title, 'string');
    assert.ok(scenario.title.length > 0);
  }
  assert.deepEqual(selectedScenarios('first-person-controls , country-ambassadors'), ['first-person-controls', 'country-ambassadors']);
  assert.deepEqual(selectedScenarios('country-ambassadors,first-person-controls'), ['first-person-controls', 'country-ambassadors']);
  assert.deepEqual(selectedScenarios('not-a-scenario'), []);
  assert.deepEqual(selectedScenarios(''), all);
});

test('only the server’s own movement-throttle refusal is recognised, so a walk resumes for that alone', () => {
  assert.equal(throttleRefusal('Move more slowly.'), true);
  assert.equal(throttleRefusal('Travel more slowly.'), true);
  for (const other of [undefined, null, '', 'The path is blocked. Choose another route.', 'No known walkable route to that tile.', 'Walk to a doorway before entering.', 'This garden is private.', 'Allow a moment between building actions.']) {
    assert.equal(throttleRefusal(other), false, `${JSON.stringify(other)} must not be treated as a movement-throttle refusal`);
  }
});

test('every queue-review correction has a named browser regression scenario', () => {
  for (const correction of [1, 2, 3, 4, 5]) {
    const covered = SCENARIOS.filter((scenario) => scenario.regression === `queue review correction ${correction}`);
    assert.ok(covered.length >= 1, `correction ${correction} must be encoded as a browser scenario`);
  }
});
