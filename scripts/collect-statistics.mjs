import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,join} from 'node:path';
import {collectStatistics,mergeStatistics} from '../runtime/statistics-collection.js';
const args=process.argv.slice(2);let codes,output,ldc=false;
for(let i=0;i<args.length;i++){if(args[i]==='--countries')codes=args[++i]?.split(',');else if(args[i]==='--ldc')ldc=true;else if(args[i]==='--output')output=args[++i];else throw new Error('Usage: node scripts/collect-statistics.mjs (--ldc | --countries NP,BD,...) --output candidate-directory');}
if(!output||Boolean(codes)===ldc)throw new Error('Choose either --ldc or --countries and an explicit candidate output directory.');
const catalog=JSON.parse(await readFile(new URL('../catalog/countries.json',import.meta.url),'utf8')),previous=JSON.parse(await readFile(new URL('../catalog/agriculture-statistics.json',import.meta.url),'utf8'));
if(codes&&codes.some(code=>!catalog.entries.some(c=>c.iso2===code)))throw new Error('Unknown catalog country code.');
const countries=catalog.entries.filter(c=>ldc?c.ldc:codes.includes(c.iso2)),destination=resolve(output);
// Never replace the active catalog: candidates must be reviewed and installed explicitly.
if(destination===resolve(fileURLToPath(new URL('../',import.meta.url)))||destination.startsWith(resolve(fileURLToPath(new URL('../catalog/',import.meta.url)))+'/')||destination===resolve(fileURLToPath(new URL('../catalog/',import.meta.url))))throw new Error('Use a candidate directory outside the active catalog.');
await mkdir(destination,{recursive:true});const started=new Date().toISOString(),results=await collectStatistics(countries,{signal:AbortSignal.timeout(6*60_000)}),merged=mergeStatistics(previous,results);
for(const result of results.filter(r=>r.status==='retrieved')){const path=join(destination,result.series.raw_file);await mkdir(dirname(path),{recursive:true});await writeFile(path,result.raw_json);}
const report={started_at:started,finished_at:new Date().toISOString(),selected_countries:countries.map(c=>c.iso2),retrieved:results.filter(r=>r.status==='retrieved').length,unavailable:results.filter(r=>r.status==='unavailable').length,results:results.map(({raw_json,series,...r})=>({...r,...(series?{sha256:series.sha256,raw_file:series.raw_file,records:series.points.length}:{} )}))};
await writeFile(join(destination,'agriculture-statistics.json'),JSON.stringify(merged,null,2)+'\n');await writeFile(join(destination,'collection-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({candidate:destination,retrieved:report.retrieved,unavailable:report.unavailable,total_countries:merged.countries.length,total_series:merged.metadata.series_count}));
