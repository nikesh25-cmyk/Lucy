// Shared validation and deterministic rendering for human/agent decision briefs.
export const BRIEF_MARKER='LUCY DECISION BRIEF v1\n';
const invalid=message=>{throw Object.assign(new Error(message),{status:400});};
const string=(value,label,max=1000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)invalid(`${label} needs 1–${max} characters.`);return value.trim();};
const list=(value,label,min,max)=>{if(!Array.isArray(value)||value.length<min||value.length>max)invalid(`${label} needs ${min}–${max} entries.`);return value;};
const reference=(value,count,required=false)=>{
 if(value==null&&!required)return null;if(!Number.isInteger(value)||value<1||value>count)invalid('Brief source references must identify submitted sources.');return value;
};
function amount(value,precision){
 if(typeof value!=='string'||!new RegExp(`^(?:0|[1-9]\\d{0,9})${precision?`(?:\\.\\d{1,${precision}})?`:''}$`).test(value))invalid('Cost amounts need a nonnegative decimal string within the selected precision.');
 const [whole,fraction='']=value.split('.');return Number(whole)*10**precision+Number(fraction.padEnd(precision,'0'));
}
export function formatAmount(minor,precision){const value=BigInt(minor),factor=10n**BigInt(precision);return String(value/factor)+(precision?'.'+String(value%factor).padStart(precision,'0'):'');}
export function normalizeCostScenario(input,sourceCount){
 if(input==null)return null;
 const currency=string(input.currency,'Scenario currency',3);if(!/^[A-Z]{3}$/.test(currency))invalid('Use a three-letter currency code.');
 const precision=input.precision??2;if(![0,2,3].includes(precision))invalid('Choose zero, two or three decimal costing precision.');
 const quantity=input.quantity_kg??null;if(quantity!==null&&(typeof quantity!=='number'||!Number.isFinite(quantity)||quantity<0.001||quantity>1e9||!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(String(quantity))))invalid('Shipment quantity needs 0.001–1,000,000,000 kg with at most three decimals, or unknown.');
 const rows=list(input.rows,'Cost register',1,10).map(row=>{
   if(!['official','quote','estimate','unknown'].includes(row.basis))invalid('Choose official, quote, estimate or unknown for each cost.');
   const unknown=row.basis==='unknown';if(unknown&&row.amount!==null&&row.amount!==undefined&&row.amount!=='')invalid('Unknown cost amounts must remain missing.');
   const minor=unknown?null:amount(row.amount,precision);
   return {item:string(row.item,'Cost item',100),basis:row.basis,amount:minor===null?null:formatAmount(minor,precision),minor_units:minor,source_number:reference(row.source_number,sourceCount,['official','quote'].includes(row.basis)),as_of:string(row.as_of||'Not established','Cost date or period',100),assumption:string(row.assumption,'Cost basis or missing evidence',500)};
 });
 const grams=quantity===null?null:BigInt(String(quantity).split('.')[0])*1000n+BigInt((String(quantity).split('.')[1]||'').padEnd(3,'0'));
 const known=rows.reduce((sum,row)=>sum+(row.minor_units??0),0),missing=rows.filter(row=>row.minor_units===null).length;
 if(!Number.isSafeInteger(known))invalid('Cost subtotal exceeds supported precision.');
 return {currency,precision,quantity_kg:quantity,rows,known_subtotal:formatAmount(known,precision),known_subtotal_minor:known,unknown_count:missing,total:missing?null:formatAmount(known,precision),cost_per_kg:missing||quantity===null?null:formatAmount((BigInt(known)*2000n+grams)/(2n*grams),precision),limitations:'User-entered planning scenario in one currency. No exchange rates, taxes, missing charges, demand, revenue or return are inferred. Source-backed categories are contributor declarations requiring review. Decimal precision is a costing assumption; confirm currency conventions. A known subtotal excludes every unknown item.'};
}
export function normalizeDecisionBrief(input,{sourceCount=10}={}){
 if(!input||typeof input!=='object'||Array.isArray(input))invalid('Provide a decision brief object.');
 const findings=list(input.findings,'Cited findings',1,6).map(finding=>({text:string(finding.text,'Finding',1000),source_numbers:[...new Set(list(finding.source_numbers,'Finding sources',1,10).map(value=>reference(value,sourceCount,true)))],qualification:string(finding.qualification,'Finding qualification',500)}));
 const options=list(input.options,'Decision options',2,4).map(option=>({title:string(option.title,'Option title',100),action:string(option.action,'Proposed action',1000),owner:string(option.owner,'Proposed responsible role',200),cost_basis:string(option.cost_basis,'Cost basis and uncertainty',500),dependencies:string(option.dependencies,'Prerequisites',500),risks:string(option.risks,'Risks and limitations',500)}));
 const choice=input.recommended_option;if(!Number.isInteger(choice)||choice<1||choice>options.length)invalid('Select a listed recommendation option.');
 return {schema_version:1,title:string(input.title,'Brief title',120),recipient:string(input.recipient,'Proposed recipient',200),requested_decision:string(input.requested_decision,'Requested decision',1000),beneficiaries:string(input.beneficiaries,'Intended beneficiaries',1000),problem:string(input.problem,'Problem and geographic scope',1500),findings,options,recommended_option:choice,recommendation_reason:string(input.recommendation_reason,'Recommendation rationale',1000),milestones:list(input.milestones,'Delivery milestones',1,6).map(item=>({deliverable:string(item.deliverable,'Milestone deliverable',500),owner:string(item.owner,'Proposed milestone owner',200),timing:string(item.timing,'Proposed timing',100),measure:string(item.measure,'Verification measure',500)})),evidence_gaps:string(input.evidence_gaps,'Unresolved evidence',2000),cost_scenario:normalizeCostScenario(input.cost_scenario,sourceCount),status:'proposed_for_independent_review',boundary:'Proposed recipient, roles, costs and timing do not establish consent, commitment, funding, shipment approval or external adoption.'};
}
export function serializeDecisionBrief(brief){const value=BRIEF_MARKER+JSON.stringify(brief);if(value.length>16000)invalid('Decision brief exceeds the 16,000-character submission limit.');return value;}
export function storedDecisionBrief(artifact,sourceCount){
 if(typeof artifact!=='string'||!artifact.startsWith(BRIEF_MARKER))return null;
 try{return normalizeDecisionBrief(JSON.parse(artifact.slice(BRIEF_MARKER.length)),{sourceCount});}catch{return null;}
}
export function decisionBriefText(brief){
 const sections=[brief.title,'PROPOSED DECISION BRIEF · INDEPENDENT REVIEW REQUIRED',`Recipient: ${brief.recipient}`,`Requested decision: ${brief.requested_decision}`,`Beneficiaries: ${brief.beneficiaries}`,`Problem: ${brief.problem}`,'FINDINGS',...brief.findings.map(item=>`${item.text} ${item.source_numbers.map(number=>`[Source ${number}]`).join(' ')}\nQualification: ${item.qualification}`),'OPTIONS',...brief.options.map((item,index)=>`${index+1}. ${item.title}\nAction: ${item.action}\nProposed role: ${item.owner}\nCost basis: ${item.cost_basis}\nPrerequisites: ${item.dependencies}\nRisks: ${item.risks}`),`RECOMMENDATION: option ${brief.recommended_option}\n${brief.recommendation_reason}`,'MILESTONES',...brief.milestones.map(item=>`${item.deliverable}\nProposed role: ${item.owner}; timing: ${item.timing}\nVerification: ${item.measure}`),`EVIDENCE GAPS\n${brief.evidence_gaps}`];
 if(brief.cost_scenario){const cost=brief.cost_scenario;sections.push('COST SCENARIO',`Currency: ${cost.currency}; costing precision: ${cost.precision}; quantity: ${cost.quantity_kg??'unknown'} kg`,...cost.rows.map(row=>`${row.item}: ${row.amount??'UNKNOWN'} ${cost.currency} (${row.basis}); date: ${row.as_of}; ${row.source_number?`[Source ${row.source_number}] `:''}${row.assumption}`),`Known subtotal: ${cost.known_subtotal} ${cost.currency}; unknown items: ${cost.unknown_count}`,`Total: ${cost.total??'INCOMPLETE'}; cost/kg: ${cost.cost_per_kg??'NOT ESTABLISHED'}`,cost.limitations);}
 return [...sections,brief.boundary].join('\n\n');
}
