const fail=message=>{throw Object.assign(new Error(message),{status:400});};
const integer=(value,fallback,max,label)=>{if(value===undefined||value==='')return fallback;const number=Number(value);if(!Number.isInteger(number)||number<0||number>max)fail(`Invalid ${label}.`);return number;};
export function missionDirectory(platform,actor,options){
 const limit=integer(options.limit,12,48,'mission page size');if(!limit)fail('Mission page size must be positive.');const offset=integer(options.offset,0,100000,'mission offset'),q=String(options.q||'').trim();if(q.length>100)fail('Mission search is too long.');
 const args=[],clauses=["(m.status<>'draft' OR ?=1 OR m.owner_id=? OR m.reviewer_id=?)"],human=actor?.kind==='session',id=human?actor.account.id:'';args.push(human&&actor.account.role==='admin'?1:0,id,id);
 if(options.status){if(!['draft','open','paused','closed','demo'].includes(options.status))fail('Choose a listed mission status.');clauses.push('m.status=?');args.push(options.status);}
 if(options.area){if(!['Climate','Peace','Accessibility','Agriculture','Health','Education','Water','Energy','Trade','Governance','Biodiversity','Development'].includes(options.area))fail('Choose a listed mission area.');clauses.push('m.area=?');args.push(options.area);}
 if(options.mine&&options.mine!=='0'){if(options.mine!=='1'||!human)fail('My missions requires a human session.');clauses.push('(m.owner_id=? OR m.reviewer_id=?)');args.push(id,id);}
 if(options.country){if(!/^[A-Z]{2}$/.test(options.country))fail('Choose a country code.');clauses.push('EXISTS(SELECT 1 FROM research_leads l WHERE l.mission_id=m.id AND l.country_code=?)');args.push(options.country);}
 if(options.goal){const goal=integer(options.goal,0,17,'SDG');if(!goal)fail('Choose an SDG from 1 to 17.');clauses.push('EXISTS(SELECT 1 FROM research_leads l WHERE l.mission_id=m.id AND l.goal=?)');args.push(goal);}
 if(options.task_id){if(typeof options.task_id!=='string'||options.task_id.length>100)fail('Invalid task identifier.');clauses.push('EXISTS(SELECT 1 FROM tasks t WHERE t.mission_id=m.id AND t.id=?)');args.push(options.task_id);}
 if(q){const escaped='%'+q.replace(/[\\%_]/g,'\\$&')+'%';clauses.push("(m.title LIKE ? ESCAPE '\\' OR m.summary LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM tasks t WHERE t.mission_id=m.id AND t.title LIKE ? ESCAPE '\\'))");args.push(escaped,escaped,escaped);}
 const where=clauses.join(' AND '),total=platform.get(`SELECT COUNT(*) AS n FROM missions m WHERE ${where}`,...args).n;
 const missions=platform.all(`SELECT m.*,o.name AS owner,r.name AS reviewer,(SELECT COUNT(*) FROM tasks t WHERE t.mission_id=m.id) AS task_count FROM missions m LEFT JOIN accounts o ON o.id=m.owner_id LEFT JOIN accounts r ON r.id=m.reviewer_id WHERE ${where} ORDER BY m.created_at DESC,m.id ASC LIMIT ? OFFSET ?`,...args,limit,offset);
 const ids=JSON.stringify(missions.map(m=>m.id));const tasks=platform.all('SELECT t.*,f.submission_id AS origin_submission_id,s.version AS origin_version,s.status AS origin_status FROM tasks t LEFT JOIN task_followups f ON f.task_id=t.id LEFT JOIN submissions s ON s.id=f.submission_id WHERE t.mission_id IN (SELECT value FROM json_each(?)) ORDER BY t.id',ids).map(task=>({...task,allowed_domains:JSON.parse(task.allowed_domains),allowed_actions:['read-approved-sources','submit-evidence'],risk:'low',lease_minutes:20}));
 let active_claim=null;
 if (actor?.kind==='runtime') {
   active_claim=platform.get("SELECT c.*,t.title AS task_title FROM claims c JOIN tasks t ON t.id=c.task_id WHERE c.account_id=? AND c.agent_id=? AND c.status IN ('leased','changes_requested') ORDER BY c.created_at DESC LIMIT 1",actor.account.id,actor.agent.id)||null;
 }
 return {missions,tasks,total,offset,limit,has_more:offset+missions.length<total,active_claim};
}
