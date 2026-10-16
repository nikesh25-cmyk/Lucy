// Human evidence assessments are retained in the existing version-specific review record.
// A checked citation is a reviewer declaration, not an automated fact check.
//
// This module also holds the pure half of the reviewer workbench: the one state model a reviewer
// reads, the comparison between the version a submission cited and the current version of that same
// source, the composed changes-requested instruction, and the composed adoption declaration. Every
// one of them is text or data derived from rows the platform already stores, so none of them needs a
// table, a column or a writer of its own.
export const ASSESSMENT_RESULTS = [
  {value:'not_checked',label:'Not checked'},
  {value:'supported',label:'Supported within the stated scope'},
  {value:'uncertain',label:'Support or applicability uncertain'},
  {value:'unsupported',label:'Source does not support the finding'},
  {value:'contradicted',label:'Source contradicts the finding'},
];
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const note = (value, label, max = 800, optional = false) => {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} requires 1–${max} characters.`);
  return value.trim();
};

// ---- The one submission state a reviewer reads -------------------------------------------------
// pending / accepted / held / adopted are never inferred from each other. A quarantined version
// reads `held`: the acceptance record and the issued receipt are retained unchanged, and only the
// current availability changes. `adopted` is a separate, recorded declaration by the mission owner.
const STATE_LABELS = Object.freeze({
  pending:'Pending review',
  changes_requested:'Changes requested',
  accepted:'Accepted',
  held:'Held — quarantined',
  adopted:'Accepted and adopted',
  rejected:'Rejected',
});
const STATE_NOTES = Object.freeze({
  pending:'This version is waiting for an independent human review. Nothing is accepted and no coin is issued yet.',
  changes_requested:'The reviewer asked for specific changes to this version. The task is back with the contributor and nothing is accepted yet.',
  accepted:'An independent human reviewer accepted this exact version. Acceptance is a contribution review, not factual certification or adoption.',
  held:'This version is quarantined. The acceptance record and any issued coin receipt are retained exactly as they were; current availability is held until the evidence is available again. No history is rewritten.',
  adopted:'This exact version was accepted by an independent reviewer and the mission owner has recorded a use of it. The adoption is a recorded declaration with its own supporting evidence, not proof of implementation, institutional endorsement or a real-world outcome.',
  rejected:'The reviewer rejected this version. The task was returned to the open board and no coin was issued.',
});
export const SUBMISSION_STATES = Object.freeze(Object.keys(STATE_LABELS));
/** The unambiguous state of one submission version, from its stored status and recorded adoptions. */
export function submissionState(status, adopted = false) {
  const value = status === 'quarantined' ? 'held'
    : status === 'pending_review' ? 'pending'
    : status === 'changes_requested' ? 'changes_requested'
    : status === 'rejected' ? 'rejected'
    : status === 'accepted' ? (adopted ? 'adopted' : 'accepted')
    : 'pending';
  return { value, label: STATE_LABELS[value], note: STATE_NOTES[value], adopted: Boolean(adopted), quarantined: status === 'quarantined' };
}

// ---- The cited version against the current version of the same source --------------------------
// A reviewer must be able to compare what the contribution actually cited with what the library now
// holds. The comparison never edits either version: it names the differences and says which one the
// citation is pinned to.
const COMPARED_FIELDS = Object.freeze([['sha256','content hash'],['bytes','retained bytes'],['retrieved_at','retrieval time'],['declared_date','source-declared date'],['unit','unit'],['title','title'],['locator','supporting location']]);
export function citationComparison(cited, current, state = 'captured') {
  if (!cited) return { state, cited_sha256: null, current_sha256: current?.sha256 || null, same_version: false, newer_version_available: Boolean(current), changed_fields: [], differences: [], summary: 'No exact version is pinned to this citation, so there is no stored version to compare. A saved link alone is not verified evidence.' };
  const newer = Boolean(current && current.sha256 !== cited.sha256);
  const differences = newer ? COMPARED_FIELDS.filter(([field]) => String(cited[field] ?? '') !== String(current[field] ?? '')).map(([field, label]) => ({ field, label, cited: cited[field] ?? '', current: current[field] ?? '' })) : [];
  const summary = newer
    ? `A newer version of this source is retained than the one cited. The cited version (${cited.sha256.slice(0, 12)}…) is unchanged and stays what the contribution supports; the current version is ${current.sha256.slice(0, 12)}…${differences.length ? `. It differs in: ${differences.map((entry) => entry.label).join(', ')}.` : '.'}`
    : `The cited version is the current version of this source (${cited.sha256.slice(0, 12)}…); no newer capture is retained.`;
  return { state, cited_sha256: cited.sha256, current_sha256: current?.sha256 || null, same_version: !newer, newer_version_available: newer, changed_fields: differences.map((entry) => entry.field), differences, summary };
}

// ---- Changes requested with an instruction the contributor can act on --------------------------
const CHANGES_LIMIT = 10, CHANGE_MAX = 800;
/** Compose the reviewer's requested changes into the version-specific review record. */
export function requestedChangesReason(reason, changes) {
  const items = Array.isArray(changes) ? changes.map((item) => {
    if (typeof item !== 'string' || !item.trim() || item.length > CHANGE_MAX) fail(`Each requested change needs 1–${CHANGE_MAX} characters.`);
    return item.trim();
  }) : [];
  if (!items.length) return { reason, items };
  if (items.length > CHANGES_LIMIT) fail(`Request at most ${CHANGES_LIMIT} changes in one review.`);
  return { reason: [reason, 'REQUESTED CHANGES — THIS SUBMISSION VERSION', items.map((item, index) => `${index + 1}. ${item}`).join('\n'), 'Submit a corrected version against this same claim; the whole list belongs to this version only.'].join('\n\n'), items };
}
/** The requested changes a contributor reads back, parsed from the stored review record. */
export function storedRequestedChanges(reason) {
  const marker = 'REQUESTED CHANGES — THIS SUBMISSION VERSION';
  const text = typeof reason === 'string' ? reason : '';
  const at = text.indexOf(marker);
  if (at < 0) return [];
  return text.slice(at + marker.length).split('\n\n')[1]?.split('\n').map((line) => line.replace(/^\d+\.\s*/, '').trim()).filter(Boolean) || [];
}

// ---- The adoption declaration ------------------------------------------------------------------
// Adoption is the mission owner's own recorded declaration. Storing the declaration as readable
// text mirrors how a human assessment is retained, so no schema change is needed to carry it.
export const ADOPTION_BOUNDARY = 'This is a recorded declaration by the mission owner with the supporting evidence above. It is not proof that the work was implemented, not an institutional endorsement and not evidence of a real-world outcome, and it approves no budget, appointment or shipment.';
export function adoptionDeclaration(use, evidence) {
  const supporting = note(evidence, 'Supporting evidence', 400, true);
  return ['DOCUMENTED ADOPTION — MISSION OWNER DECLARATION', `Where and how the work was used: ${note(use, 'Documented use', 1200)}`, `Supporting evidence: ${supporting || 'none recorded with this declaration.'}`, ADOPTION_BOUNDARY].join('\n\n');
}
/** The note and supporting evidence as the mission owner recorded them, read back for display. */
export function storedAdoption(declaration) {
  const text = typeof declaration === 'string' ? declaration : '';
  if (!text.startsWith('DOCUMENTED ADOPTION — MISSION OWNER DECLARATION')) return { note: text, evidence: '', declaration_only: false };
  const field = (label) => text.split('\n\n').find((part) => part.startsWith(`${label}: `))?.slice(label.length + 2).trim() || '';
  const evidence = field('Supporting evidence');
  return { note: field('Where and how the work was used'), evidence: evidence === 'none recorded with this declaration.' ? '' : evidence, declaration_only: true };
}
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
