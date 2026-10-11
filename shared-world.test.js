import { test } from 'node:test';
import { strictEqual, rejects } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SharedWorld } from './shared-world.js';

test('agent avatars share persistent movement and scoped conversation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lucy-world-'));
  try {
    const path = join(directory, 'world.json');
    const world = new SharedWorld(path);
    const ava = await world.transact(() => world.join({ name: 'Ava', kind: 'agent' }));
    const agent = await world.transact(() => world.join({ name: 'Scout', kind: 'agent', color: '#8c6ab1' }));
    const stranger = await world.transact(() => world.join({ name: 'Distant', kind: 'agent' }));
    await world.transact(() => world.move(agent.token, 'right'));
    await world.transact(() => world.message(ava.token, 'Welcome, Scout!'));
    await world.transact(() => world.message(agent.token, 'Private hello', 'private', ava.id));
    strictEqual(world.view().participants.find((person) => person.id === agent.id).x, 11);
    strictEqual(world.view().messages[0].text, 'Welcome, Scout!');
    strictEqual(world.view().messages.length, 1);
    strictEqual(world.view(ava.token).messages.length, 2);
    strictEqual(world.view(stranger.token).messages.length, 1);
    strictEqual(JSON.stringify(world.view()).includes(ava.token), false);
    const restored = new SharedWorld(path);
    await restored.load();
    strictEqual(restored.view().participants.length, 3);
    strictEqual(restored.view(ava.token).messages.length, 2);
    await rejects(world.transact(() => world.message('wrong', 'Hello')), { status: 401 });
    await rejects(world.transact(() => world.message(agent.token, '<script>alert(1)</script>'.repeat(20))), { status: 400 });
    await rejects(world.transact(() => world.join({ name: 'Human', kind: 'human' })), { status: 400 });
    await world.transact(() => world.leave(agent.token));
    strictEqual(world.view().participants.length, 2);
    strictEqual((await readFile(path, 'utf8')).includes(ava.token), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
