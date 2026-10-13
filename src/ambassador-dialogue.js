// Build a small, account-scoped transcript for a future ambassador model prompt.
// The caller supplies the database accessor so this helper has no platform or HTTP dependency.

const DEFAULT_MAX_TURNS = 6;
const DEFAULT_MAX_CHARS = 3_000;

const clampInteger = (value, fallback, max) => {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) throw new TypeError('Dialogue bounds are invalid.');
  return number;
};

function redact(value) {
  return String(value ?? '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[redacted email]')
    .replace(/\bhttps?:\/\/[^\s<>'"`]+/giu, '[redacted URL]')
    .replace(/\b(?:\+?\d[\d ().-]{7,}\d)\b/g, '[redacted phone]')
    .replace(/\b(?:bearer\s+|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*[:=]\s*)[^\s,;]+/giu, '[redacted credential]')
    .replace(/\b(?:sk-[a-z0-9_-]+|gh[pousr]_[a-z0-9_-]+|xox[baprs]-[a-z0-9-]+|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+)\b/giu, '[redacted credential]');
}

function turnText(turn) {
  return `User: ${redact(turn.question)}\nAmbassador: ${redact(turn.answer)}`;
}

/**
 * Read recent turns for one signed-in account and one ambassador.
 *
 * The expected accessor is platform-like: `all(sql, ...params) -> rows`.
 * Rows are fetched newest-first with a bound, then returned oldest-first for prompt continuity.
 * The current turn id is excluded because callers normally invoke this after inserting it.
 */
export function buildAmbassadorDialogueContext(db, {
  accountId,
  ambassadorId,
  currentTurnId = '',
  maxTurns = DEFAULT_MAX_TURNS,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  if (!db || typeof db.all !== 'function') throw new TypeError('A database accessor is required.');
  if (!String(accountId || '').trim() || !String(ambassadorId || '').trim()) throw new TypeError('Account and ambassador are required.');
  const turnsLimit = clampInteger(maxTurns, DEFAULT_MAX_TURNS, 50);
  const charsLimit = clampInteger(maxChars, DEFAULT_MAX_CHARS, 20_000);
  if (!turnsLimit || !charsLimit) return { turns: [], text: '', truncated: false };

  const rows = db.all(
    `SELECT id,question,answer,created_at
       FROM ambassador_conversations
      WHERE account_id=? AND ambassador_id=? AND (?='' OR id<>?)
      ORDER BY created_at DESC,id DESC
      LIMIT ?`,
    accountId, ambassadorId, String(currentTurnId || ''), String(currentTurnId || ''), turnsLimit,
  );
  // The query is newest-first so the character budget protects the most recent follow-up.
  const turns = [...(rows || [])].map((row) => ({
    id: row.id,
    created_at: row.created_at,
    question: redact(row.question),
    answer: redact(row.answer),
  }));
  const selectedNewestFirst = [];
  let used = 0;
  let truncated = false;
  for (const turn of turns) {
    const full = turnText(turn);
    const separator = selectedNewestFirst.length ? '\n\n' : '';
    const room = charsLimit - used - separator.length;
    if (room <= 0) { truncated = true; break; }
    if (full.length <= room) {
      selectedNewestFirst.push(turn);
      used += separator.length + full.length;
      continue;
    }
    // Truncate only the newest turn. Once a recent turn is retained, an older turn
    // that does not fit is omitted so it cannot displace the useful follow-up context.
    if (!selectedNewestFirst.length) {
      const clipped = `${full.slice(0, Math.max(0, room - 1))}…`;
      selectedNewestFirst.push({ ...turn, text: clipped });
      used = charsLimit;
    }
    truncated = true;
    break;
  }
  return {
    turns: selectedNewestFirst.reverse().map((turn) => ({ ...turn, text: turn.text || turnText(turn) })),
    text: selectedNewestFirst.map((turn) => turn.text || turnText(turn)).join('\n\n'),
    truncated,
  };
}

export const AMBASSADOR_DIALOGUE_DEFAULTS = Object.freeze({ maxTurns: DEFAULT_MAX_TURNS, maxChars: DEFAULT_MAX_CHARS });
