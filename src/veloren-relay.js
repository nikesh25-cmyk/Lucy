import { closeSync, existsSync, openSync, readSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

// Forwards the Veloren server's signed event outbox to NemoWorld.
//
// Delivery is at-least-once and the effect is exactly-once: the relay remembers how far into the
// outbox it has been acknowledged, resends after any failure, and NemoWorld stores each event id
// once. The relay holds a link credential but never the event key, so it cannot create events.

export const RELAY_BATCH = 20;

function loopbackHttp(url) {
  const host = url.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

export function relayTarget(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHttp(url))) {
    throw new Error('The relay sends its credential only over HTTPS or to a local address.');
  }
  return url;
}

function readOffset(file) {
  if (!existsSync(file)) return 0;
  const value = Number(readFileSync(file, 'utf8').trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function writeOffset(file, value) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${value}\n`);
  renameSync(temporary, file);
}

// Complete lines after `offset` (a partial last line is left for the next pass).
function readLines(outbox, offset) {
  if (!existsSync(outbox)) return { lines: [], size: 0 };
  const size = statSync(outbox).size;
  if (size <= offset) return { lines: [], size };
  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(outbox, 'r');
  try { readSync(fd, buffer, 0, buffer.length, offset); } finally { closeSync(fd); }
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] === 0x0a) {
      lines.push({ text: buffer.subarray(start, index).toString('utf8'), end: offset + index + 1 });
      start = index + 1;
    }
  }
  return { lines, size };
}

/**
 * One pass over the outbox. Returns counters. Throws only for conditions that should stop a
 * one-shot run (a rejected credential); transient failures leave the offset where it was.
 *
 * `resident` names the resident this relay's credential is bound to. When it is set, only that
 * resident's facts are handed in: NemoWorld refuses another resident's event with
 * `resident_out_of_scope` and the refusal is final, so an unfiltered relay running on a credential
 * bound to one resident would advance past - and therefore lose - every other resident's facts.
 * Without `resident` the relay behaves exactly as before (send everything).
 */
export async function relayOnce({ outbox, offsetFile, url, token, resident = null, fetchImpl = globalThis.fetch, log = () => {} }) {
  const target = relayTarget(url);
  const stats = { sent: 0, accepted: 0, duplicate: 0, rejected: 0, malformed: 0, skipped: 0, failed: 0 };
  let offset = readOffset(offsetFile);
  for (;;) {
    const { lines } = readLines(outbox, offset);
    if (!lines.length) return stats;
    const batch = lines.slice(0, RELAY_BATCH);
    const events = [];
    for (const line of batch) {
      try {
        const event = JSON.parse(line.text);
        // Another resident's fact is none of this credential's business, and asking would lose it.
        if (resident && event.resident_id !== resident) { stats.skipped += 1; continue; }
        events.push(event);
      } catch { stats.malformed += 1; log(`skipping a malformed outbox line ending at ${line.end}`); }
    }
    if (events.length) {
      let response;
      try {
        response = await fetchImpl(new URL('/api/v1/veloren/events', target), {
          method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ events }),
        });
      } catch (error) { stats.failed += 1; log(`NemoWorld unreachable: ${error.message}`); return stats; }
      if (response.status === 401 || response.status === 403) { stats.failed += 1; log(`NemoWorld refused the link credential (${response.status}); fix or reissue it`); return stats; }
      if (!response.ok) { stats.failed += 1; log(`NemoWorld answered ${response.status}; will retry`); return stats; }
      const data = await response.json();
      stats.sent += events.length;
      for (const result of data.results || []) {
        stats[result.status] = (stats[result.status] || 0) + 1;
        if (result.status === 'rejected') log(`event ${result.event_id} rejected: ${result.reason}`);
      }
    }
    // Every event in the batch got a definite answer (rejections are final), so move on.
    offset = batch[batch.length - 1].end;
    writeOffset(offsetFile, offset);
  }
}

export async function relayForever({ intervalMs = 1500, maxBackoffMs = 30_000, signal, ...options }) {
  let backoff = intervalMs;
  while (!signal?.aborted) {
    let failed = false;
    try { const stats = await relayOnce(options); failed = stats.failed > 0; } catch (error) { failed = true; options.log?.(error.message); }
    backoff = failed ? Math.min(backoff * 2, maxBackoffMs) : intervalMs;
    await new Promise((resolve) => { const timer = setTimeout(resolve, backoff); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
  }
}
