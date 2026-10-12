const stages={
 authorization:['Permission check','Check the world pause state and the agent’s read/contribute permissions.'],
 task:['Task selection','Open the mission and check task availability and approved source hosts.'],
 claim:['Task claim','Check your active claims and whether another contributor holds this task.'],
 source:['Source retrieval','Check the selected source’s availability, format and approved host before retrying.'],
 model:['Local synthesis','Check local model availability and the required brief format, citations and unknown costs.'],
 submission:['Submission','Check contribution history before retrying: the server may have received work before the response was interrupted.'],
 job_record:['Run recording','Check contribution history: evidence may have been submitted before run recording stopped.'],
 unknown:['Worker execution','Check contributions, active claims, permissions and source availability before retrying.']
};
const sourceProblems={
 access_check:['Source access check','The response is a recognized access-check page, not research evidence. Review the official source in a browser or choose another approved primary source. Do not retry automatically or treat challenge text as a finding.'],
 access_denied:['Source access denied','The source refused access. Check its published access conditions or choose another approved primary source; no evidence was retrieved from this source.'],
 rate_limited:['Source rate limit','The source reported a rate limit. Wait and review provider access conditions before a deliberate retry; repeated automatic retries will not establish evidence.'],
 unreadable:['Unreadable source','The response contained no extractable source text. Review its format and accessibility or choose another approved primary source; do not infer substantive findings from the gap.']
};
export function sourceFailureProblem(error){
 if(error?.sourceStatus===403)return 'access_denied';
 if(error?.sourceStatus===429)return 'rate_limited';
 return typeof error?.sourceProblem==='string'&&Object.hasOwn(sourceProblems,error.sourceProblem)?error.sourceProblem:null;
}
const marker='LUCY_RESEARCH_FAILURE_V1\n';
export function researchFailureDetail({taskId,stage='unknown',sourceNumber=null,claimState='unconfirmed',cancelled=false,sourceProblem=null}={}){
 if(typeof taskId!=='string'||!taskId||taskId.length>200)throw Error('A bounded task identifier is required.');
 if(!Object.hasOwn(stages,stage))stage='unknown';
 if(!['not_claimed','released','unconfirmed'].includes(claimState))claimState='unconfirmed';
 sourceNumber=stage==='source'&&Number.isInteger(sourceNumber)&&sourceNumber>=1&&sourceNumber<=5?sourceNumber:null;
 return marker+JSON.stringify({task_id:taskId,stage,source_number:sourceNumber,claim_state:claimState,cancelled:cancelled===true,...(stage==='source'&&typeof sourceProblem==='string'&&Object.hasOwn(sourceProblems,sourceProblem)?{source_problem:sourceProblem}:{})});
}
export function parseResearchFailure(detail){
 if(typeof detail!=='string'||!detail.startsWith(marker)||detail.length>1000)return null;
 try{const value=JSON.parse(detail.slice(marker.length));if(researchFailureDetail({taskId:value.task_id,stage:value.stage,sourceNumber:value.source_number,claimState:value.claim_state,cancelled:value.cancelled,sourceProblem:value.source_problem})!==detail)return null;
 const [label,action]=value.source_problem?sourceProblems[value.source_problem]:stages[value.stage];return {...value,label,action,claim_note:value.claim_state==='released'?'Claim release confirmed.':value.claim_state==='not_claimed'?'No claim was obtained.':'Claim release is unconfirmed. Check active claims; lease expiry still applies.'};}catch{return null;}
}
