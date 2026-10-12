import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { statisticsUrl } from '../src/statistics.js';
import { statisticsRequest,normalizeStatistics } from '../runtime/statistics-source.js';
import {readSource,runResearch,statisticsDraft,statisticalFacts} from '../runtime/research-worker.js';
import {fixture} from './helpers.js';
import {createApp} from '../server.js';
const url=statisticsUrl('NPL','AG.LND.ARBL.ZS'),spec=statisticsRequest(new URL(url));
const raw=readFileSync(new URL('../catalog/statistics/NPL-AG.LND.ARBL.ZS.json',import.meta.url),'utf8');
const resolve=async()=>[{address:'93.184.216.34',family:4}];

test('statistics routes reject arbitrary APIs, query duplicates and unregistered series',()=>{
  assert.equal(statisticsRequest(new URL('https://example.org/data')),null);
  for(const value of [url+'&source=2',url.replace('NPL','ZZZ'),url.replace('AG.LND.ARBL.ZS','SP.POP.TOTL'),url.replace('2015:2026','1900:2026'),url+'#part',url+'&footnote=y'])assert.throws(()=>statisticsRequest(new URL(value)),/registered/);
});
test('statistics retain missing values and zero while rejecting mixed identities, units and incomplete pages',()=>{
  const data=JSON.parse(raw);data[1][0].value=0;data[1][1].value=null;
  const result=normalizeStatistics(JSON.stringify(data),spec);assert.equal(result.structured_data.points[0].value,0);assert.equal(result.structured_data.points[1].value,null);assert.match(result.text,/missing/);assert.equal(result.declared_published,null);assert.equal(result.structured_data.dataset_updated,'2026-10-08');
  for(const mutate of [d=>d[0].pages=2,d=>d[0].total++,d=>d[0].lastupdated='2026-02-30',d=>d[1][0].countryiso3code='BGD',d=>d[1][0].country.id='BD',d=>d[1][0].indicator.id='SL.AGR.EMPL.ZS',d=>d[1][0].date='2027',d=>d[1][0].date=d[1][1].date,d=>d[1][0].value='3',d=>d[1][0].value=-1,d=>d[1][0].value=101,d=>d[1][0].unit='dollars']){const bad=JSON.parse(raw);mutate(bad);assert.throws(()=>normalizeStatistics(JSON.stringify(bad),spec));}
  for(const value of ['null','{}','[{}]'])assert.throws(()=>normalizeStatistics(value,spec),/metadata/);
});
test('typed JSON reader shares source host, DNS and byte limits; arbitrary JSON remains unsupported',async()=>{
  const read=await readSource(url,['api.worldbank.org'],{resolve,fetchImpl:async()=>new Response(raw,{headers:{'content-type':'application/json;charset=utf-8'}})});assert.equal(read.structured_data.country_code,'NP');assert.equal(read.sha256,createHash('sha256').update(raw).digest('hex'));assert.equal(read.quote,null);
  await assert.rejects(readSource(url,['example.org'],{resolve}),/approved/);
  await assert.rejects(readSource(url,['api.worldbank.org'],{resolve:async()=>[{address:'127.0.0.1',family:4}]}),/private/);
  await assert.rejects(readSource('https://example.org/data',['example.org'],{resolve,fetchImpl:async()=>new Response('{}',{headers:{'content-type':'application/json'}})}),/HTML/);
  await assert.rejects(readSource(url,['api.worldbank.org'],{resolve,fetchImpl:async()=>new Response(raw,{headers:{'content-type':'application/json','content-length':'1000001'}})}),/megabyte/);
});
test('snapshots reconcile to raw hashes and country baseline updates preserve activated tasks',async t=>{
  const f=await fixture(t),snapshot=f.platform.countryEvidence(null,{country:'NP'});assert.equal(snapshot.snapshot.series.length,3);const zambia=f.platform.countryEvidence(null,{country:'ZM'}).snapshot;assert.equal(zambia.series.length,3);assert.deepEqual([...new Set(zambia.series.map(series=>series.country_code))],['ZM']);const senegal=f.platform.countryEvidence(null,{country:'SN'});assert.equal(senegal.snapshot,null);assert.equal(senegal.collection_gaps.length,3);assert.throws(()=>f.platform.countryEvidence(null,{country:'XX'}),{status:400});
  const catalog=JSON.parse(readFileSync(new URL('../catalog/agriculture-statistics.json',import.meta.url)));
  for(const country of catalog.countries)for(const series of country.series){const bytes=readFileSync(new URL('../'+series.raw_file,import.meta.url));assert.equal(series.sha256,createHash('sha256').update(bytes).digest('hex'));assert.deepEqual(series.points,normalizeStatistics(bytes.toString('utf8'),statisticsRequest(new URL(series.url))).structured_data.points);}
  const lead=f.platform.research(null,{country:'NP',goal:2,stage:'baseline',q:'Establish'}).leads.find(item=>item.id==='NP-2-baseline');assert.equal(lead.source_urls.length,5);
  const activated=f.tx('researchActivate',f.actor('admin'),{lead_id:lead.id,beneficiary:'Fixture only',reviewer_id:f.actor('reviewer').account.id});const before=f.platform.get('SELECT * FROM tasks WHERE id=?',activated.task_id);
  f.platform.run("UPDATE research_leads SET instructions='Already approved scope' WHERE id=?",lead.id);f.platform.initCivic();assert.equal(f.platform.get('SELECT instructions FROM research_leads WHERE id=?',lead.id).instructions,'Already approved scope');assert.deepEqual(f.platform.get('SELECT * FROM tasks WHERE id=?',activated.task_id),before);assert.equal(f.platform.research(null).catalog_total,2998);
});
test('country endpoint and statistics worker preserve year, attribution and full annual evidence through real HTTP',async t=>{
  const f=await fixture(t),lead=f.platform.research(null,{country:'NP',goal:2,q:'Establish'}).leads.find(item=>item.id==='NP-2-baseline');const activated=f.tx('researchActivate',f.actor('admin'),{lead_id:lead.id,beneficiary:'Fixture',reviewer_id:f.actor('reviewer').account.id}),agent=f.agent('alice'),runtime=f.tx('runtime',f.actor('alice'),agent.id,{scopes:['read','contribute'],duration_minutes:10,max_calls:20});
  const {server}=createApp({platform:f.platform});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));const base=`http://127.0.0.1:${server.address().port}`;
  const endpoint=await fetch(base+'/api/v1/country-evidence?country=NP');assert.equal(endpoint.status,200);assert.equal((await endpoint.json()).snapshot.series.length,3);
  const exported=await fetch(base+'/api/v1/country-evidence?country=NP&download=1');assert.match(exported.headers.get('content-disposition'),/attachment; filename="lucy-NPL-agriculture-evidence.json"/);assert.equal((await exported.json()).snapshot.series[0].country_code,'NP');
  const result=await runResearch({token:runtime.token,url:base,taskId:activated.task_id,urls:[url],resolve,fetchImpl:async(input,options)=>new URL(input).hostname==='127.0.0.1'?fetch(input,options):new Response(raw,{headers:{'content-type':'application/json'}})});
  const submission=f.platform.get('SELECT * FROM submissions WHERE id=?',result.submission_id);assert.equal(result.status,'pending_review');assert.match(submission.artifact,/Normalized annual statistics \(not a quotation\)/);assert.match(submission.artifact,/2024: 12.5831880013952/);assert.match(submission.rights,/CC BY 4.0/);assert.match(submission.limitations,/missing values are not zero/);
  f.tx('review',f.actor('reviewer'),{submission_id:result.submission_id,decision:'accepted',reason:'Fixture evidence checked; not a production approval.'});
  const second=f.tx('createTask',f.actor('admin'),{mission_id:activated.mission_id,title:'Fallback verification',instructions:'Sector evidence only.',rights:'World Bank data terms.',allowed_domains:['api.worldbank.org']});
  const next=f.tx('runtime',f.actor('alice'),agent.id,{scopes:['read','contribute'],duration_minutes:10,max_calls:20});
  const fallback=await runResearch({token:next.token,url:base,taskId:second.id,urls:[url],resolve,fetchImpl:async(input,options)=>new URL(input).hostname==='127.0.0.1'?fetch(input,options):new Response(raw,{headers:{'content-type':'application/json'}}),modelFn:async()=>{throw new Error('Local model returned an incomplete or invalid response.');}});
  assert.equal(fallback.draft_status,'withheld_invalid_response');const retained=f.platform.get('SELECT * FROM submissions WHERE id=?',fallback.submission_id);assert.match(retained.artifact,/MODEL DRAFT WITHHELD/);assert.match(retained.artifact,/2024, 12.5831880013952 % of land area/);assert.equal(retained.status,'pending_review');

});

test('numerical model prose is withheld while exact observations retain their year, unit and source',()=>{
 const record=normalizeStatistics(raw,spec),records=[record];
 assert.throws(()=>statisticsDraft('Land is 12.5% in 2024. [Source 1]',records),/validated/);
 assert.equal(statisticsDraft('Land classification cannot establish tenure. [Source 1]\n\nEvidence gaps: Local soil evidence is missing.',records).includes('tenure'),true);
 assert.match(statisticalFacts(records),/2024, 12.5831880013952 % of land area/);
 assert.match(statisticalFacts(records),/\[Source 1\]/);
});
