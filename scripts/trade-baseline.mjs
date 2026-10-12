import {readTradeCandidate,prepareTradeSubmission} from '../runtime/trade-candidate.js';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';import {tradeBaselineQueries,collectTradeBaseline,tradeBaselineCSV} from '../runtime/trade-baseline.js';
const [mode,...args]=process.argv.slice(2);
try{
 if(mode==='collect'){
  if(args.length!==6)throw Error('Usage: node scripts/trade-baseline.mjs collect ORIGIN_ISO2 DESTINATION_ISO2 HS_CODE START_YEAR END_YEAR OUTPUT_ROOT');
  const [origin,destination,commodity,start,end,directory]=args,input={origin,destination,commodity,startYear:Number(start),endYear:Number(end)};tradeBaselineQueries(input);await mkdir(resolve(directory),{recursive:true});const candidate=await mkdtemp(join(resolve(directory),`trade-${origin}-${destination}-${commodity}-`)),{report,raw}=await collectTradeBaseline(input);await mkdir(join(candidate,'raw'));for(const [path,bytes] of raw)await writeFile(join(candidate,path),bytes,{flag:'wx'});await writeFile(join(candidate,'baseline.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});await writeFile(join(candidate,'baseline.csv'),tradeBaselineCSV(report),{flag:'wx'});console.log(JSON.stringify({candidate,retained:report.records.length,gaps:report.gaps.length,status:report.status}));
 }else if(['validate','prepare'].includes(mode)){
  if(args.length!==1)throw Error('Usage: node scripts/trade-baseline.mjs validate|prepare CANDIDATE_DIRECTORY');const report=await readTradeCandidate(args[0]);if(mode==='prepare'){const draft=prepareTradeSubmission(report),path=join(resolve(args[0]),'submission-draft.json');await writeFile(path,JSON.stringify(draft,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({prepared:path,sources:draft.submission.sources.length,submission_created:false}));}else console.log(JSON.stringify({valid:true,retained:report.records.length,gaps:report.gaps.length,status:report.status}));
 }else throw Error('Choose collect or validate.');
}catch(error){console.error(error.message);process.exitCode=1;}
