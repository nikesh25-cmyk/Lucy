import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const FORBIDDEN_WORDS = /\b(kill|fight|attack|slay|weapon|enemy|battle|blood|dungeon|loot|raid|war|steal)(?:s|ed|ing|er|ers)?\b/i;
const LINK_OR_CONTACT = /\b(?:https?:\/\/|www\.)\S*|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const SPEND_MONEY = /\b(?:buy|purchase|spend|pay)\s+(?:coins?|money|tokens?|gold|silver|real)\b/i;

test('villagers: the 24 words residents and every newer one, 6 distinct barks each, no duplicates across village', () => {
  const doc = load('../content/veloren-villagers.json');
  // The words stream wrote the first 24; the people stream scaled the village to 52 (tests/veloren-villagers.test.js).
  // Every resident, old or new, must meet the same bar: 6 distinct barks, none shared with anyone else.
  assert.ok(doc.residents.length >= 24, `${doc.residents.length} residents`);
  assert.equal(doc.residents.length, 52);

  const allBarks = [];
  for (const r of doc.residents) {
    assert.equal(r.barks.length, 6, `${r.id} must have exactly 6 barks`);
    const residentBarks = new Set();

    assert.ok(r.capabilities && r.capabilities.length <= 240, `${r.id} capabilities too long`);
    assert.ok(r.limitations && r.limitations.length <= 240, `${r.id} limitations too long`);
    assert.ok(!r.capabilities.includes('\n'), `${r.id} capabilities must be single-line`);
    assert.ok(!r.limitations.includes('\n'), `${r.id} limitations must be single-line`);

    for (const b of r.barks) {
      assert.ok(b.length >= 10 && b.length <= 160, `bark length invalid: ${b}`);
      assert.ok(!b.includes('\n'), 'bark must be single line');
      assert.ok(!residentBarks.has(b), `duplicate bark within ${r.id}: ${b}`);
      residentBarks.add(b);
      allBarks.push(b);
    }
  }

  assert.equal(allBarks.length, 6 * doc.residents.length);
  assert.ok(allBarks.length >= 144);
  const uniqueBarks = new Set(allBarks);
  assert.equal(uniqueBarks.size, allBarks.length, `all ${allBarks.length} barks must be unique across the entire village`);
  assert.ok(!allBarks.some((b) => b.includes('todo-words')), 'no placeholder barks left');
});

test('library: 10 discoveries, each with 4 research notes (40 total notes)', () => {
  const doc = load('../content/veloren-discoveries.json');
  assert.equal(doc.discoveries.length, 10);

  let totalNotes = 0;
  for (const d of doc.discoveries) {
    assert.ok(d.name && d.hint && d.finding, `${d.id} missing core fields`);
    assert.ok(Array.isArray(d.notes), `${d.id} must have notes array`);
    assert.equal(d.notes.length, 4, `${d.id} must have 4 field notes`);
    for (const n of d.notes) {
      assert.ok(typeof n === 'string' && n.length > 20 && n.length <= 240, `note length invalid: ${n}`);
      totalNotes += 1;
    }
  }
  assert.equal(totalNotes, 40, 'total field notes must be 40');
});

test('research: branching tree with 30 technologies, proper ordering, whitelisted effects', () => {
  const doc = load('../content/harr-research.json');
  assert.ok(doc.techs.length >= 25 && doc.techs.length <= 40, `expected 25-40 techs, got ${doc.techs.length}`);

  const seen = new Set();
  let prevCost = 0;
  for (const t of doc.techs) {
    assert.ok(/^[a-z][a-z0-9-]{1,30}$/.test(t.id), `bad tech id: ${t.id}`);
    assert.ok(!seen.has(t.id), `repeated tech id: ${t.id}`);
    assert.ok(Number.isInteger(t.cost) && t.cost > prevCost, `cost must be strictly increasing: ${t.id}`);
    prevCost = t.cost;

    assert.ok(Array.isArray(t.needs), `${t.id} needs must be array`);
    for (const req of t.needs) {
      assert.ok(seen.has(req), `prerequisite ${req} for ${t.id} must appear earlier in list`);
    }

    assert.ok(t.name.length <= 40, `name too long: ${t.name}`);
    assert.ok(t.text.length <= 200, `text too long: ${t.text}`);

    for (const [k, v] of Object.entries(t.effects || {})) {
      assert.ok(['pantry_rate', 'pantry_cap', 'insight_per_find'].includes(k), `invalid effect key ${k} in ${t.id}`);
      assert.ok(Number.isFinite(v) && v > 0, `invalid effect value ${v} for ${k} in ${t.id}`);
    }

    seen.add(t.id);
  }
});

test('peaceful vocabulary: no violent words, links, contacts or pay-to-win commands', () => {
  const files = [
    '../content/veloren-villagers.json',
    '../content/harr-roles.json',
    '../content/harr-charter.json',
    '../content/harr-research.json',
    '../content/veloren-discoveries.json',
    '../content/veloren-events.json'
  ];

  for (const rel of files) {
    const raw = readFileSync(new URL(rel, import.meta.url), 'utf8');
    const matchForbidden = raw.match(FORBIDDEN_WORDS);
    assert.equal(matchForbidden, null, `Found violent word "${matchForbidden?.[0]}" in ${rel}`);

    const matchLink = raw.match(LINK_OR_CONTACT);
    assert.equal(matchLink, null, `Found link or contact "${matchLink?.[0]}" in ${rel}`);

    const matchSpend = raw.match(SPEND_MONEY);
    assert.equal(matchSpend, null, `Found spending command "${matchSpend?.[0]}" in ${rel}`);
  }
});

test('charter, roles and events structure and tone are kind, concise and valid', () => {
  const charter = load('../content/harr-charter.json');
  assert.equal(charter.format, 'harr-charter-v1');
  assert.ok(charter.purpose && charter.purpose.length > 50);
  assert.equal(charter.principles.length, 6);
  assert.ok(charter.goals.length >= 7);

  const roles = load('../content/harr-roles.json');
  assert.equal(roles.format, 'harr-roles-v1');
  assert.deepEqual(Object.keys(roles.roles).sort(), ['builder', 'courier', 'farmer', 'keeper', 'maker', 'scholar']);

  const events = load('../content/veloren-events.json');
  assert.equal(events.format, 'nemo-village-events-v1');
  assert.equal(events.events.length, 3);
});
