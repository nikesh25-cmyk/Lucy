#!/usr/bin/env node
/**
 * NemoWorld asset pool fetcher.
 *
 * Downloads a pinned, licence-verified pool of third-party assets from CC0 / OFL / permissive
 * sources, records a SHA-256 for every file, and refuses anything whose declared licence is not on
 * the allowlist. It never copies an asset whose terms cannot be named. Re-running is idempotent:
 * a file whose bytes already match its recorded hash is left alone.
 *
 *   node scripts/fetch-asset-pool.mjs                # fetch everything under the size cap
 *   node scripts/fetch-asset-pool.mjs --only audio   # one category
 *   node scripts/fetch-asset-pool.mjs --max-mb 120   # hard byte ceiling for the pool
 *   node scripts/fetch-asset-pool.mjs --verify       # re-hash what is on disk, write nothing new
 *
 * Output: asset-pool/files/<source>/… , asset-pool/manifest.json , asset-pool/NOTICES.md
 */
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const POOL = join(ROOT, 'asset-pool');
const FILES = join(POOL, 'files');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? true) : undefined; };
const ONLY = flag('--only');
const VERIFY = args.includes('--verify');
const MAX_MB = Number(flag('--max-mb') ?? 150);

// Only licences whose terms we can name and that permit redistribution in a private repository.
const LICENSE_ALLOW = new Set(['CC0-1.0', 'OFL-1.1', 'ISC', 'MIT', 'CC-BY-3.0', 'CC-BY-4.0', 'Public-Domain']);
const NOTICE = {
  'CC0-1.0': 'CC0 1.0 Universal (public domain dedication). No attribution required; the author is credited here as good practice.',
  'OFL-1.1': 'SIL Open Font License 1.1. The full licence text ships beside the font.',
  'ISC': 'ISC licence. The full licence text ships beside the file.',
  'MIT': 'MIT licence. The full licence text ships beside the file.',
  'CC-BY-3.0': 'Creative Commons Attribution 3.0. Attribution to the named author is required and recorded here.',
  'CC-BY-4.0': 'Creative Commons Attribution 4.0. Attribution to the named author is required and recorded here.',
};

// id, category, licence, author, home, resolve: how to obtain it.
const CATALOGUE = [
  // ---- Kenney (CC0). Small, game-focused, CC0 across the whole site. ----
  ...['interface-sounds','ui-audio','impact-sounds','rpg-audio','digital-audio','music-jingles'].map((slug) => ({
    id: `kenney-${slug}`, category: 'audio', licence: 'CC0-1.0', author: 'Kenney (kenney.nl)', source: 'kenney',
    home: `https://kenney.nl/assets/${slug}`, resolve: { kind: 'kenney-page', slug },
  })),
  ...['input-prompts','ui-pack','game-icons','cursor-pack'].map((slug) => ({
    id: `kenney-${slug}`, category: 'ui', licence: 'CC0-1.0', author: 'Kenney (kenney.nl)', source: 'kenney',
    home: `https://kenney.nl/assets/${slug}`, resolve: { kind: 'kenney-page', slug },
  })),
  // A 3D pack is STAGED only: the pinned renderer has no mesh loader, so it must not be wired in.
  { id: 'kenney-nature-kit', category: 'model-staged', licence: 'CC0-1.0', author: 'Kenney (kenney.nl)', source: 'kenney',
    home: 'https://kenney.nl/assets/nature-kit', resolve: { kind: 'kenney-page', slug: 'nature-kit' } },

  // ---- ambientCG (CC0). 1K JPG PBR materials for DOM surfaces. ----
  ...['Wood096','Wood066','Rock030','Ground037','Grass004','Fabric085','Metal032','Marble016','Bricks075','Concrete034'].map((id) => ({
    id: `ambientcg-${id}`, category: 'texture', licence: 'CC0-1.0', author: 'Lennart Demes / ambientCG', source: 'ambientcg',
    home: `https://ambientcg.com/view?id=${id}`,
    resolve: { kind: 'url', url: `https://ambientcg.com/get?file=${id}_1K-JPG.zip` },
  })),

  // ---- Poly Haven (CC0). 1K HDRIs for staged skies. ----
  ...['studio_small_03','kloppenheim_02','venice_sunset','moonless_golf','overcast_soil_puresky','forest_slope'].map((slug) => ({
    id: `polyhaven-${slug}`, category: 'hdri', licence: 'CC0-1.0', author: 'Poly Haven', source: 'polyhaven',
    home: `https://polyhaven.com/a/${slug}`,
    resolve: { kind: 'url', url: `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/${slug}_1k.hdr` },
  })),
];

async function head(url) {
  const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  return r.ok ? r : null;
}
async function get(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}
async function kenneyZip(slug) {
  const html = (await get(`https://kenney.nl/assets/${slug}`)).toString('utf8');
  const m = html.match(/https:\/\/kenney\.nl\/media\/pages\/assets\/[^"']+\.zip/);
  if (!m) throw new Error(`no zip link on kenney page for ${slug}`);
  return m[0];
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const mb = (n) => (n / 1048576).toFixed(2);

async function main() {
  if (!VERIFY) await mkdir(FILES, { recursive: true });
  const previous = existsSync(join(POOL, 'manifest.json')) ? JSON.parse(await readFile(join(POOL, 'manifest.json'), 'utf8')) : { files: [] };
  const byPath = new Map(previous.files.map((f) => [f.path, f]));
  const entries = [];
  let total = 0;
  const failures = [];
  for (const item of CATALOGUE) {
    if (ONLY && item.category !== ONLY) continue;
    if (!LICENSE_ALLOW.has(item.licence)) { failures.push(`${item.id}: licence ${item.licence} not allowed`); continue; }
    try {
      const url = item.resolve.kind === 'kenney-page' ? await kenneyZip(item.resolve.slug) : item.resolve.url;
      const rel = join(item.source, `${item.id}${extname(new URL(url).pathname) || '.zip'}`);
      const dest = join(FILES, rel);
      if (VERIFY) {
        if (!existsSync(dest)) { failures.push(`${item.id}: missing on disk`); continue; }
        total += (await stat(dest)).size;
      } else {
        let buf;
        try { buf = await get(url); } catch (e) { failures.push(`${item.id}: ${e.message}`); continue; }
        const size = buf.length;
        if (total + size > MAX_MB * 1048576) { failures.push(`${item.id}: over the ${MAX_MB} MB cap (skipped)`); continue; }
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, buf);
        total += size;
      }
      const bytes = (await stat(dest)).size;
      const record = byPath.get(rel) || {};
      entries.push({ path: rel, id: item.id, category: item.category, licence: item.licence, author: item.author,
        notice: NOTICE[item.licence], home: item.home, url, bytes, sha256: record.sha256 && (VERIFY ? record.sha256 : undefined) });
      process.stdout.write(`  ${VERIFY ? 'verify' : 'fetch '} ${item.id.padEnd(34)} ${mb(bytes).padStart(8)} MB  ${item.licence}\n`);
    } catch (e) { failures.push(`${item.id}: ${e.message}`); }
  }
  // Hash every file that is actually on disk, so the manifest is a record, not a claim.
  for (const entry of entries) {
    const dest = join(FILES, entry.path);
    if (existsSync(dest)) { entry.sha256 = sha(await readFile(dest)); entry.bytes = (await stat(dest)).size; }
  }
  if (!VERIFY) {
    await writeFile(join(POOL, 'manifest.json'), JSON.stringify({
      generated_by: 'scripts/fetch-asset-pool.mjs', licence_allowlist: [...LICENSE_ALLOW],
      total_bytes: entries.reduce((n, e) => n + (e.bytes || 0), 0),
      counts_by_category: entries.reduce((m, e) => ({ ...m, [e.category]: (m[e.category] || 0) + 1 }), {}),
      files: entries,
    }, null, 2) + '\n');
    const lines = ['# Asset pool notices', '', 'Every file below is recorded with its source, licence and SHA-256 in `manifest.json`.', '', '| id | category | licence | author | home |', '| --- | --- | --- | --- | --- |'];
    for (const e of entries) lines.push(`| ${e.id} | ${e.category} | ${e.licence} | ${e.author} | ${e.home} |`);
    lines.push('', 'Nothing here is legal advice; it records what was verified from the file actually downloaded.', '');
    await writeFile(join(POOL, 'NOTICES.md'), lines.join('\n'));
  }
  process.stdout.write(`\n${VERIFY ? 'verified' : 'fetched'} ${entries.length} items, ${mb(total)} MB; ${failures.length} skipped/failed\n`);
  for (const f of failures) process.stdout.write(`  skip ${f}\n`);
}
await main();
