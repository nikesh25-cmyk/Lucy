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
const marker='LUCY_RESEARCH_FAILURE_V1\n';
export function researchFailureDetail({taskId,stage='unknown',sourceNumber=null,claimState='unconfirmed',cancelled=false}={}){
 if(typeof taskId!=='string'||!taskId||taskId.length>200)throw Error('A bounded task identifier is required.');
 if(!Object.hasOwn(stages,stage))stage='unknown';
 if(!['not_claimed','released','unconfirmed'].includes(claimState))claimState='unconfirmed';
 sourceNumber=stage==='source'&&Number.isInteger(sourceNumber)&&sourceNumber>=1&&sourceNumber<=5?sourceNumber:null;
 return marker+JSON.stringify({task_id:taskId,stage,source_number:sourceNumber,claim_state:claimState,cancelled:cancelled===true});
}
export function parseResearchFailure(detail){
 if(typeof detail!=='string'||!detail.startsWith(marker)||detail.length>1000)return null;
 try{const value=JSON.parse(detail.slice(marker.length));if(researchFailureDetail({taskId:value.task_id,stage:value.stage,sourceNumber:value.source_number,claimState:value.claim_state,cancelled:value.cancelled})!==detail)return null;
 const [label,action]=stages[value.stage];return {...value,label,action,claim_note:value.claim_state==='released'?'Claim release confirmed.':value.claim_state==='not_claimed'?'No claim was obtained.':'Claim release is unconfirmed. Check active claims; lease expiry still applies.'};}catch{return null;}
}
