import test from 'node:test';
import { LIVING_ROSTER } from '../src/living-world.js';
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Harr is a peaceful world: no string a player reads there may carry combat vocabulary. `note` fields are
// metadata (they explain the peace policy, often by naming what is absent), so they are skipped; every other
// string in the content the NemoWorld server hands to the game is checked. The allow-list holds harmless
// compounds a word-boundary match would otherwise catch (there are none today, but `words` may need one).

const here = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(here, '..', 'content');

const BANNED = [
  'kill', 'fight', 'attack', 'slay', 'weapon', 'enemy', 'battle',
  'blood', 'dungeon', 'loot', 'raid', 'war', 'steal',
];

function jsonFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.json')) out.push(path);
    }
  };
  walk(root);
  return out;
}

function walk(value, where, key = '') {
  if (typeof value === 'string') {
    if (key !== 'note') {
      const words = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      for (const banned of BANNED) {
        if (words.includes(banned)) {
          assert.fail(`${where}: "${value}" contains the violent word "${banned}"`);
        }
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => walk(item, where, key));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      walk(v, where, k === 'note' ? 'note' : k);
    }
  }
}

test('every Harr content string a player reads is free of violent vocabulary', () => {
  const files = jsonFiles(CONTENT);
  walk(LIVING_ROSTER, 'src/living-world.js:LIVING_ROSTER');
  assert.ok(files.length > 10, 'the content directory has files to check');
  for (const file of files) {
    const rel = relative(join(here, '..'), file).split(sep).join('/');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    walk(doc, rel);
  }
});
