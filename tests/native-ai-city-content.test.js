import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, MANIFEST_LIMITS } from '../src/veloren-ext/world-manifest.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const names = ['', '-projects', '-landmarks'].map(s => `veloren-ai-city${s}.json`);
const read = name => JSON.parse(readFileSync(join(root, 'content', name), 'utf8'));
const city = read(names[0]), projects = read(names[1]), landmarks = read(names[2]);
const xyz = (g, p) => [g.anchor.dx+p[0], g.anchor.dy+p[1], p[2]];
const volume = op => op.from.reduce((n, a, i) => n*(op.to[i]-a+1), 1);
const fillCount = m => m.groups.flatMap(g => g.ops).filter(o => o.op === 'fill').reduce((n, o) => n+volume(o), 0);

// Nominal shared-ground cell model: later operations replace earlier ones, as on the native expander.
// Native terrain elevation, foundation acceptance and segment joins are separate parent survey gates.
function cells(groups) {
  const map = new Map();
  for (const g of groups) for (const op of g.ops) {
    if (op.op === 'sprite') { map.set(xyz(g, op.at).join(','), 'sprite'); continue; }
    if (op.op !== 'fill' && op.op !== 'clear') continue;
    const a = xyz(g, op.from), b = xyz(g, op.to);
    for (let x=a[0]; x<=b[0]; x++) for (let y=a[1]; y<=b[1]; y++) for (let z=a[2]; z<=b[2]; z++) {
      const key = [x,y,z].join(',');
      if (op.op === 'fill') map.set(key, 'solid'); else map.delete(key);
    }
  }
  return map;
}
// Rust counts every unique expanded piece, including Air and Sprite, plus every foundation column.
function groupWorkCells(group) {
  const pieces = new Set(); let columns = 0;
  for (const op of group.ops) {
    if (op.op === 'foundation') { columns += (Math.abs(op.to[0]-op.from[0])+1)*(Math.abs(op.to[1]-op.from[1])+1); continue; }
    if (op.op === 'sprite') { pieces.add(op.at.join(',')); continue; }
    for (let x=op.from[0];x<=op.to[0];x++) for (let y=op.from[1];y<=op.to[1];y++) for (let z=op.from[2];z<=op.to[2];z++) pieces.add(`${x},${y},${z}`);
  }
  return pieces.size+columns;
}
const workCells = manifest => manifest.groups.reduce((n,g)=>n+groupWorkCells(g),0);
const finalCells = cells(city.groups);
const open = (x,y,z=1) => !finalCells.has([x,y,z].join(',')) && !finalCells.has([x,y,z+1].join(',')) && !finalCells.has([x,y,z+2].join(','));

test('city generator is deterministic and only produces its three additive artifacts', t => {
  const out = mkdtempSync(join(tmpdir(), 'native-city-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  for (let pass=0; pass<2; pass++) {
    execFileSync('python3', [join(root, 'tools/gen-native-ai-city.py'), '--output-dir', out]);
    for (const name of names) assert.equal(readFileSync(join(out, name), 'utf8'), readFileSync(join(root, 'content', name), 'utf8'));
  }
});

test('city uses the existing manifest validator and retains its local operation and volume limits', () => {
  assert.deepEqual(validateManifest(city), []);
  assert.equal(MANIFEST_LIMITS.max_extent, 48);
  assert.equal(city.area.radius, 400);
  const old = read('veloren-world-harr.json');
  const combined = {...old, area: city.area, groups: [...old.groups, ...city.groups]};
  assert.deepEqual(validateManifest(combined), []);
  assert.ok(fillCount(combined) <= 60000);
  assert.ok(combined.groups.length <= 600);
  assert.ok(fillCount(city) > 10000, 'substantial furnished geometry, not landmark-only placeholders');
  assert.ok(workCells(combined) <= 60000, 'Rust budget includes clear cells, sprites and foundation columns');
  for (const g of combined.groups) assert.ok(groupWorkCells(g) <= 6000, `${g.id} Rust group budget`);
  for (const g of city.groups) {
    assert.ok(g.id.startsWith('city-'));
    for (const op of g.ops) {
      for (const p of [op.from, op.to, op.at].filter(Boolean)) {
        assert.ok(Math.abs(p[0]) <= 48 && Math.abs(p[1]) <= 48, g.id);
        if (p.length===3) assert.ok(p[2]>=-12 && p[2]<=24, g.id);
      }
      if (op.op === 'fill' || op.op === 'clear') assert.ok(volume(op)<=4096, `${g.id} ${op.op} volume`);
    }
  }
});

test('all eight construction projects have three ordered AI crew stages and exact completion records', () => {
  assert.equal(projects.projects.length, 8);
  for (const p of projects.projects) {
    const stages = city.groups.filter(g => g.project === p.id);
    assert.deepEqual(stages.map(g => g.id), ['foundation','shell','complete'].map(s => `${p.id}-${s}`));
    const path = city.groups.find(g => g.id === `${p.id}-path`);
    assert.ok(path, `${p.id} has a public path before crew admission`);
    assert.equal(path.project, undefined);
    assert.equal(path.crew, undefined);
    assert.ok(city.groups.indexOf(path) < city.groups.indexOf(stages[0]));
    assert.deepEqual(stages.map(g => g.release_after_minutes), [1,3,5]);
    for (const g of stages) {
      assert.equal(g.crew, 2);
      assert.equal(g.site, `site-${p.id}`);
      const target = landmarks.landmarks.find(l => l.id === p.id);
      const site = landmarks.landmarks.find(l => l.id === g.site);
      assert.ok(site && target);
      assert.equal(site.dx, target.dx); assert.equal(site.dy, target.dy);
      assert.ok(Math.hypot(site.dx-g.anchor.dx-g.ground_at[0], site.dy-g.anchor.dy-g.ground_at[1]) <= 2);
    }
  }
  for (let n=1; n<=4; n++) assert.ok(city.groups.some(g => g.id === `city-home-${n}-complete`));
});

test('protected route and street crossing connect Harr north edge to all public doorsteps', () => {
  for (let y=52; y<=266; y++) {
    assert.ok(open(0,y), `north route blocked at ${y}`);
    assert.equal(finalCells.get([0,y,0].join(',')), 'solid', `missing route floor at ${y}`);
  }
  for (let x=-68; x<=68; x++) for (const y of [216,220,224]) assert.ok(open(x,y), `avenue/sidewalk blocked at ${x},${y}`);
  const connectorCells = cells(city.groups.filter(g => g.id === 'city-approach-1'));
  assert.equal(connectorCells.get('0,52,0'), 'solid');
  assert.equal(connectorCells.get('0,53,0'), 'solid');
  assert.equal(connectorCells.has('2,53,0'), false, 'existing lamp footing stays untouched');
  assert.equal(connectorCells.has('2,53,1'), false, 'existing lamp stays untouched');
  for (const l of landmarks.landmarks.filter(l => l.id.startsWith('city-'))) {
    assert.ok(open(l.dx,l.dy), `arrival blocked: ${l.id}`);
  }
  // A flood fill proves every entrance and named destination is reachable over authored floor cells.
  const seen = new Set(['0,220']), queue = [[0,220]];
  for (let i=0; i<queue.length; i++) {
    const [x,y] = queue[i];
    for (const [xx,yy] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]) {
      const k = `${xx},${yy}`;
      if (!seen.has(k) && finalCells.get(`${k},0`)==='solid' && open(xx,yy)) { seen.add(k); queue.push([xx,yy]); }
    }
  }
  for (const l of landmarks.landmarks.filter(l => l.id.startsWith('city-'))) assert.ok(seen.has(`${l.dx},${l.dy}`), `disconnected ${l.id}`);
});

test('buildings keep three-wide entrances, furnished central aisles and reachable mezzanine stairs', () => {
  for (const p of projects.projects) {
    const [base, shell, complete] = city.groups.filter(g => g.project === p.id);
    const floor = base.ops.find(o => o.op==='fill' && o.from[0]===0 && o.from[1]===0);
    const [w,d] = floor.to, door = w/2;
    for (let y=0; y<=d; y++) assert.ok(open(base.anchor.dx+door,base.anchor.dy+y), `${p.id} aisle y${y}`);
    for (let dx=-1; dx<=1; dx++) for (const y of [0,d]) assert.ok(open(base.anchor.dx+door+dx,base.anchor.dy+y), `${p.id} door`);
    assert.ok(complete.ops.some(o => o.op==='sprite'), `${p.id} furnished`);
    if (p.id.startsWith('city-home-')) assert.equal(complete.ops.filter(o => o.sprite==='BedWoodWoodlandHead').length,2);
    if (['city-office','city-university'].includes(p.id)) {
      const z = p.id === 'city-office' ? 7 : 8;
      for (let step=1; step<=z; step++) {
        const [x,y] = [base.anchor.dx+2,base.anchor.dy+step+3];
        assert.equal(finalCells.get(`${x},${y},${step}`),'solid');
        assert.ok(open(x,y,step+1), `${p.id} stair headroom ${step}`);
      }
    }
    assert.ok(shell.ops.some(o => o.sprite === 'Window3'), 'existing native windows used');
  }
});

test('city district bounds and private home envelope remain separated', () => {
  const district = city.groups.filter(g => !g.id.startsWith('city-approach-'));
  for (const g of district) for (const op of g.ops) for (const p of [op.from,op.to,op.at].filter(Boolean)) {
    const [x,y] = xyz(g,p);
    assert.ok(x>=-70 && x<=70 && y>=170 && y<=270, g.id);
    // Cached Plaza15213,15977; conservative native private grid starts15300,16100.
    assert.ok(x+15213 < 15300, `${g.id} reaches private home envelope`);
  }
  const ids = new Set(landmarks.landmarks.map(l => l.id));
  for (const id of ['arrival','homes','build','office','farm','school','university','park']) assert.ok(ids.has(`city-${id}`));
});

test('native budgets reject oversized clear boxes and clearing-only total overflow', () => {
  const oversized = structuredClone(city);
  oversized.groups[0].ops = [{op:'clear',from:[0,0,1],to:[16,16,15]}];
  assert.ok(validateManifest(oversized).length > 0, 'clear boxes obey the same 4096-cell cap as fill');
  const clearingOnly = {...structuredClone(city), groups:Array.from({length:15},(_,n)=>({
    id:`clear-budget-${n}`,anchor:{plot:'Plaza',nth:0,dx:0,dy:0},
    ops:[{op:'clear',from:[0,0,1],to:[15,15,16]}],
  }))};
  assert.ok(validateManifest(clearingOnly).length > 0, '61440 Air work cells exceed the native total budget');
});
