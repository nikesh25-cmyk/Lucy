import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAmbassadorDialogueContext } from '../src/ambassador-dialogue.js';

const rows = [
  { id: 'a1', account_id: 'alice', ambassador_id: 'amb-NPL', created_at: '2026-01-01T00:00:01Z', question: 'First', answer: 'One' },
  { id: 'a2', account_id: 'alice', ambassador_id: 'amb-NPL', created_at: '2026-01-01T00:00:02Z', question: 'Second', answer: 'Two' },
  { id: 'a3', account_id: 'alice', ambassador_id: 'amb-NPL', created_at: '2026-01-01T00:00:03Z', question: 'Current', answer: 'Already inserted' },
  { id: 'b1', account_id: 'bob', ambassador_id: 'amb-NPL', created_at: '2026-01-01T00:00:04Z', question: 'Other account', answer: 'Private' },
  { id: 'a4', account_id: 'alice', ambassador_id: 'amb-USA', created_at: '2026-01-01T00:00:05Z', question: 'Other ambassador', answer: 'Other context' },
];

function accessor(calls) {
  return { all(sql, ...args) {
    calls.push({ sql, args });
    const [account, ambassador, current, , limit] = args;
    return rows.filter(row => row.account_id === account && row.ambassador_id === ambassador && (!current || row.id !== current))
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id)).slice(0, limit);
  } };
}

test('scopes to one account and ambassador, excludes current turn, and restores chronology', () => {
  const calls = [], context = buildAmbassadorDialogueContext(accessor(calls), { accountId: 'alice', ambassadorId: 'amb-NPL', currentTurnId: 'a3' });
  assert.deepEqual(context.turns.map(turn => turn.id), ['a1', 'a2']);
  assert.match(context.text, /User: First[\s\S]*User: Second/);
  assert.doesNotMatch(context.text, /Current|Other account|Other context/);
  assert.match(calls[0].sql, /account_id=\?/);
  assert.match(calls[0].sql, /ambassador_id=\?/);
});

test('caps turns and total prompt characters without losing the oldest-to-newest order', () => {
  const calls = [], context = buildAmbassadorDialogueContext(accessor(calls), { accountId: 'alice', ambassadorId: 'amb-NPL', maxTurns: 2, maxChars: 25 });
  assert.equal(calls[0].args.at(-1), 2);
  assert.ok(context.turns.length <= 2);
  assert.ok(context.text.length <= 25);
  assert.equal(context.truncated, true);
});

test('newest turns win the character budget over an oversized old turn', () => {
  const db = { all: () => [
    { id: 'recent', created_at: '2026-01-01T00:00:02Z', question: 'Recent follow-up', answer: 'Keep this context' },
    { id: 'old', created_at: '2026-01-01T00:00:01Z', question: 'Old '.repeat(100), answer: 'Old answer '.repeat(100) },
  ] };
  const context = buildAmbassadorDialogueContext(db, { accountId: 'alice', ambassadorId: 'amb-NPL', maxChars: 80 });
  assert.deepEqual(context.turns.map(turn => turn.id), ['recent']);
  assert.match(context.text, /Recent follow-up/);
  assert.doesNotMatch(context.text, /Old /);
  assert.equal(context.truncated, true);
});

test('redacts obvious contact and credential data in both fields', () => {
  const db = { all: () => [{ id: 'secret', created_at: '2026-01-01', question: 'Email me at person@example.com or https://example.com/a', answer: 'Bearer abc123; phone +1 (555) 123-4567; api_key=sk-live-value' }] };
  const context = buildAmbassadorDialogueContext(db, { accountId: 'alice', ambassadorId: 'amb-NPL' });
  assert.doesNotMatch(context.text, /person@example\.com|https:\/\/example\.com|abc123|555|sk-live-value/);
  assert.match(context.text, /\[redacted email\]/);
  assert.match(context.text, /\[redacted URL\]/);
  assert.match(context.text, /\[redacted credential\]/);
  assert.match(context.text, /\[redacted phone\]/);
});
