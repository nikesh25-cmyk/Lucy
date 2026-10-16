// The evidence generator behind `src/framework/write-contract.js` and the framework tests: it drives
// every declared write route over real HTTP against a disposable database and prints, per route, the
// status, the audit entries the write produced and whether the durable effect check passed.
//
//   export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
//   node tests/framework/probe.mjs            # all exercised routes
//   node tests/framework/probe.mjs /trade/*   # only routes whose path matches a substring
//
// It is deliberately not named `*.test.js`, so `node --test` never discovered and never runs it.
import { writesFixture, RUNTIME_SCOPES } from './writes-harness.js';
import { prepare, WRITE_EXERCISES, BLOCKED_EXERCISES, orderedExercises } from './writes-table.js';

const filter = process.argv[2] || '';
const teardowns = [];
const t = { after: (fn) => teardowns.push(fn), }
const f = await writesFixture(t);
const context = await prepare(f);
const audit = (from) => f.platform.all('SELECT seq,actor,event FROM audit WHERE seq>? ORDER BY seq', from);
const maxSeq = () => f.platform.get('SELECT COALESCE(MAX(seq),0) AS n FROM audit').n;
const agentOf = (name) => context.residents[name].id;

let pass = 0, fail = 0;
for (const exercise of orderedExercises()) {
  if (filter && !exercise.route.includes(filter) && !`${exercise.route} ${exercise.as}`.includes(filter)) continue;
  const token = RUNTIME_SCOPES[exercise.as] ? context.runtimes[exercise.as] : undefined;
  const account = token ? undefined : exercise.as;
  const input = typeof exercise.input === 'function' ? exercise.input(context) : exercise.input;
  const route = exercise.route.replace(':id', exercise.id ? exercise.id(context) : agentOf(exercise.as in RUNTIME_SCOPES ? exercise.as : 'move'));
  const before = maxSeq();
  let result;
  if (exercise.advance) f.advance(exercise.advance);
  if (exercise.before) exercise.before(f, context);
  try {
    result = await f.request(route, { method: exercise.method, account, token, input, key: exercise.key });
  } catch (error) {
    console.log(`${exercise.route.padEnd(28)} ${exercise.method.padEnd(6)} THREW      ${error.message}`);
    fail += 1;
    continue;
  }
  const events = audit(before).map((entry) => `${entry.event}<${entry.actor === (f.actor('alice').account.id) ? 'alice' : entry.actor === (f.actor('admin').account.id) ? 'admin' : entry.actor}>`);
  let effect = 'not checked';
  if (result.status >= 200 && result.status < 300) {
    try { exercise.effect(f, result, context); effect = 'ok'; pass += 1; } catch (error) { effect = `FAIL ${error.message}`; fail += 1; }
  } else {
    effect = `status ${result.status}: ${JSON.stringify(result.data).slice(0, 160)}`;
    fail += 1;
  }
  console.log(`${exercise.route.padEnd(28)} ${exercise.method.padEnd(6)} ${String(result.status).padEnd(4)} ${(events.join(',') || '-').padEnd(40)} ${effect}`);
}
console.log(`\nexercised ${pass + fail}: ${pass} ok, ${fail} not ok`);
console.log(`blocked (not exercised): ${Object.keys(BLOCKED_EXERCISES).length} routes`);
for (const fn of teardowns.reverse()) await fn();
process.exit(0);
