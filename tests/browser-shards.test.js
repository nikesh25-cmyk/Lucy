import test from 'node:test';
import assert from 'node:assert/strict';
import { browserShard } from '../scripts/browser-shards.mjs';
import { SCENARIOS } from '../scripts/browser-suite.mjs';
test('CI browser shards retain every scenario, order and real signup in every fresh database',()=>{
 const ids=SCENARIOS.map(s=>s.id),groups=[1,2,3,4].map(n=>browserShard(`${n}/4`));
 for(const group of groups){assert.ok(group.includes('accounts-and-switching'));assert.deepEqual(group,ids.filter(id=>group.includes(id)));}
 assert.deepEqual([...new Set(groups.flat())].sort(),[...ids].sort());
 for(const id of ids.filter(id=>id!=='accounts-and-switching'))assert.equal(groups.filter(g=>g.includes(id)).length,1,id);
 assert.ok(Math.max(...groups.map(g=>g.length))-Math.min(...groups.map(g=>g.length))<=1);
});
test('CI shard selection refuses invalid or missing indices',()=>{
 for(const input of ['',undefined,'0/4','5/4','1/0','one','1/2/3'])assert.throws(()=>browserShard(input));
});
test('plot-dependent UI scenarios share the world where stewardship was earned',()=>{
 const groups=[1,2,3,4].map(n=>browserShard(`${n}/4`));
 const cluster=['plot-and-blueprints','character-switch-clears-preview','hud-visible-while-building','signout-privacy'];
 assert.ok(groups.some(g=>cluster.every(id=>g.includes(id))),'plot assignment and dependent previews/privacy must stay in one saved world');
});
