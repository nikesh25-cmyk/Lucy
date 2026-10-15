// Reward provenance: what saved contribution a reward was recognised for, and who independently
// reviewed it where a review was required.
//
// Two ledgers pay a player and neither one is a mystery the player can read. A Karma Coin receipt
// names a service, a source kind and a source id, and its own note says which saved table proves it; a
// NemoCoin receipt names a task, a submission and the review that accepted it. This module resolves
// both to the rows the server itself wrote, for the signed-in operator's own rewards only, and marks
// any reward whose contribution the world no longer holds.
//
// It reads. It writes nothing, mints nothing and moves nothing: it takes no amount, no day and no
// source from the request, and it can neither create nor change a receipt.
//
// What it cannot do, stated plainly: the world legitimately forgets a source row (a tile is
// re-planted, a thanks record is deleted with its account), and a forged receipt whose source_id never
// existed is indistinguishable from an honest one whose source is gone — `verifyKarmaLedger` treats an
// absent source as legitimate and says so. So an absent contribution is **flagged**, never refused,
// and the report is refused outright only when the ledger itself does not verify, which is the case a
// receipt that names no contribution at all falls into. That gap is recorded with a reproduction in
// tests/framework/known-gaps-economy.mjs.
import { KARMA_POLICY, KARMA_SERVICES, verifyKarmaLedger } from './karma.js';
import { COIN_POLICY, verifyCoinLedger } from './coins.js';

const fail=(status,message,reason_code)=>{throw Object.assign(new Error(message),{status,reason_code});};
const SERVICE_BY_ID=new Map(KARMA_SERVICES.map((service)=>[service.id,service]));
const iso=ms=>new Date(Number(ms)).toISOString();
const party=(platform,agentId)=>platform.get('SELECT a.id AS agent_id,a.name AS agent_name,a.operator_id AS account_id,o.name AS account_name FROM agents a LEFT JOIN accounts o ON o.id=a.operator_id WHERE a.id=?',agentId||'')||{agent_id:agentId||null,agent_name:null,account_id:null,account_name:null};

/**
 * The saved table each source kind reads, mirroring the one-saved-row registry in src/karma.js. The
 * check below fails at load if the owner's own `note` for a service no longer names this table, so the
 * two lists cannot drift apart silently.
 */
export const PROVENANCE_SOURCES=Object.freeze({
 crop_plant:'journey_crops',crop_harvest:'journey_crops',home_furnish:'world_objects',craft:'audit',
 frontier_place:'frontier_blocks',shared_visit:'journey_visits',thanks:'community_thanks',
 circle_join:'community_members',project_pledge:'community_pledges',event_rsvp:'community_rsvps',
 guild_contribution:'guild_contributions',guild_participation:'guild_participants',
});
for(const service of KARMA_SERVICES){
 const table=PROVENANCE_SOURCES[service.source_kind];
 if(!table)throw new Error(`provenance: ${service.id} reads a source kind this module cannot resolve`);
 if(!service.note.includes(table))throw new Error(`provenance: ${service.id} no longer cites ${table}`);
}
const TAIL_NUMBER=/^(.*):(\d+)$/;
const HEAD_ID=/^([^:]+):(.+)$/;
const CROP_ID=/^(\d+):(\d+):(\d+)(?::harvest)?$/;

const held=(table,row_id,occurred_at,detail,counterparty=null)=>({table,row_id,held:true,occurred_at,detail,counterparty});
const gone=(table,row_id,detail=null)=>({table,row_id,held:false,occurred_at:null,detail,counterparty:null});

/**
 * Resolve one receipt's `source_kind` and `source_id` to the saved row the server wrote, by reading the
 * same table the mint registry reads. A row that is no longer there is reported as not held rather
 * than as an error: the world is allowed to forget a tile, a visit or a thanks record.
 */
export function resolveKarmaSource(platform,{source_kind,source_id,agent_id}){
 const id=String(source_id||'');
 if(source_kind==='crop_plant'||source_kind==='crop_harvest'){
  const match=CROP_ID.exec(id);
  if(!match)return gone('journey_crops',id);
  const [,x,y,planted]=match;
  const row=platform.get('SELECT x,y,kind,planted_at,harvested_at FROM journey_crops WHERE agent_id=? AND x=? AND y=? AND planted_at=?',agent_id,Number(x),Number(y),Number(planted));
  if(!row)return gone('journey_crops',id);
  const occurred=source_kind==='crop_harvest'?(row.harvested_at==null?null:iso(row.harvested_at)):iso(row.planted_at);
  return occurred?held('journey_crops',id,occurred,{kind:row.kind,x:row.x,y:row.y,planted_at:iso(row.planted_at),harvested_at:row.harvested_at==null?null:iso(row.harvested_at)}):gone('journey_crops',id);
 }
 if(source_kind==='home_furnish'){
  const row=platform.get('SELECT id,type,world_id,created_at FROM world_objects WHERE id=?',id);
  return row?held('world_objects',id,row.created_at,{type:row.type,world_id:row.world_id}):gone('world_objects',id);
 }
 if(source_kind==='craft'){
  const row=platform.get("SELECT seq,record_id,event,actor,created_at FROM audit WHERE seq=? AND event='journey.crafted'",Number(id)||-1);
  return row?held('audit',id,row.created_at,{event:row.event,resident_id:row.record_id}):gone('audit',id);
 }
 if(source_kind==='frontier_place'){
  const row=platform.get('SELECT id,plot_id,world_id,type,x,y,z,created_at FROM frontier_blocks WHERE id=?',id);
  return row?held('frontier_blocks',id,row.created_at,{plot_id:row.plot_id,world_id:row.world_id,type:row.type,x:row.x,y:row.y,z:row.z}):gone('frontier_blocks',id);
 }
 if(source_kind==='shared_visit'){
  const match=TAIL_NUMBER.exec(id);
  if(!match)return gone('journey_visits',id);
  const row=platform.get('SELECT v.world_id,v.visited_at,w.owner_agent_id,w.visibility FROM journey_visits v LEFT JOIN worlds w ON w.id=v.world_id WHERE v.agent_id=? AND v.world_id=? AND v.visited_at=?',agent_id,match[1],Number(match[2]));
  return row?held('journey_visits',id,iso(row.visited_at),{world_id:row.world_id,visibility:row.visibility},party(platform,row.owner_agent_id)):gone('journey_visits',id);
 }
 if(source_kind==='thanks'){
  const row=platform.get('SELECT id,giver_agent_id,recipient_agent_id,day,reason,created_at FROM community_thanks WHERE id=?',id);
  if(!row||row.giver_agent_id!==agent_id)return gone('community_thanks',id);
  return held('community_thanks',id,row.created_at,{day:row.day,recipient_agent_id:row.recipient_agent_id},party(platform,row.recipient_agent_id));
 }
 if(source_kind==='circle_join'){
  const match=HEAD_ID.exec(id);
  const row=match&&platform.get('SELECT m.circle_id,m.joined_at,c.creator_agent_id,c.title,c.status FROM community_members m LEFT JOIN community_circles c ON c.id=m.circle_id WHERE m.agent_id=? AND m.circle_id=? AND m.joined_at=?',agent_id,match[1],match[2]);
  return row?held('community_members',id,row.joined_at,{circle_id:row.circle_id,title:row.title,status:row.status},party(platform,row.creator_agent_id)):gone('community_members',id);
 }
 if(source_kind==='project_pledge'){
  const match=HEAD_ID.exec(id);
  const row=match&&platform.get('SELECT p.project_id,p.created_at,p.commitment,c.creator_agent_id,c.title,c.status FROM community_pledges p LEFT JOIN community_projects c ON c.id=p.project_id WHERE p.agent_id=? AND p.project_id=? AND p.created_at=?',agent_id,match[1],match[2]);
  return row?held('community_pledges',id,row.created_at,{project_id:row.project_id,title:row.title,status:row.status,commitment:row.commitment},party(platform,row.creator_agent_id)):gone('community_pledges',id);
 }
 if(source_kind==='event_rsvp'){
  const match=HEAD_ID.exec(id);
  const row=match&&platform.get('SELECT r.event_id,r.created_at,e.title,e.starts_at,e.status,e.creator_agent_id FROM community_rsvps r LEFT JOIN community_events e ON e.id=r.event_id WHERE r.agent_id=? AND r.event_id=? AND r.created_at=?',agent_id,match[1],match[2]);
  return row?held('community_rsvps',id,row.created_at,{event_id:row.event_id,title:row.title,starts_at:row.starts_at,status:row.status},party(platform,row.creator_agent_id)):gone('community_rsvps',id);
 }
 if(source_kind==='guild_contribution'){
  const row=platform.get('SELECT c.id,c.project_id,c.workstream_id,c.status,c.review_note,c.verified_at,c.verified_by_agent_id,c.verified_by_account_id,p.title,p.creator_agent_id FROM guild_contributions c LEFT JOIN guild_projects p ON p.id=c.project_id WHERE c.id=?',id);
  if(!row)return gone('guild_contributions',id);
  const resolved=held('guild_contributions',id,row.verified_at||row.status,{project_id:row.project_id,title:row.title,workstream_id:row.workstream_id,status:row.status,review_note:row.review_note},party(platform,row.creator_agent_id));
  resolved.verifier=row.verified_by_account_id?{account_id:row.verified_by_account_id,account_name:platform.get('SELECT name FROM accounts WHERE id=?',row.verified_by_account_id)?.name||null,agent_id:row.verified_by_agent_id,verified_at:row.verified_at}:null;
  return resolved;
 }
 if(source_kind==='guild_participation'){
  const match=HEAD_ID.exec(id);
  const row=match&&platform.get('SELECT g.project_id,g.joined_at,g.state,g.role,p.title,p.status,p.creator_agent_id FROM guild_participants g LEFT JOIN guild_projects p ON p.id=g.project_id WHERE g.agent_id=? AND g.project_id=? AND g.joined_at=?',agent_id,match[1],match[2]);
  return row?held('guild_participants',id,row.joined_at,{project_id:row.project_id,title:row.title,state:row.state,role:row.role,status:row.status},party(platform,row.creator_agent_id)):gone('guild_participants',id);
 }
 return gone(PROVENANCE_SOURCES[source_kind]||'unknown',id);
}

/**
 * Who independently reviewed this contribution, where a review is required. A service-to-others
 * receipt is only mintable from a row a *different* operator's side of the world holds, so the
 * counterparty operator is the reviewer; a verified guild contribution additionally names the
 * operator that verified it. A world-tier receipt is the resident's own saved labour and needs none.
 */
export function karmaReviewer(service,contribution){
 if(service.source_kind==='guild_contribution'&&contribution?.verifier){
  return{required:true,kind:'a different operator\u2019s verification of the contribution',account_id:contribution.verifier.account_id,account_name:contribution.verifier.account_name,agent_id:contribution.verifier.agent_id,at:contribution.verifier.verified_at};
 }
 if(service.requires_other_operator){
  const other=contribution?.counterparty;
  return{required:true,kind:'a different operator\u2019s side of the world recorded this act',account_id:other?.account_id||null,account_name:other?.account_name||null,agent_id:other?.agent_id||null,at:contribution?.occurred_at||null};
 }
 return{required:false,kind:'the resident\u2019s own saved world labour',account_id:null,account_name:null,agent_id:null,at:contribution?.occurred_at||null};
}

const FLAG_CODES=Object.freeze({
 contribution_not_held:'contribution_not_held',
 contribution_changed:'contribution_changed',
 review_not_held:'review_not_held',
});

/**
 * The readable provenance report for the signed-in operator: every reward of the operator's own
 * residents, resolved to the saved contribution and the independent reviewer where one was required.
 * `status` is `flagged` with named codes when a reward's saved contribution is no longer held, and the
 * report is refused outright when a reward names no contribution at all or an undefined service.
 */
export function economyProvenance(platform,actor,input={}){
 if(!actor?.account||actor.kind!=='session')fail(403,'Reward provenance is the signed-in operator\u2019s own record.');
 for(const key of Object.keys(input||{}))if(!['agent_id','reward_id'].includes(key))fail(400,'Ask about one resident or one reward at a time.');
 if(input.agent_id)platform.ownedAgent(actor,input.agent_id);
 // The report is an explanation of rewards, so it fails closed on a ledger that does not verify, the
 // same way the wallet and a spend do. A legitimately forgotten source row is not a broken ledger:
 // `verifyKarmaLedger` allows an absent source and the report flags it below. A receipt that names no
 // contribution at all cannot pass that check, so it is refused as a ledger finding rather than
 // explained.
 if(!verifyKarmaLedger(platform.db))fail(503,'The Karma ledger needs administrator inspection before its rewards can be explained.','ledger_invalid');
 const accountId=actor.account.id;
 const agents=new Map(platform.all('SELECT id,name FROM agents WHERE operator_id=?',accountId).map((row)=>[row.id,row.name]));
 const residentFilter=input.agent_id||null;
 const flags=[],rewards=[];
 const karmaReceipts=platform.all('SELECT * FROM karma_receipts WHERE account_id=? ORDER BY seq DESC LIMIT 200',accountId);
 for(const receipt of karmaReceipts){
  const service=SERVICE_BY_ID.get(receipt.service_id);
  if(!service||!PROVENANCE_SOURCES[service.source_kind])fail(503,`A Karma reward names the service ${JSON.stringify(receipt.service_id)}, which this world does not define; the ledger needs administrator inspection.`,'unknown_service');
  if(residentFilter&&receipt.agent_id!==residentFilter)continue;
  const contribution=resolveKarmaSource(platform,{source_kind:receipt.source_kind,source_id:receipt.source_id,agent_id:receipt.agent_id});
  const traceable=contribution.held&&contribution.occurred_at===receipt.source_at;
  if(!contribution.held)flags.push({reward:`karma:${receipt.id}`,code:FLAG_CODES.contribution_not_held,reason:`The saved ${contribution.table} row this reward cites (${receipt.source_id}) is no longer held by the world. The reward stands; the contribution it was recognised for can no longer be shown.`});
  else if(!traceable)flags.push({reward:`karma:${receipt.id}`,code:FLAG_CODES.contribution_changed,reason:`The saved ${contribution.table} row now records ${contribution.occurred_at}, not the ${receipt.source_at} the reward was issued from.`});
  rewards.push({
   ledger:'karma',reward_id:receipt.id,reward:`${receipt.amount} ${KARMA_POLICY.currency}`,amount:receipt.amount,currency:KARMA_POLICY.currency,unit:KARMA_POLICY.unit,
   agent_id:receipt.agent_id,agent_name:agents.get(receipt.agent_id)||null,tier:receipt.tier,day:receipt.award_day,created_at:receipt.created_at,
   service:{id:service.id,label:service.label,note:service.note},
   contribution:{table:contribution.table,row_id:contribution.row_id,held:contribution.held,occurred_at:contribution.occurred_at,source_at:receipt.source_at,detail:contribution.detail},
   reviewer:karmaReviewer(service,contribution),
   traceable,state:traceable?'traceable':contribution.held?'changed':'not_held',
  });
 }
 const hasCoins=Boolean(platform.get("SELECT name FROM sqlite_master WHERE type='table' AND name='coin_rewards'"));
 if(hasCoins&&!verifyCoinLedger(platform.db))fail(503,'The NemoCoin ledger needs administrator inspection before its rewards can be explained.','coin_ledger_invalid');
 const coinReceipts=hasCoins?platform.all('SELECT r.* FROM coin_rewards r JOIN agents a ON a.id=r.agent_id WHERE r.account_id=? ORDER BY r.seq DESC LIMIT 200',accountId):[];
 for(const receipt of coinReceipts){
  if(residentFilter&&receipt.agent_id!==residentFilter)continue;
  const submission=platform.get('SELECT s.id,s.status,s.version,s.created_at,c.task_id,t.title AS task_title,t.mission_id,m.title AS mission_title,m.owner_id FROM submissions s LEFT JOIN claims c ON c.id=s.claim_id LEFT JOIN tasks t ON t.id=c.task_id LEFT JOIN missions m ON m.id=t.mission_id WHERE s.id=?',receipt.submission_id);
  const review=platform.get('SELECT r.id,r.decision,r.reason,r.created_at,r.reviewer_id,o.name AS reviewer_name,o.role AS reviewer_role FROM reviews r LEFT JOIN accounts o ON o.id=r.reviewer_id WHERE r.id=?',receipt.review_id);
  const traceable=Boolean(submission)&&Boolean(review);
  if(!traceable)flags.push({reward:`coins:${receipt.id}`,code:FLAG_CODES.review_not_held,reason:'The submission or the acceptance this reward cites is no longer held, so the reviewer cannot be shown.'});
  rewards.push({
   ledger:'coins',reward_id:receipt.id,reward:`${receipt.amount} ${COIN_POLICY.currency}`,amount:receipt.amount,currency:COIN_POLICY.currency,unit:COIN_POLICY.unit,
   agent_id:receipt.agent_id,agent_name:agents.get(receipt.agent_id)||null,day:receipt.award_day,created_at:receipt.created_at,
   service:{id:'accepted_contribution',label:'One independently accepted contribution',note:'A submission the server already recorded, accepted by an independent reviewer who is neither the contributor nor the mission owner.'},
   contribution:{table:'submissions',row_id:receipt.submission_id,held:Boolean(submission),occurred_at:submission?.created_at||null,source_at:submission?.created_at||null,detail:submission?{status:submission.status,version:submission.version,task_id:submission.task_id,task_title:submission.task_title,mission_id:submission.mission_id,mission_title:submission.mission_title}:null},
   reviewer:{required:true,kind:'an independent human review of the contribution',account_id:review?.reviewer_id||null,account_name:review?.reviewer_name||null,agent_id:null,at:review?.created_at||null,decision:review?.decision||null,reason:review?.reason||null,review_id:review?.id||null},
   traceable,state:traceable?'traceable':'not_held',
  });
 }
 const selected=input.reward_id?rewards.filter((reward)=>reward.reward_id===input.reward_id):rewards;
 if(input.reward_id&&!selected.length)fail(404,'No reward of yours has that identifier; provenance is readable only for the operator whose purse holds the reward.','reward_not_found');
 const relevant=input.reward_id?flags.filter((flag)=>flag.reward===`${selected[0].ledger}:${selected[0].reward_id}`):flags;
 const coinsHeld=hasCoins?platform.get('SELECT COALESCE(SUM(amount),0) AS n FROM coin_rewards WHERE account_id=?',accountId).n:0;
 return{
  account_id:accountId,agent_id:residentFilter,generated_at:new Date(platform.clock()).toISOString(),server_time:platform.clock(),
  policy:{
   reads:'The operator\u2019s own rewards only, resolved to the rows the server itself wrote. This report writes, mints, moves and converts nothing.',
   karma:KARMA_POLICY.sentence,nemocoin:COIN_POLICY.description,separation:'Karma Coins and NemoCoins are separate units and are never counted for one another.',
   absence:'The world is allowed to forget a source row, so a contribution that is no longer held is flagged rather than treated as a forged reward; a reward that names no contribution at all is refused.',
  },
  rewards:selected,reward_count:selected.length,
  flagged:relevant,flagged_count:relevant.length,
  status:relevant.length?'flagged':'ok',
  ledger:{karma_receipts_count:karmaReceipts.length,coin_receipts_count:coinReceipts.length,karma_balance:platform.get('SELECT (SELECT COALESCE(SUM(amount),0) FROM karma_receipts WHERE account_id=?)-(SELECT COALESCE(SUM(amount),0) FROM karma_purchases WHERE account_id=?) AS n',accountId,accountId).n,coin_balance:coinsHeld},
  flag_codes:FLAG_CODES,
 };
}
export const provenanceMethods={economyProvenance(actor,input={}){return economyProvenance(this,actor,input);}};
