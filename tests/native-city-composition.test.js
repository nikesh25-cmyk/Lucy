import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeNativeCity, loadNativeCityComposition } from '../src/veloren-ext/city-composition.js';
import { validateManifest } from '../src/veloren-ext/world-manifest.js';
import { loadWorks } from '../src/veloren-ext/world-life.js';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = name => JSON.parse(readFileSync(join(root, 'content', name), 'utf8'));
const input = () => ({
  manifest: read('veloren-world-harr.json'), cityManifest: read('veloren-ai-city.json'),
  projects: read('veloren-projects.json'), cityProjects: read('veloren-ai-city-projects.json'),
  landmarks: read('veloren-world-landmarks.json'), extraLandmarks: read('veloren-landmarks-extra.json'),
  cityLandmarks: read('veloren-ai-city-landmarks.json'),
});
const cli = join(root, 'scripts/prepare-native-city.mjs');
function temporary(t) { const p = mkdtempSync(join(tmpdir(), 'city-composition-')); t.after(() => rmSync(p,{recursive:true,force:true})); return p; }

test('composition preserves source entries and does not mutate or share mutable source data', () => {
  const sources = input(), before = structuredClone(sources);
  const result = composeNativeCity(sources);
  assert.deepEqual(sources,before);
  assert.equal(result.manifest.groups.length, sources.manifest.groups.length+sources.cityManifest.groups.length);
  assert.deepEqual(result.manifest.groups.slice(0,sources.manifest.groups.length),sources.manifest.groups);
  assert.deepEqual(result.manifest.atmosphere,sources.manifest.atmosphere);
  assert.deepEqual(validateManifest(result.manifest),[]);
  assert.deepEqual(result.projects.projects.slice(0,sources.projects.projects.length),sources.projects.projects);
  assert.deepEqual(result.landmarks.landmarks, [sources.landmarks,sources.extraLandmarks,sources.cityLandmarks].flatMap(s=>s.landmarks));
  result.manifest.groups[0].anchor.dx=399;
  result.projects.projects[0].name='changed';
  result.landmarks.landmarks[0].label='changed';
  assert.deepEqual(sources,before);
  assert.deepEqual(loadNativeCityComposition(),composeNativeCity(input()));
});

test('duplicate group, project and landmark IDs refuse rather than replace existing content', () => {
  for (const [field,key] of [['cityManifest','groups'],['cityProjects','projects'],['cityLandmarks','landmarks']]) {
    const sources=input();
    const base=({cityManifest:'manifest',cityProjects:'projects',cityLandmarks:'landmarks'})[field];
    sources[field][key][0].id=sources[base][key][0].id;
    assert.throws(()=>composeNativeCity(sources),/duplicate/i);
  }
  const sources=input();
  sources.extraLandmarks.landmarks.push(structuredClone(sources.extraLandmarks.landmarks[0]));
  assert.throws(()=>composeNativeCity(sources),/duplicate/i);
});

test('invalid full manifest, missing project references and unresolved crew sites refuse', () => {
  let sources=input(); sources.cityManifest.groups[0].ops[0].to[0]=49;
  assert.throws(()=>composeNativeCity(sources),/manifest/i);
  sources=input(); sources.cityManifest.site='Elsewhere';
  assert.throws(()=>composeNativeCity(sources),/site/i);
  sources=input(); sources.cityProjects.projects.pop();
  assert.throws(()=>composeNativeCity(sources),/project/i);
  sources=input(); sources.cityLandmarks.landmarks=sources.cityLandmarks.landmarks.filter(l=>l.id!=='site-city-office');
  assert.throws(()=>composeNativeCity(sources),/site-city-office/i);
});

test('CLI requires destination, returns absolute JSON paths and output works with existing loadWorks', t => {
  const missing=spawnSync(process.execPath,[cli],{encoding:'utf8'});
  assert.notEqual(missing.status,0); assert.match(missing.stderr,/--output-dir/);
  const dir=temporary(t), out=join(dir,'prepared');
  const paths=JSON.parse(execFileSync(process.execPath,[cli,'--output-dir',out],{encoding:'utf8'}));
  assert.deepEqual(paths,{manifest:join(out,'manifest.json'),projects:join(out,'projects.json'),landmarks:join(out,'landmarks.json')});
  assert.deepEqual(JSON.parse(readFileSync(paths.manifest,'utf8')),loadNativeCityComposition().manifest);
  const works=loadWorks({manifestPath:paths.manifest,projectsPath:paths.projects});
  assert.equal(works.find(p=>p.id==='city-home-1').stages.at(-1).id,'city-home-1-complete');
  assert.equal(works.find(p=>p.id==='city-home-1').stages.length,3);
  const before=readFileSync(paths.manifest,'utf8');
  const again=spawnSync(process.execPath,[cli,'--output-dir',out],{encoding:'utf8'});
  assert.notEqual(again.status,0); assert.match(again.stderr,/exist/i);
  assert.equal(readFileSync(paths.manifest,'utf8'),before);
});

test('CLI preflights every output so an existing later file creates no partial manifest', t => {
  const dir=temporary(t);
  writeFileSync(join(dir,'projects.json'),'preserve me');
  const result=spawnSync(process.execPath,[cli,'--output-dir',dir],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.equal(existsSync(join(dir,'manifest.json')),false);
  assert.equal(existsSync(join(dir,'landmarks.json')),false);
  assert.equal(readFileSync(join(dir,'projects.json'),'utf8'),'preserve me');
});
