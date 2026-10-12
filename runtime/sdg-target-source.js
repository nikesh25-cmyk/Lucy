import {readFileSync} from 'node:fs';
const catalog=JSON.parse(readFileSync(new URL('../catalog/sdg-targets.json',import.meta.url),'utf8'));
export function sdgTargetRequest(url){
 if(url.hostname!=='sdgs.un.org'||!url.hash.startsWith('#target-'))return null;
 const target=catalog.entries.find(item=>url.hash==='#target-'+item.code);if(!target||url.search||url.href!==target.sourceUrl+'#target-'+target.code)throw Error('Choose a canonical registered SDG target source.');
 return target;
}
export function extractSDGTarget(raw,target,extractText){
 const clean=raw.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' '),matches=[];
 const blocks=/<h4\b[^>]*\bclass=["'][^"']*\bgoal-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h4>\s*<p\b[^>]*\bclass=["'][^"']*\bgoal-text\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi;
 for(const match of clean.matchAll(blocks))if(extractText(match[1]).text===target.code){if(/<p\b/i.test(match[2]))throw Object.assign(Error('Target paragraph structure needs review.'),{sourceProblem:'unreadable'});matches.push(extractText(match[2]).text);}
 if(matches.length!==1||matches[0].length<40||matches[0].length>700)throw Object.assign(Error('Requested target is missing, ambiguous or outside its readable bound.'),{sourceProblem:'unreadable'});
 const description=matches[0],years=[...new Set(description.match(/\b(?:19|20)[0-9]{2}\b/g)||[])].sort();
 const qualification='Global framework only; not country evidence or a current indicator definition. Original years are not newly issued deadlines. Check current definitions and national evidence before recommendations.';
 const text=`SDG target ${target.code}. Original target wording: ${description}\nYears mentioned: ${years.join(', ')||'none recorded'}. ${qualification}`;if(text.length>1000)throw Object.assign(Error('Target text exceeds its bounded model context.'),{sourceProblem:'unreadable'});
 return {title:`SDG target ${target.code} · global framework`,text,quote:null,location:`Official SDG goal ${target.goal}; Targets and Indicators; exact target ${target.code}`,declared_published:null,framework_target:{code:target.code,goal:target.goal,editorial_focus:target.focus,original_years:years,qualification},publication_note:'Retrieval date is not the original framework publication date.'};
}
export function targetFrameworkSummary(record){const target=record.framework_target;return `Target ${target.code}; editorial focus: ${target.editorial_focus}. Years mentioned in retrieved wording: ${target.original_years.join(', ')||'none recorded'}. ${target.qualification}`;}
