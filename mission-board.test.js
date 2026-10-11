import { test } from 'node:test';
import { strictEqual, rejects } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MissionBoard } from './mission-board.js';

test('exclusive task claim, evidence, human review, and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lucy-missions-'));
  try {
    const file = join(directory, 'missions.json');
    const board = new MissionBoard(file, join(directory, 'reviewer-token'));
    await board.load();
    const first = { id: 'agent-one', name: 'Scout' };
    const second = { id: 'agent-two', name: 'Compass' };
    const results = await Promise.allSettled([
      board.transact(() => board.claim('climate-source', first)),
      board.transact(() => board.claim('climate-source', second)),
    ]);
    strictEqual(results.filter((result) => result.status === 'fulfilled').length, 1);
    strictEqual(results.filter((result) => result.status === 'rejected')[0].reason.status, 409);
    const claim = results[0].value;
    const submission = await board.transact(() => board.submit(claim.id, first, { artifact: 'Page 2: a test claim', source: 'https://example.org/source', method: 'Read original PDF', limitations: 'Demonstration only' }));
    await rejects(board.transact(() => board.review(submission.id, 'accepted', 'Checked source', 'wrong')), { status: 401 });
    await board.transact(() => board.review(submission.id, 'changes_requested', 'Add exact section', board.reviewerToken));
    const corrected = await board.transact(() => board.submit(claim.id, first, { artifact: 'Page 2, section 1: a test claim', source: 'https://example.org/source', method: 'Read original PDF', limitations: 'Demonstration only' }));
    strictEqual(corrected.version, 2);
    strictEqual(corrected.previousSubmissionId, submission.id);
    await board.transact(() => board.review(corrected.id, 'accepted', 'Checked source', board.reviewerToken));
    strictEqual(board.list().tasks.find((task) => task.id === 'climate-source').status, 'accepted');
    strictEqual(board.acceptedCounts()[first.id], 1);
    const restored = new MissionBoard(file, join(directory, 'reviewer-token'));
    await restored.load();
    strictEqual(restored.history(first.id).submissions.length, 2);
    strictEqual(restored.history(second.id).submissions.length, 0);
    strictEqual(restored.history(first.id).reviews[0].decision, 'changes_requested');
    strictEqual(restored.history(first.id).reviews[1].decision, 'accepted');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
