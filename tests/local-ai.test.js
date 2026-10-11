import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLlamaModel, createLocalModel } from '../runtime/model.js';
import { startLocalAI } from '../scripts/local-ai.mjs';
import { researchDraft } from '../runtime/research-worker.js';

test('research drafts cannot cite missing or unretrieved source numbers', () => {
  assert.throws(() => researchDraft({ brief: 'An uncited assertion.' }, 2), /cite/);
  assert.throws(() => researchDraft({ brief: 'Invented evidence [Source 3].' }, 2), /cite/);
  assert.throws(() => researchDraft({ brief: 'No evidence [Source 0].' }, 2), /cite/);
  assert.equal(researchDraft({ brief: 'A provisional summary [Source 2]. Applicability needs review.' }, 2), 'A provisional summary [Source 2]. Applicability needs review.');
});

test('llama adapter restricts requests to loopback and rejects incomplete model output', async () => {
  assert.throws(() => createLlamaModel({ url: 'https://example.org' }), /local HTTP/);
  assert.throws(() => createLocalModel({ backend: 'external-provider' }), /local/);
  let request;
  const model = createLlamaModel({ key: 'fixture-only', fetchImpl: async (url, options) => {
    request = { url: String(url), ...options };
    return Response.json({ choices: [{ message: { content: '{"answer":"Human review is required."}' }, finish_reason: 'stop' }] });
  } });
  assert.deepEqual(JSON.parse(await model({ prompt: 'Return an answer.' })), { answer: 'Human review is required.' });
  assert.equal(request.url, 'http://127.0.0.1:11435/v1/chat/completions');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers.Authorization, 'Bearer fixture-only');
  const body = JSON.parse(request.body);
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const truncated = createLlamaModel({ fetchImpl: async () => Response.json({ choices: [{ message: { content: '{"answer":"unfinished' }, finish_reason: 'length' }] }) });
  await assert.rejects(truncated({ prompt: 'Example' }), /incomplete/);
  await assert.rejects(model({ prompt: 'x'.repeat(24001) }), /limit/);
});

test('local AI startup skips missing installations and refuses forged install receipts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lucy-ai-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await startLocalAI(root), null);
  await mkdir(join(root, '.runtime', 'ai'), { recursive: true });
  await writeFile(join(root, '.runtime', 'ai', 'verified.json'), '{}');
  await assert.rejects(startLocalAI(root), /receipt|Apple Silicon/);
});
