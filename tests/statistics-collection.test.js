import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {collectStatistics,mergeStatistics} from '../runtime/statistics-collection.js';
import {normalizeStatistics,statisticsRequest} from '../runtime/statistics-source.js';
import {fixture} from './helpers.js';
import {readSource} from '../runtime/research-worker.js';
import {statisticsUrl} from '../src/statistics.js';
const countries=JSON.parse(readFileSync(new URL('../catalog/countries.json',import.meta.url))).entries;
const previous=JSON.parse(readFileSync(new URL('../catalog/agriculture-statistics.json',import.meta.url)));
const rawFor=url=>readFileSync(new URL('../catalog/statistics/NPL-'+statisticsRequest(new URL(url)).indicator.id+'.json',import.meta.url),'utf8');
const reader=async url=>{const raw=rawFor(url);return {raw_json:raw,retrieved:'2026-10-11T12:00:00.000Z',sha256:createHash('sha256').update(raw).digest('hex'),...normalizeStatistics(raw,statisticsRequest(new URL(url)))};};
test('curated collection revalidates retained bytes and limits concurrent source requests',async()=>{
 let active=0,peak=0;const results=await collectStatistics([countries.find(c=>c.iso2==='NP')],{concurrency:2,read:async(url,domains,options)=>{assert.deepEqual(domains,['api.worldbank.org']);assert.equal(options.retainRaw,true);active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,10));active--;return reader(url);}});assert.equal(peak,2);assert.equal(results.length,3);assert.ok(results.every(r=>r.status==='retrieved'));assert.match(results[0].series.raw_file,/catalog\/statistics\/NPL-.*-[0-9a-f]{16}\.json/);
 const bad=await collectStatistics([countries.find(c=>c.iso2==='NP')],{read:async url=>({...await reader(url),sha256:'wrong'})});assert.ok(bad.every(r=>r.status==='unavailable'&&r.reason.includes('checksum')));
 await assert.rejects(collectStatistics([{iso2:'XX',iso3:'NPL'}]),/identity/);await assert.rejects(collectStatistics([countries[0],countries[0]]),/unique/);
});
test('failed refresh preserves previous verified records, while successful refresh retains dates and explicit gaps',async()=>{
 const results=await collectStatistics([countries.find(c=>c.iso2==='NP')],{read:async url=>{if(url.includes('EMPL'))throw new Error('Fixture source timeout');return reader(url);}}),merged=mergeStatistics(previous,results,'2026-10-12T12:00:00.000Z'),old=previous.countries.find(c=>c.country_code==='NP'),current=merged.countries.find(c=>c.country_code==='NP');assert.deepEqual(current.series.find(s=>s.indicator==='SL.AGR.EMPL.ZS'),old.series.find(s=>s.indicator==='SL.AGR.EMPL.ZS'));assert.equal(current.series.find(s=>s.indicator==='AG.LND.ARBL.ZS').retrieved_on,'2026-10-11');assert.equal(merged.metadata.unavailable.find(r=>r.country_code==='NP').reason,'Fixture source timeout');assert.equal(previous.countries.find(c=>c.country_code==='NP').series[0].raw_file,old.series[0].raw_file);
 const controller=new AbortController();controller.abort(new Error('Fixture batch stopped'));let reads=0;const stopped=await collectStatistics([countries.find(c=>c.iso2==='NP')],{signal:controller.signal,read:async()=>{reads++;}});assert.equal(reads,0);assert.ok(stopped.every(r=>r.status==='unavailable'));
});
test('country coverage filters distinguish complete, partial and absent retained data and reject unknown filters',async t=>{
 const f=await fixture(t),all=f.platform.countries(null,{limit:248});assert.equal(all.entries.length,248);assert.equal(all.evidence_coverage.retained+all.evidence_coverage.partial+all.evidence_coverage.none,248);const retained=f.platform.countries(null,{evidence:'retained',limit:248});assert.ok(retained.entries.some(c=>c.iso2==='NP'));assert.ok(retained.entries.every(c=>c.evidence.series_count===3));const absent=f.platform.countries(null,{evidence:'none',limit:248});assert.ok(absent.entries.every(c=>c.evidence.series_count===0));assert.throws(()=>f.platform.countries(null,{evidence:'invented'}),{status:400});
});

test('source cancellation terminates a pending DNS lookup without starting the network request',async()=>{
 const controller=new AbortController();let fetched=false;const timer=setTimeout(()=>controller.abort(new Error('Fixture DNS deadline')),20);
 try{await assert.rejects(readSource(statisticsUrl('NPL','AG.LND.ARBL.ZS'),['api.worldbank.org'],{signal:controller.signal,resolve:()=>new Promise(()=>{}),fetchImpl:async()=>{fetched=true;}}),/Fixture DNS deadline/);assert.equal(fetched,false);}finally{clearTimeout(timer);}
});
