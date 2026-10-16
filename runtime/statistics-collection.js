import {createHash} from 'node:crypto';
import {AGRICULTURE_INDICATORS,REGISTERED_INDICATORS,statisticsUrl} from '../src/statistics.js';
import {readSource} from './research-worker.js';
import {normalizeStatistics,statisticsRequest} from './statistics-source.js';
// Curator-only collection: never gives network tools or draft access to an agent.
export async function collectStatistics(countries,{read=readSource,signal,concurrency=3,indicatorIds=AGRICULTURE_INDICATORS.map(i=>i.id)}={}){
 if(!Array.isArray(countries)||!countries.length||countries.length>64||new Set(countries.map(c=>c.iso2)).size!==countries.length||!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('Choose 1–64 unique catalog countries and 1–4 collectors.');
 if(!Array.isArray(indicatorIds)||!indicatorIds.length||indicatorIds.length>5||new Set(indicatorIds).size!==indicatorIds.length||indicatorIds.some(id=>!REGISTERED_INDICATORS.some(i=>i.id===id)))throw new Error('Choose unique registered indicator identifiers.');
 const indicators=indicatorIds.map(id=>REGISTERED_INDICATORS.find(i=>i.id===id));
 for(const country of countries)if(statisticsRequest(new URL(statisticsUrl(country.iso3,indicators[0].id))).country.iso2!==country.iso2)throw new Error('Country identity must match the catalog.');
 const tasks=countries.flatMap(country=>indicators.map(indicator=>({country,indicator,url:statisticsUrl(country.iso3,indicator.id)}))),results=new Array(tasks.length);let next=0;
 await Promise.all(Array.from({length:Math.min(concurrency,tasks.length)},async()=>{while(next<tasks.length){const i=next++,task=tasks[i];try{signal?.throwIfAborted();const record=await read(task.url,['api.worldbank.org'],{retainRaw:true,signal:AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])])});
  const bytes=Buffer.from(record.raw_json||'','utf8'),hash=createHash('sha256').update(bytes).digest('hex');if(!bytes.length||hash!==record.sha256)throw new Error('Retained source does not match its checksum.');
  const normalized=normalizeStatistics(bytes.toString('utf8'),statisticsRequest(new URL(task.url))).structured_data;if(JSON.stringify(normalized)!==JSON.stringify(record.structured_data))throw new Error('Normalized source differs from retained bytes.');
  if(!Number.isFinite(Date.parse(record.retrieved)))throw new Error('Missing retrieval timestamp.');
  results[i]={country_code:task.country.iso2,country:task.country.name,indicator:task.indicator.id,url:task.url,status:'retrieved',raw_json:record.raw_json,series:{...normalized,url:task.url,retrieved_on:record.retrieved.slice(0,10),retrieved_at:record.retrieved,sha256:hash,raw_file:`catalog/statistics/${task.country.iso3}-${task.indicator.id}-${hash.slice(0,16)}.json`}};
 }catch(error){results[i]={country_code:task.country.iso2,country:task.country.name,indicator:task.indicator.id,url:task.url,status:'unavailable',reason:error.message};}}}));return results;
}
export function mergeStatistics(previous,results,at=new Date().toISOString()){
 const countries=structuredClone(previous.countries),byCountry=new Map(countries.map(c=>[c.country_code,c]));for(const result of results){if(result.status!=='retrieved')continue;let country=byCountry.get(result.country_code);if(!country){country={country_code:result.country_code,country:result.country,series:[]};countries.push(country);byCountry.set(result.country_code,country);}const index=country.series.findIndex(s=>s.indicator===result.indicator);if(index<0)country.series.push(result.series);else country.series[index]=result.series;}
 const selected=new Set(results.map(r=>r.country_code+':'+r.indicator)),failures=results.filter(r=>r.status==='unavailable').map(({raw_json,series,...r})=>({...r,attempted_at:at}));const unavailable=[...(previous.metadata.unavailable||[]).filter(r=>!selected.has(r.country_code+':'+r.indicator)),...failures];
 const series=countries.reduce((n,c)=>n+c.series.length,0),observations=countries.reduce((n,c)=>n+c.series.reduce((m,s)=>m+s.points.length,0),0);
 return {metadata:{...previous.metadata,retrieved_on:at.slice(0,10),last_collection_at:at,scope:`${series} retained annual series for ${countries.length} countries; ${observations} records within 2015–2026. Each series retains its own retrieval date. Other routes remain research starting points.`,country_count:countries.length,series_count:series,observation_count:observations,unavailable},countries:countries.sort((a,b)=>a.country_code.localeCompare(b.country_code))};
}
