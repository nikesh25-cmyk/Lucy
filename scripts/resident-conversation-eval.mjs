// Scripted ambassador conversation and message authorization regression harness.
// Evaluates real HTTP routes (POST /api/v1/ambassadors/talk, POST /api/v1/messages)
// against disposable databases and accounts. Without a configured model this does
// not evaluate AI inference or open-ended resident conversation quality.
//
// Separates deterministic policy checks (HTTP status, database persistence,
// channel authorization boundaries, refusal on pause) from narrow answer-text
// regression checks (required or forbidden phrases in the scripted response).

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { Platform } from '../src/platform.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_PATH = join(ROOT, 'tests', 'fixtures', 'resident-conversation-eval.json');

/** Redacts sensitive tokens and credentials from logs and transcripts */
export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/Bearer\s+[a-zA-Z0-9_-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/token=([a-zA-Z0-9_-]+)/gi, 'token=[REDACTED]')
    .replace(/password=([^\s&]+)/gi, 'password=[REDACTED]');
}

export function evaluateResponseQuality(text, criteria = {}) {
  const normalized = (text || '').toLowerCase();
  const violations = [];

  if (Array.isArray(criteria.must_contain)) {
    for (const token of criteria.must_contain) {
      if (!normalized.includes(token.toLowerCase())) {
        violations.push(`Missing required phrase: "${token}"`);
      }
    }
  }

  if (Array.isArray(criteria.must_not_contain)) {
    for (const token of criteria.must_not_contain) {
      if (normalized.includes(token.toLowerCase())) {
        violations.push(`Encountered forbidden phrase: "${token}"`);
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

export async function runEvaluationSuite(options = {}) {
  const rawFixtures = readFileSync(FIXTURE_PATH, 'utf8');
  const fixtureData = JSON.parse(rawFixtures);
  const cases = fixtureData.cases || [];

  let platform = options.platform;
  let server = options.server;
  let appUrl = options.baseUrl;
  let cleanup = null;
  let credentials = options.credentials || {};
  let advanceClock = options.advanceClock;

  // If no external server provided, boot an isolated disposable in-memory/temp database and HTTP server
  if (!appUrl) {
    const tempDir = mkdtempSync(join(tmpdir(), 'nemoworld-eval-'));
    const dbPath = join(tempDir, 'platform.sqlite');
    let currentTime = Date.now();
    platform = new Platform(dbPath, () => currentTime);
    if (!advanceClock) {
      advanceClock = (ms = 2000) => { currentTime += ms; };
    }

    // Seed standard test credentials
    const adminCreds = await platform.register({ name: 'Admin', email: 'admin@example.org', password: 'test-password-2026', consent: true });
    credentials.admin = adminCreds.token;
    const actorAdmin = platform.authenticate(credentials.admin);

    const inviteAlice = platform.transaction(() => platform.invite(actorAdmin, { role: 'member' }));
    const aliceCreds = await platform.register({ name: 'Alice', email: 'alice@example.org', password: 'test-password-2026', consent: true, invite: inviteAlice.code });
    credentials.alice = aliceCreds.token;

    const inviteBob = platform.transaction(() => platform.invite(actorAdmin, { role: 'member' }));
    const bobCreds = await platform.register({ name: 'Bob', email: 'bob@example.org', password: 'test-password-2026', consent: true, invite: inviteBob.code });
    credentials.bob = bobCreds.token;

    const inviteEve = platform.transaction(() => platform.invite(actorAdmin, { role: 'member' }));
    const eveCreds = await platform.register({ name: 'Eve', email: 'eve@example.org', password: 'test-password-2026', consent: true, invite: inviteEve.code });
    credentials.eve = eveCreds.token;

    // Create characters
    const aliceActor = platform.authenticate(credentials.alice);
    const bobActor = platform.authenticate(credentials.bob);
    const eveActor = platform.authenticate(credentials.eve);

    credentials.aliceAgent = platform.transaction(() => platform.createAgent(aliceActor, { name: 'Alice Avatar', capabilities: 'Talk', limitations: 'None', color: '#112233', symbol: 'A' }));
    credentials.bobAgent = platform.transaction(() => platform.createAgent(bobActor, { name: 'Bob Avatar', capabilities: 'Talk', limitations: 'None', color: '#223344', symbol: 'B' }));
    credentials.eveAgent = platform.transaction(() => platform.createAgent(eveActor, { name: 'Eve Avatar', capabilities: 'Spy', limitations: 'None', color: '#334455', symbol: 'E' }));

    const app = createApp({ platform, mayorModel: options.mayorModel || null });
    server = app.server;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    appUrl = `http://127.0.0.1:${port}/api/v1`;

    cleanup = async () => {
      await app.stopWorkers();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      platform.close();
      rmSync(tempDir, { recursive: true, force: true });
    };
  }

  const results = [];
  let passedCount = 0;
  let failedCount = 0;

  try {
    for (const testCase of cases) {
      const caseStartTime = Date.now();
      const policyViolations = [];
      let httpStatus = null;
      let responseBody = null;
      let dbRecord = null;
      let qualityEval = { passed: true, violations: [] };

      // Ensure debounce spacing (server rate-limits messages/talk to 1 per 1500ms per account)
      if (advanceClock) {
        advanceClock(2000);
        await new Promise((r) => setTimeout(r, 10));
      } else {
        await new Promise((r) => setTimeout(r, 1600));
      }

      if (testCase.id === 'private-thread-outsider-refusal') {
        // Deterministic private thread test:
        // 1. Alice sends Bob a private message
        const aliceSendRes = await fetch(`${appUrl}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${credentials.alice}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            agent_id: credentials.aliceAgent.id,
            channel: 'private',
            recipient_id: credentials.bobAgent.id,
            text: 'Alice private communication to Bob.',
          }),
        });

        const aliceSentData = await aliceSendRes.json();
        const privateMsgId = aliceSentData.id;

        // 2. Eve tries to reply to Alice's message using reply_to
        const eveRes = await fetch(`${appUrl}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${credentials.eve}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            agent_id: credentials.eveAgent.id,
            channel: 'private',
            reply_to: privateMsgId,
            text: 'Eve unauthorized reply.',
          }),
        });

        httpStatus = eveRes.status;
        responseBody = await eveRes.json().catch(() => ({}));

        if (httpStatus !== testCase.expected_status) {
          policyViolations.push(`Expected HTTP status ${testCase.expected_status}, received ${httpStatus}`);
        }

        // Verify database: Eve's message was not recorded
        const eveMessages = platform.all("SELECT * FROM messages WHERE agent_id=?", credentials.eveAgent.id);
        if (eveMessages.length > 0) {
          policyViolations.push(`Unauthorized message was stored in database for third party Eve!`);
        }
      } else if (testCase.id === 'resident-unavailable-paused') {
        // 1. Admin pauses ambassador
        await fetch(`${appUrl}/ambassadors/control`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${credentials.admin}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ambassador_id: testCase.ambassador_id,
            status: 'paused',
          }),
        });

        // 2. Member tries to converse with paused ambassador
        const talkRes = await fetch(`${appUrl}/ambassadors/talk`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${credentials.alice}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ambassador_id: testCase.ambassador_id,
            question: testCase.question,
          }),
        });

        httpStatus = talkRes.status;
        responseBody = await talkRes.json().catch(() => ({}));

        if (httpStatus !== testCase.expected_status) {
          policyViolations.push(`Expected HTTP status ${testCase.expected_status}, received ${httpStatus}`);
        }

        // Verify database: no conversation recorded
        const stored = platform.get("SELECT COUNT(*) AS n FROM ambassador_conversations WHERE ambassador_id=? AND question=?", testCase.ambassador_id, testCase.question);
        if (stored.n > 0) {
          policyViolations.push(`Conversation was persisted despite ambassador being paused.`);
        }
      } else {
        // Standard ambassador conversation route test
        const talkRes = await fetch(`${appUrl}/ambassadors/talk`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${credentials.alice}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ambassador_id: testCase.ambassador_id,
            question: testCase.question,
          }),
        });

        httpStatus = talkRes.status;
        responseBody = await talkRes.json().catch(() => ({}));

        if (httpStatus !== testCase.expected_status) {
          policyViolations.push(`Expected HTTP status ${testCase.expected_status}, received ${httpStatus}`);
        }

        if (responseBody?.id) {
          dbRecord = platform.get("SELECT * FROM ambassador_conversations WHERE id=?", responseBody.id);
          if (!dbRecord) {
            policyViolations.push(`Conversation ID ${responseBody.id} acknowledged by HTTP but missing from database!`);
          } else if (dbRecord.question !== testCase.question) {
            policyViolations.push(`Database stored question mismatch.`);
          }
        } else if (testCase.policy_check?.assert_db_row) {
          policyViolations.push(`Response missing conversation ID.`);
        }

        // Response quality / content checks
        if (testCase.response_quality) {
          qualityEval = evaluateResponseQuality(responseBody?.answer || '', testCase.response_quality);
        }
      }

      const casePassed = policyViolations.length === 0 && qualityEval.passed;
      if (casePassed) passedCount++;
      else failedCount++;

      results.push({
        id: testCase.id,
        category: testCase.category,
        passed: casePassed,
        latency_ms: Date.now() - caseStartTime,
        http_status: httpStatus,
        mode: responseBody?.mode || 'n/a',
        model_inference_ran: responseBody?.mode === 'local-model',
        deterministic_policy: {
          passed: policyViolations.length === 0,
          violations: policyViolations,
        },
        response_quality: qualityEval,
        stored_db_row_verified: Boolean(dbRecord),
        redacted_answer_sample: redactSecrets((responseBody?.answer || responseBody?.error || '').slice(0, 200)),
      });
    }
  } finally {
    if (cleanup) await cleanup();
  }

  return {
    timestamp: new Date().toISOString(),
    total: cases.length,
    passed: passedCount,
    failed: failedCount,
    score: `${((passedCount / cases.length) * 100).toFixed(1)}%`,
    cases: results,
  };
}

if (process.argv[1] && process.argv[1].endsWith('resident-conversation-eval.mjs')) {
  console.log('Running NemoWorld scripted ambassador route evaluation (no model inference)...');
  runEvaluationSuite().then((summary) => {
    console.log(`\n===============================================================`);
    console.log(`  Scripted Ambassador Route Evaluation Results`);
    console.log(`  Total Cases: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed} | Score: ${summary.score}`);
    console.log(`===============================================================\n`);
    for (const c of summary.cases) {
      const mark = c.passed ? '✓ PASS' : '✗ FAIL';
      console.log(`[${mark}] ${c.id.padEnd(40)} [HTTP ${c.http_status}] (mode: ${c.mode})`);
      if (!c.passed) {
        if (!c.deterministic_policy.passed) {
          console.log(`       [POLICY VIOLATIONS]: ${c.deterministic_policy.violations.join('; ')}`);
        }
        if (!c.response_quality.passed) {
          console.log(`       [QUALITY VIOLATIONS]: ${c.response_quality.violations.join('; ')}`);
        }
      }
      console.log(`       Excerpt: "${c.redacted_answer_sample}..."\n`);
    }

    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  }).catch((err) => {
    console.error('Fatal evaluation runner error:', err);
    process.exitCode = 1;
  });
}
