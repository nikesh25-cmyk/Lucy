// Fixture for tests/resident-crash.test.js — not a test itself.
//
// It starts one bounded managed resident in its own operating-system process, receives its own
// credential through the normal endpoint, watches the durable run state it writes, and then kills
// its own process with SIGKILL at a chosen durable state. SIGKILL cannot be caught, so no cleanup,
// receipt or credential revocation runs: the parent test observes exactly what a real crash leaves
// behind and what the next start does with it.
import { Platform } from '../../src/platform.js';
import { createApp } from '../../server.js';

const [database, token, agentId, eventId, mode] = process.argv.slice(2);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let decisions = 0;
// Decision one asks the server to store one RSVP. Every later model call never answers, so the run
// stays inside a real model call until the process dies.
const model = async () => (decisions++ === 0
  ? JSON.stringify({ action: 'rsvp', event_id: eventId, intent: 'join' })
  : new Promise(() => {}));

try {
  const platform = new Platform(database);
  const app = createApp({ platform, mayorModel: model });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${url}/api/v1/residents/run`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, minutes: 5, model_calls: 3, permission: 'creative' }) });
  const started = await response.json();
  if (response.status !== 202) throw new Error(`Resident run was refused: ${response.status} ${JSON.stringify(started)}`);
  console.log(`started ${started.job_id}`);
  for (let attempt = 0; attempt < 6000; attempt++) {
    const run = platform.get('SELECT * FROM resident_runs WHERE id=?', started.job_id);
    const reached = mode === 'confirmed'
      ? run?.phase === 'confirmed' && run.action_count === 1
      : run?.phase === 'model_call' && run.model_calls === 2;
    if (reached) process.kill(process.pid, 'SIGKILL');
    await wait(2);
  }
  throw new Error('The run never reached the chosen durable state.');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
