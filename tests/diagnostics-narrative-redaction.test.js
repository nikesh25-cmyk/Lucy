import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { redactDiagnostics } from '../src/recovery.js';

test('diagnostics withholds detail, summary and receipt narrative while retaining numeric counters', () => {
  const marker = 'PRIVATE-NARRATIVE-THAT-LOOKS-LIKE-NO-CREDENTIAL';
  const result = redactDiagnostics({ detail: marker, details: [marker], summary: marker, summaries: { note: marker }, receipt: marker, receipts: [{ note: marker }], worker_detail: marker, details_count: 7, failed_receipts: 3, details_total: 8, detail_number: 9, source_id: 'saved-row-1', details_processed: true });
  assert.equal(JSON.stringify(result).includes(marker), false);
  for (const field of ['detail', 'details', 'summary', 'summaries', 'receipt', 'receipts', 'worker_detail']) assert.equal(result[field], '[redacted-field]');
  assert.equal(result.failed_receipts, 3, 'a counter is retained even when its name mentions a receipt');
  assert.equal(result.details_count, 7);
  assert.equal(result.source_id, 'saved-row-1');
});

test('a runtime-authored run summary cannot publish private narrative on administrator operations', async (t) => {
  const f = await fixture(t), resident = f.agent('alice');
  const token = f.tx('runtime', f.actor('alice'), resident.id, { scopes: ['read', 'contribute'], max_calls: 10, minutes: 5 });
  const actor = f.platform.authenticate(token.token, 'contribute');
  const marker = 'RUNTIME-PRIVATE-JOURNAL-MARKER-UNCHANGED-BY-SHAPE-SCRUBBING';
  const job = f.tx('job', actor, { agent_id: resident.id, status: 'completed', detail: marker });
  assert.equal(f.platform.get('SELECT detail FROM jobs WHERE id=?', job.id).detail, marker, 'the operator record retains the actual summary');
  const view = f.platform.operations(f.actor('admin'));
  assert.equal(JSON.stringify(view).includes(marker), false);
  assert.equal(view.jobs.find((row) => row.id === job.id).detail, '[redacted-field]');
  assert.equal(view.jobs.find((row) => row.id === job.id).status, 'completed');
});
