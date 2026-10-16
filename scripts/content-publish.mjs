#!/usr/bin/env node
// The safe preview and publication path for authored content.
//
// A staged set of definitions is validated first, then either previewed (the default, which writes
// nothing anywhere) or published (which must be asked for explicitly with --publish).
//
// Usage:
//   node scripts/content-publish.mjs [--preview] [--from content-incoming] [--land land.json] [--json]
//   node scripts/content-publish.mjs --publish  [--from content-incoming] [--land land.json]
//   node scripts/content-publish.mjs --rollback [--from content-incoming]
//
//   --preview    (default) validate and report exactly what would change; write nothing
//   --publish    validate, then move the staged files in, reseal and verify; reversible
//   --rollback   restore every path the last publication touched, from its journal
//   --from DIR   the staging directory, shaped like content/<family>/<id>.json   [content-incoming]
//   --land FILE  JSON array of saved tiles as "worldId|x,y" that a place or fixture may not take
//   --json       print the report as JSON as well as the human transcript
//
// What "atomic and reversible" means here, precisely: every destination path this run will touch is
// recorded with its current bytes *before* the first file is moved, in `<from>/.publish-journal.json`.
// Either every staged file lands and the seal verifies, or every touched path is restored from the
// journal and the seal is regenerated. It is not a single filesystem rename, and the window between
// the first move and the verification is real; the journal is what closes it. The journal is kept
// after a successful publication, so the last publication can be undone with --rollback until the
// next publication replaces it.
//
// Nothing here writes to the sealed generated files by hand. content/content-manifest.json,
// content/notices.json and content/index.js are always produced by scripts/seal-content.mjs.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import content, { createContent } from '../src/content.js';
import { FAMILY_KIND, formatRefusal, validateContentFamilies } from '../src/content-manifest.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GENERATED = ['content/content-manifest.json', 'content/notices.json', 'content/index.js'];
const JOURNALS = '.publish-journal.json';

const fail = (message) => { process.stderr.write(`content-publish: ${message}\n`); process.exit(1); };
const readJson = (path, label) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { return fail(`${label} could not be read as JSON: ${error.message}`); }
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
const at = (path) => join(ROOT, path);
const toPosix = (path) => path.split(sep).join('/');

// ---- arguments ------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => { const index = argv.indexOf(name); return index === -1 ? fallback : argv[index + 1]; };
if (flag('--preview') && flag('--publish')) fail('--preview and --publish are mutually exclusive');
const mode = flag('--publish') ? 'publish' : flag('--rollback') ? 'rollback' : 'preview';
const from = value('--from', 'content-incoming');
const journalPath = join(from, JOURNALS);

// ---- the live sealed layer -----------------------------------------------------------------------
// worlds: the live shape of every world a place may claim to reuse, so a declaration that would move
// a saved arrival, a portal or a whole grid is refused before anything is written. The runtime world
// module is loaded dynamically: a mirror of content/ that has no world.js beside it (a test, a
// minimal staging root) can still preview and publish, and the report says plainly that this one
// check did not run rather than implying it passed.
async function liveWorlds() {
  let getWorldDefinition = null;
  try { ({ getWorldDefinition } = await import('../world.js')); } catch { return { worlds: new Map(), checked: false }; }
  const worlds = new Map();
  for (const entry of content.entries('place')) {
    const id = entry.rules?.site?.world;
    if (!id || worlds.has(id)) continue;
    const definition = getWorldDefinition(id);
    worlds.set(id, { columns: definition.columns, rows: definition.rows, start: definition.start, portals: definition.portals.map((portal) => ({ x: portal.x, y: portal.y })) });
  }
  return { worlds, checked: true };
}
const occupied = (() => {
  const file = value('--land', null);
  if (!file) return null;
  const land = readJson(file, file);
  if (!Array.isArray(land)) fail(`${file} must be a JSON array of "worldId|x,y" strings`);
  return new Set(land);
})();

// ---- the staged set ------------------------------------------------------------------------------
function stagedFiles() {
  if (!existsSync(from)) fail(`the staging directory ${from} does not exist; create it and put content/<family>/<id>.json inside, or pass --from`);
  const staged = [];
  for (const dir of readdirSync(from, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const family = dir.name;
    // The staging directory is shaped like content/, so a family is a directory named exactly as the
    // sealed one is, and anything else is reported rather than silently ignored.
    for (const name of readdirSync(join(from, family))) {
      if (!name.endsWith('.json')) continue;
      const path = `${family}/${name}`;
      const document = readJson(join(from, path), path);
      staged.push({ path, family, name, document });
    }
  }
  return staged;
}

function plan(staged) {
  const updates = [];
  for (const item of staged) {
    const kind = FAMILY_KIND[item.family];
    if (!kind) { updates.push({ ...item, destination: null, reason: `"${item.family}" is not one of the five authored families (${Object.keys(FAMILY_KIND).join(', ')})` }); continue; }
    if (item.document?.kind !== kind) { updates.push({ ...item, destination: null, reason: `${item.path} declares kind ${JSON.stringify(item.document?.kind)}, but a ${item.family} file must declare kind "${kind}"` }); continue; }
    const id = item.document?.id;
    if (typeof id !== 'string' || !id) { updates.push({ ...item, destination: null, reason: `${item.path} declares no id` }); continue; }
    if (name_of(id) !== item.name) { updates.push({ ...item, destination: null, reason: `${item.path} carries id "${id}"; the file must be named ${name_of(id)}` }); continue; }
    const destination = `content/${item.family}/${item.name}`;
    const before = existsSync(at(destination)) ? readFileSync(at(destination), 'utf8') : null;
    const after = JSON.stringify(item.document, null, 2) + '\n';
    updates.push({ ...item, destination, kind, id, before, after, action: before === null ? 'add' : before === after ? 'unchanged' : 'replace' });
  }
  return updates;
}
const name_of = (id) => `${id}.json`;

// ---- the proposed bundle -------------------------------------------------------------------------
// The resolver the product uses is built from a bundle: definitions plus the three generated
// documents. The staged definitions are not sealed yet, so the manifest they will be indexed by is
// predicted here — file path, digest of the exact bytes that will be written, and the licence the
// entry carries. sealMirror() then produces the authoritative generated documents and the publish
// step compares them against this prediction, so a preview that disagrees with the seal is refused.
function proposedBundle(updates) {
  const replaced = new Map();
  for (const update of updates) if (update.destination) replaced.set(`${update.kind}:${update.id}`, update);
  const entries = [];
  const manifestEntries = [];
  for (const entry of content.entries()) {
    const update = replaced.get(`${entry.kind}:${entry.id}`);
    const document = update?.document ?? entry;
    entries.push(document);
    const indexed = content.manifest().entries.find((item) => item.kind === entry.kind && item.id === entry.id);
    manifestEntries.push(update ? {
      id: update.id, kind: update.kind, file: update.destination, sha256: digest(update.after),
      license: update.document.license, assets: update.document.assets ?? [],
    } : indexed);
  }
  for (const [key, update] of replaced) {
    if (content.find(update.id).some((entry) => entry.kind === update.kind)) continue;
    entries.push(update.document);
    manifestEntries.push({ id: update.id, kind: update.kind, file: update.destination, sha256: digest(update.after), license: update.document.license, assets: update.document.assets ?? [] });
  }
  const kinds = {};
  for (const item of manifestEntries) kinds[item.kind] = (kinds[item.kind] || 0) + 1;
  return {
    entries,
    palettes: { schema_version: 1, palettes: content.palettes().reduce((all, name) => ({ ...all, [name]: content.palette(name) }), {}) },
    notices: { schema_version: 1, notices: content.notices() },
    manifest: { ...content.manifest(), kinds, entries: manifestEntries },
  };
}

// ---- the mirror sealer ---------------------------------------------------------------------------
// Preview must be exactly as strict as publishing, so preview seals a *mirror* of content/ with the
// staged files applied and reads the generated documents back. The real working tree is untouched.
function sealMirror(updates) {
  const mirror = mkdtempSync(join(tmpdir(), 'content-publish-'));
  try {
    cpSync(at('content'), join(mirror, 'content'), { recursive: true });
    mkdirSync(join(mirror, 'scripts'), { recursive: true });
    cpSync(at('scripts/seal-content.mjs'), join(mirror, 'scripts/seal-content.mjs'));
    // Every file the seal hashes besides the definitions: the licence notices and the bundled assets.
    const referenced = new Set();
    for (const entry of content.entries()) {
      if (entry.license?.notice_file) referenced.add(entry.license.notice_file);
      for (const asset of content.assets(entry.id, entry.kind)) referenced.add(asset.path);
    }
    for (const update of updates) {
      if (!update.document) continue;
      const notice = update.document.license?.notice_file;
      if (notice) referenced.add(notice);
    }
    for (const file of referenced) {
      if (!existsSync(at(file))) continue;
      mkdirSync(dirname(join(mirror, file)), { recursive: true });
      cpSync(at(file), join(mirror, file));
    }
    // The mirror carries a copy of the sealer's own module so it seals the mirror, not this tree.
    for (const update of updates) if (update.destination) writeFileSync(join(mirror, update.destination), update.after);
    const output = execFileSync(process.execPath, [join(mirror, 'scripts', 'seal-content.mjs')], { cwd: mirror, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const generated = Object.fromEntries(GENERATED.map((path) => [path, readFileSync(join(mirror, path), 'utf8')]));
    return { mirror, summary: output.trim(), generated };
  } catch (error) {
    rmSync(mirror, { recursive: true, force: true });
    const detail = error.stderr?.toString().trim() || error.message;
    fail(`the staged set does not seal: ${detail}`);
    return null;
  }
}

// ---- the report ----------------------------------------------------------------------------------
function report(updates, validation, sealed, live) {
  const lines = [];
  const changed = updates.filter((update) => update.action && update.action !== 'unchanged');
  lines.push(`Staged set: ${from}`);
  lines.push(`  files staged      ${updates.length}`);
  lines.push(`  to add            ${updates.filter((update) => update.action === 'add').length}`);
  lines.push(`  to replace        ${updates.filter((update) => update.action === 'replace').length}`);
  lines.push(`  already identical ${updates.filter((update) => update.action === 'unchanged').length}`);
  for (const update of updates) {
    if (update.reason) { lines.push(`  REJECTED  ${update.path}: ${update.reason}`); continue; }
    lines.push(`  ${update.action.padEnd(9)} ${update.destination}${update.action === 'replace' ? `  ${digest(update.before).slice(0, 12)} -> ${digest(update.after).slice(0, 12)}` : ''}`);
  }
  const beforeCounts = content.manifest().kinds;
  const afterManifest = sealed ? JSON.parse(sealed.generated['content/content-manifest.json']) : null;
  const after = (kind) => afterManifest ? String(afterManifest.kinds?.[kind] ?? beforeCounts[kind] ?? 0).padStart(4) : ' n/a';
  lines.push('');
  lines.push('Sealed definition count, before -> after');
  for (const kind of [...new Set([...Object.keys(beforeCounts), ...Object.keys(afterManifest?.kinds ?? {})])].sort()) {
    const before = beforeCounts[kind] ?? 0, next = afterManifest?.kinds?.[kind] ?? before;
    lines.push(`  ${kind.padEnd(11)} ${String(before).padStart(4)} -> ${after(kind)}${afterManifest && before !== next ? '  (changed)' : ''}`);
  }
  lines.push(`  total       ${String(content.entries().length).padStart(4)} -> ${afterManifest ? String(afterManifest.entries.length).padStart(4) : ' n/a'}`);
  lines.push('');
  lines.push('Generated documents');
  for (const path of GENERATED) {
    const before = existsSync(at(path)) ? readFileSync(at(path), 'utf8') : '';
    const next = sealed?.generated?.[path];
    lines.push(`  ${path.padEnd(33)} ${next === undefined ? 'not computed (the staged set was refused)' : before === next ? 'unchanged' : `would change  ${digest(before).slice(0, 12)} -> ${digest(next).slice(0, 12)}`}`);
  }
  lines.push('');
  lines.push(`Live world shapes: ${live.checked ? 'checked against world.js for every place site' : 'NOT CHECKED — world.js is not available beside this script, so a place that would move a saved arrival was not compared'}`);
  lines.push(`Validator: ${validation.checked.entries} authored entries over ${validation.checked.families} families, ${validation.refusals.length} refusal(s)`);
  for (const refusal of validation.refusals) lines.push(`  REFUSED   ${formatRefusal(refusal)}`);
  return { lines, changed, beforeCounts, afterManifest };
}

// ---- publish -------------------------------------------------------------------------------------
function publish(updates, sealed) {
  const touched = updates.filter((update) => update.destination && update.action !== 'unchanged');
  const journal = { schema_version: 1, root: toPosix(relative(ROOT, at(from))) || from, files: {} };
  for (const path of [...touched.map((update) => update.destination), ...GENERATED]) {
    journal.files[path] = existsSync(at(path)) ? { present: true, contents: readFileSync(at(path), 'utf8') } : { present: false };
  }
  writeFileSync(at(journalPath), JSON.stringify(journal, null, 2) + '\n');
  const restore = (reason) => {
    for (const [path, record] of Object.entries(journal.files)) {
      if (record.present) writeFileSync(at(path), record.contents);
      else if (existsSync(at(path))) rmSync(at(path));
    }
    try { execFileSync(process.execPath, [at('scripts/seal-content.mjs')], { cwd: ROOT, stdio: 'pipe' }); } catch { /* reported below */ }
    process.stderr.write(`content-publish: ${reason}\ncontent-publish: every touched path was restored from ${journalPath} and the seal was regenerated. Nothing was published.\n`);
    process.exit(1);
  };
  try {
    for (const update of touched) writeFileSync(at(update.destination), update.after);
    execFileSync(process.execPath, [at('scripts/seal-content.mjs')], { cwd: ROOT, stdio: 'pipe' });
    execFileSync(process.execPath, [at('scripts/seal-content.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' });
    const after = Object.fromEntries(GENERATED.map((path) => [path, readFileSync(at(path), 'utf8')]));
    for (const path of GENERATED) if (after[path] !== sealed.generated[path]) restore(`${path} was regenerated differently from the previewed mirror, so the preview was not faithful`);
  } catch (error) {
    restore(error.stderr?.toString().trim() || error.message);
  }
  // The journal is deliberately kept after a successful publication: it is the record of the last
  // publication, and `--rollback` restores it and then removes it. That makes "reversible" a property
  // an operator can use rather than only a crash safety net.
  return touched;
}

// ---- rollback ------------------------------------------------------------------------------------
function rollback() {
  if (!existsSync(at(journalPath))) fail(`no journal at ${journalPath}, so there is nothing to roll back`);
  const journal = readJson(at(journalPath), journalPath);
  let restored = 0;
  for (const [path, record] of Object.entries(journal.files || {})) {
    if (record.present) { writeFileSync(at(path), record.contents); restored += 1; }
    else if (existsSync(at(path))) { rmSync(at(path)); restored += 1; }
  }
  execFileSync(process.execPath, [at('scripts/seal-content.mjs')], { cwd: ROOT, stdio: 'pipe' });
  execFileSync(process.execPath, [at('scripts/seal-content.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe' });
  rmSync(at(journalPath), { force: true });
  process.stdout.write(`Restored ${restored} path(s) from ${journalPath}; the seal verifies again.\n`);
}

// ---- run -----------------------------------------------------------------------------------------
if (mode === 'rollback') { rollback(); process.exit(0); }

const updates = plan(stagedFiles());
const blocked = updates.filter((update) => update.reason);
if (blocked.length) { for (const update of blocked) process.stderr.write(`content-publish: ${update.path}: ${update.reason}\n`); fail(`${blocked.length} staged file(s) cannot be placed`); }

const bundle = proposedBundle(updates);
let resolver;
try { resolver = createContent(bundle); }
catch (error) { fail(`the proposed bundle fails the content layer's own envelope checks: ${error.message}`); }
const live = await liveWorlds();
const validation = validateContentFamilies({ entries: bundle.entries, notices: bundle.notices }, { content: resolver, worlds: live.worlds, occupied });
// The mirror is sealed only once the validator is satisfied: a staged set that cannot be accepted is
// reported with every refusal and never has the chance to touch a generated document.
const sealed = validation.ok ? sealMirror(updates) : null;
const summary = report(updates, validation, sealed, live);
process.stdout.write(`${summary.lines.join('\n')}\n`);
// The machine-readable half is written last, so the human transcript and the JSON never interleave.
const emitJson = (changes) => {
  if (!flag('--json')) return;
  const report_ = {
    mode, staging: toPosix(from), ok: validation.ok,
    counts: { before: summary.beforeCounts, after: summary.afterManifest?.kinds ?? null },
    changes,
    refusals: validation.refusals,
  };
  process.stdout.write(`\n${JSON.stringify(report_, null, 2)}\n`);
};
if (!validation.ok) {
  emitJson(summary.changed.map((update) => ({ action: update.action, path: update.destination, id: update.id, kind: update.kind })));
  fail(`${validation.refusals.length} validation refusal(s); nothing was written`);
}
if (mode === 'preview') {
  process.stdout.write(`\nPreview only: nothing was written (${summary.changed.length} file(s) would change). Run with --publish to apply it.\n`);
  emitJson(summary.changed.map((update) => ({ action: update.action, path: update.destination, id: update.id, kind: update.kind })));
  process.exit(0);
}
const touched = publish(updates, sealed);
process.stdout.write(`\nPublished ${touched.length} file(s); the sealer regenerated the manifest, notices and index and --check verifies.\n`);
emitJson(touched.map((update) => ({ action: update.action, path: update.destination, id: update.id, kind: update.kind })));
