const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const human=actor=>{if(actor?.kind!=='session')fail(403,'Drafts require the human operator session.');};
export const DRAFT_SCHEMA=`CREATE TABLE IF NOT EXISTS claim_drafts(claim_id TEXT PRIMARY KEY REFERENCES claims(id),content TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,updated_ms INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,resumed_from TEXT REFERENCES claims(id));`;
export function normalizeDraft(input){
 if(!input||!['evidence-form-v1','decision-brief-form-v1'].includes(input.format)||!input.values||typeof input.values!=='object'||Array.isArray(input.values))fail(400,'Provide a supported draft form.');
 const structured=input.format==='decision-brief-form-v1';
 const base=structured?/^(title|recipient|requested_decision|beneficiaries|problem|recommended_option|recommendation_reason|include_costs|currency|precision|quantity_kg|evidence_gaps|method|limitations|rights)$/:/^(artifact|method|limitations|rights)$/;
 const repeated=structured?/^(source_[0-9]_(url|location|date)|finding_[0-5]_(text|sources|qualification)|option_[0-3]_(title|action|owner|cost_basis|dependencies|risks)|milestone_[0-5]_(deliverable|owner|timing|measure)|cost_[0-9]_(item|basis|amount|source|date|assumption))$/:/^(url|location|date)_[0-9]$/;
 const values={};const entries=Object.entries(input.values);if(entries.length>200)fail(400,'Draft has too many fields.');
 for(const [key,value] of entries){if(!base.test(key)&&!repeated.test(key)||typeof value!=='string'||value.length>(key==='artifact'?16000:3000))fail(400,'Draft contains an unsupported or oversized field.');values[key]=value;}
 const counts={};if(structured){for(const [key,min,max] of [['sources',1,10],['findings',1,6],['options',2,4],['milestones',1,6],['costs',1,10]]){const value=input.counts?.[key];if(!Number.isInteger(value)||value<min||value>max)fail(400,'Invalid decision brief draft field counts.');counts[key]=value;}}
 const content={format:input.format,values,...(structured?{counts}:{})};if(JSON.stringify(content).length>32000)fail(400,'Draft exceeds 32,000 characters.');return content;
}
export const draftMethods={
 drafts(actor,{archived=false,all=false}={}){
  human(actor);return this.all(`SELECT d.*,c.task_id,c.agent_id,c.status AS claim_status,c.task_version,t.version AS current_task_version,t.title AS task_title,t.status AS task_status FROM claim_drafts d JOIN claims c ON c.id=d.claim_id JOIN tasks t ON t.id=c.task_id WHERE c.account_id=?${archived?'':' AND d.archived=0'} ORDER BY d.updated_ms DESC${all?'':' LIMIT 200'}`,actor.account.id).map(({content,updated_ms,...row})=>({...row,content:JSON.parse(content)}));
 },
 draftSave(actor,input){
  human(actor);this.active();this.expireClaims();const claim=this.ownedClaim(actor,input.claim_id);
  if(!['leased','changes_requested','expired','released'].includes(claim.status))fail(409,'This claim already has a submitted decision; its saved draft is read-only.');
  const task=this.get('SELECT version FROM tasks WHERE id=?',claim.task_id);if(task.version!==claim.task_version)fail(409,'The task requirements changed. Keep this draft and review the current task.');
  const row=this.get('SELECT * FROM claim_drafts WHERE claim_id=?',claim.id),revision=input.expected_revision;
  if(!Number.isInteger(revision)||revision<0||revision!==(row?.revision||0))fail(409,'The saved draft changed in another view. Refresh before saving again.');
  if(row?.archived)fail(409,'Restore the archived draft before editing.');
  if(row&&JSON.parse(row.content).format!==input.format)fail(409,'A saved draft keeps its original form type. Use a new claim for another form.');
  const content=JSON.stringify(normalizeDraft(input));if(row?.content===content)return {claim_id:claim.id,revision:row.revision,updated_at:row.updated_at};
  if(row&&this.clock()-row.updated_ms<500)fail(429,'Draft saves are too close together. Retry in a moment.');
  if(!row&&this.get('SELECT COUNT(*) AS n FROM claim_drafts d JOIN claims c ON c.id=d.claim_id WHERE c.account_id=? AND d.archived=0',actor.account.id).n>=200)fail(429,'Your capacity is 200 active drafts. Archive existing work before starting more drafts.');
  const date=new Date(this.clock()).toISOString();
  this.run('INSERT INTO claim_drafts(claim_id,content,revision,updated_at,updated_ms) VALUES(?,?,?,?,?) ON CONFLICT(claim_id) DO UPDATE SET content=excluded.content,revision=excluded.revision,updated_at=excluded.updated_at,updated_ms=excluded.updated_ms',claim.id,content,revision+1,date,this.clock());this.audit(actor.account.id,'draft.saved',claim.id);return {claim_id:claim.id,revision:revision+1,updated_at:date};
 },
 draftArchive(actor,input){
  human(actor);this.ownedClaim(actor,input.claim_id);if(!this.get('SELECT claim_id FROM claim_drafts WHERE claim_id=?',input.claim_id))fail(404,'Draft not found.');
  if(typeof input.archived!=='boolean')fail(400,'Choose whether the draft is archived.');if(!input.archived&&this.get('SELECT archived FROM claim_drafts WHERE claim_id=?',input.claim_id).archived&&this.get('SELECT COUNT(*) AS n FROM claim_drafts d JOIN claims c ON c.id=d.claim_id WHERE c.account_id=? AND d.archived=0',actor.account.id).n>=200)fail(429,'Archive an active draft before restoring another.');this.run('UPDATE claim_drafts SET archived=? WHERE claim_id=?',input.archived?1:0,input.claim_id);this.audit(actor.account.id,input.archived?'draft.archived':'draft.restored',input.claim_id);return {archived:input.archived};
 },
 draftResume(actor,input,key){
  human(actor);if(typeof key!=='string'||!key.trim()||key.length>100)fail(400,'Provide an idempotency key.');this.active();this.expireClaims();const old=this.ownedClaim(actor,input.claim_id),row=this.get('SELECT * FROM claim_drafts WHERE claim_id=?',old.id);if(!row)fail(404,'Saved draft not found.');
  const previous=this.get('SELECT id FROM claims WHERE account_id=? AND idempotency_key=?',actor.account.id,key);
  if(previous){const copy=this.get('SELECT resumed_from FROM claim_drafts WHERE claim_id=?',previous.id);if(copy?.resumed_from!==old.id)fail(409,'This key belongs to another claim.');return {claim:this.ownedClaim(actor,previous.id),draft:this.drafts(actor,{archived:true,all:true}).find(draft=>draft.claim_id===previous.id)};}
  if(!['expired','released'].includes(old.status))fail(409,'Only expired or released research can be reclaimed.');
  const task=this.get('SELECT version FROM tasks WHERE id=?',old.task_id);if(task.version!==old.task_version)fail(409,'The task requirements changed. Review them before reusing old research.');
  if(row.archived&&this.get('SELECT COUNT(*) AS n FROM claim_drafts d JOIN claims c ON c.id=d.claim_id WHERE c.account_id=? AND d.archived=0',actor.account.id).n>=200)fail(429,'Archive an active draft before resuming another.');
  const claim=this.claim(actor,{task_id:old.task_id,agent_id:input.agent_id===null?null:input.agent_id||old.agent_id},key);
  this.run('INSERT INTO claim_drafts(claim_id,content,revision,updated_at,updated_ms,resumed_from) VALUES(?,?,?,?,?,?)',claim.id,row.content,1,new Date(this.clock()).toISOString(),this.clock(),old.id);this.run('UPDATE claim_drafts SET archived=1 WHERE claim_id=?',old.id);this.audit(actor.account.id,'draft.resumed',claim.id);return {claim,draft:this.drafts(actor).find(draft=>draft.claim_id===claim.id)};
 },
};
