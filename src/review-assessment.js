// Human evidence assessments are retained in the existing version-specific review record.
// A checked citation is a reviewer declaration, not an automated fact check.
export const ASSESSMENT_RESULTS = [
  {value:'not_checked',label:'Not checked'},
  {value:'supported',label:'Supported within the stated scope'},
  {value:'uncertain',label:'Support or applicability uncertain'},
  {value:'unsupported',label:'Source does not support the finding'},
  {value:'contradicted',label:'Source contradicts the finding'},
];
const fail = message => {throw Object.assign(new Error(message),{status:400});};
const note = (value,label,max=800) => {
  if(typeof value!=='string'||!value.trim()||value.length>max)fail(`${label} requires 1–${max} characters.`);
  return value.trim();
};
export function assessmentReason(reason,input,brief,decision){
  const explanation=note(reason,'Review explanation',2000);
  if(input==null)return explanation;
  if(!brief)fail('Finding assessments require a structured decision brief.');
  if(!Array.isArray(input.findings)||input.findings.length!==brief.findings.length)fail('Assess every finding in this submission version.');
  const entries=input.findings.map((entry,index)=>{
    if(!entry||entry.finding_number!==index+1||!ASSESSMENT_RESULTS.some(result=>result.value===entry.result))fail(`Invalid assessment for finding ${index+1}.`);
    const checked=entry.checked_source_numbers;
    if(!Array.isArray(checked)||checked.length>brief.findings[index].source_numbers.length||new Set(checked).size!==checked.length||checked.some(number=>!Number.isInteger(number)||!brief.findings[index].source_numbers.includes(number)))fail(`Checked sources for finding ${index+1} must be its cited source numbers.`);
    if(entry.result==='not_checked'&&checked.length)fail(`Finding ${index+1} cannot list checked sources while marked not checked.`);
    if(entry.result!=='not_checked'&&!checked.length)fail(`Record the source checked for finding ${index+1}.`);
    if(decision==='accepted'&&entry.result!=='supported')fail(`Finding ${index+1} needs corrections or further checking before accepting this assessment.`);
    const label=ASSESSMENT_RESULTS.find(result=>result.value===entry.result).label;
    return `Finding ${index+1}: ${label}.\nChecked sources: ${checked.length?checked.map(number=>`[Source ${number}]`).join(', '):'None'}.\nAssessment: ${note(entry.notes,`Finding ${index+1} explanation`)}`;
  });
  const scope=note(input.scope_notes,'Applicability assessment');
  const rights=note(input.rights_notes,'Attribution and permissions assessment');
  const costs=brief.cost_scenario?note(input.cost_notes,'Cost assumptions assessment'):'';
  return [explanation,'HUMAN EVIDENCE ASSESSMENT — THIS SUBMISSION VERSION',...entries,`Applicability: ${scope}`,`Attribution and permissions: ${rights}`,...(costs?[`Cost assumptions: ${costs}`]:[]),'Recorded reviewer judgments; no recipient consent, funding, shipment authorization, or independent factual certification is implied.'].join('\n\n');
}
