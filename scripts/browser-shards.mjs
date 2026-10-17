// Each shard has an independent disposable database. Real signup runs in every group;
// every other scenario runs exactly once, in its existing relative order.
import { SCENARIOS } from './browser-suite.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export function browserShard(spec) {
 const match=/^([1-9]\d*)\/([1-9]\d*)$/.exec(spec||'');
 if(!match)throw Error('Use a browser shard index/count, for example 1/4');
 const index=Number(match[1]),total=Number(match[2]);
 if(index>total||total>SCENARIOS.length)throw Error('Browser shard index is out of range');
 let ordinal=0;
 return SCENARIOS.filter(s=>s.id==='accounts-and-switching'||ordinal++%total===index-1).map(s=>s.id);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(browserShard(process.argv[2]).join(','));
