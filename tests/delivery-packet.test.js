import {createApp} from '../server.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,realMission,evidence} from './helpers.js';
import {briefFixture} from './brief-fixture.js';
import {createDeliveryPacket,deliveryPacketHTML,deliveryPacketFilename} from '../src/delivery-packet.js';
const generatedAt='2026-10-11T16:00:00.000Z';
test('public delivery snapshot carries accepted version, exact costs, sources and review without exporting operator secrets',async t=>{
 const f=await fixture(t),{task}=realMission(f),claim=f.tx('claim',f.actor('alice'),{task_id:task.id},'packet-claim');
 const submitted=f.tx('submit',f.actor('alice'),evidence(claim,{brief:briefFixture()}),'packet-submit');assert.equal(f.platform.gallery().length,0);
 assert.throws(()=>createDeliveryPacket({status:'pending_review',review_decision:'accepted'}),{status:400});
 f.tx('review',f.actor('reviewer'),{submission_id:submitted.id,decision:'accepted',reason:'QA structure and unknown costs reviewed; no real trade recommendation.'});
 const record=f.platform.gallery()[0],packet=createDeliveryPacket(record,{generatedAt});assert.equal(packet.submission.version,1);assert.equal(packet.content.brief.cost_scenario.known_subtotal,'0.30');assert.equal(packet.content.brief.cost_scenario.total,null);assert.equal(packet.sources[0].location,'Section 2, paragraph 3');assert.equal(packet.sources[0].number,1);assert.match(packet.review.explanation,/no real trade recommendation/);assert.equal(packet.documented_uses,0);assert.equal(packet.generated_at,generatedAt);assert.match(packet.boundary,/may become outdated/);
 const output=JSON.stringify(packet);for(const field of ['operator_id','account_id','password','email','token','idempotency_key'])assert.equal(output.includes('"'+field+'"'),false);
 const html=deliveryPacketHTML(packet);assert.match(html,/Total: Incomplete/);assert.match(html,/Supporting location: Section 2, paragraph 3/);assert.match(html,/href="#source-1"/);assert.match(html,/id="source-1"/);assert.match(html,/Human review record/);assert.match(html,/Version 1/);assert.match(html,/source register, review and limitations/);assert.equal(deliveryPacketFilename(packet,'html'),`lucy-briefing-${submitted.id}-v1.html`);
 // Changed copied subtotals are recomputed from the original decimal rows.
 record.brief.cost_scenario.total='999999.99';record.brief.cost_scenario.known_subtotal='999999.99';assert.equal(createDeliveryPacket(record,{generatedAt}).content.brief.cost_scenario.known_subtotal,'0.30');assert.equal(createDeliveryPacket(record,{generatedAt}).content.brief.cost_scenario.total,null);
 for(const url of ['javascript:alert(1)','https://user:password@example.org/report'])assert.throws(()=>createDeliveryPacket({...record,sources:[{...record.sources[0],url}]},{generatedAt}),{status:400});
 // Moderation removal prevents creation from the current public gallery.
 const report=f.tx('report',f.actor('bob'),{target_type:'submission',target_id:submitted.id,reason:'QA exercise: hide a previously accepted record.'});f.tx('moderate',f.actor('moderator'),{report_id:report.id,action:'quarantine',reason:'QA moderation fixture.'});assert.equal(f.platform.gallery().some(item=>item.id===submitted.id),false);
});
test('plain-text practice packet is visibly a demonstration and escapes active markup in every contributed section',async t=>{
 const f=await fixture(t),task=f.platform.missionList().tasks.find(item=>item.id==='climate-practice'),claim=f.tx('claim',f.actor('alice'),{task_id:task.id},'plain-packet');
 const attack='</p><script>alert("QA")</script><img src="https://example.org/track" onerror="alert(1)">';
 const submitted=f.tx('submit',f.actor('alice'),evidence(claim,{artifact:attack,method:attack,limitations:attack,rights:attack,sources:[{url:'https://example.org/report?q=%22%3E%3Cscript%3E',location:attack,date:'Not established'}]}),'plain-packet-submission');
 f.tx('review',f.actor('admin'),{submission_id:submitted.id,decision:'accepted',reason:attack});const packet=createDeliveryPacket(f.platform.gallery()[0],{generatedAt}),html=deliveryPacketHTML(packet);
 assert.equal(packet.content.format,'plain_text_evidence');assert.equal(packet.submission.practice,true);assert.match(html,/PRACTICE CONTRIBUTION/);assert.match(html,/&lt;script&gt;/);assert.equal(html.includes('<script>'),false);assert.equal(html.includes('<img '),false);assert.match(html,/default-src 'none'/);assert.match(html,/@media print/);assert.match(html,/@media\(max-width:600px\)/);assert.equal(html.includes('example.org/track" onerror'),false);
 assert.throws(()=>deliveryPacketFilename(packet,'exe'),{status:400});assert.throws(()=>createDeliveryPacket({...f.platform.gallery()[0],review_decision:'rejected'}),{status:400});
});

test('public briefing HTTP downloads contain the accepted record and refuse pending or quarantined versions',async t=>{
 const f=await fixture(t),{task}=realMission(f),claim=f.tx('claim',f.actor('alice'),{task_id:task.id},'http-packet-claim'),submission=f.tx('submit',f.actor('alice'),evidence(claim,{brief:briefFixture()}),'http-packet-submit');
 const {server}=createApp({platform:f.platform});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));const url=`http://127.0.0.1:${server.address().port}/api/v1/briefing?submission=${submission.id}`;
 assert.equal((await fetch(url)).status,404);f.tx('review',f.actor('reviewer'),{submission_id:submission.id,decision:'accepted',reason:'QA packet fixture accepted only.'});
 const htmlResponse=await fetch(url+'&format=html');assert.equal(htmlResponse.status,200);assert.match(htmlResponse.headers.get('content-disposition'),new RegExp(submission.id+'-v1.html'));assert.match(htmlResponse.headers.get('content-type'),/text\/html/);assert.equal(htmlResponse.headers.get('cache-control'),'no-store');assert.match(htmlResponse.headers.get('content-security-policy'),/default-src 'none'/);assert.match(await htmlResponse.text(),/Actual producer, buyer demand/);
 const jsonResponse=await fetch(url+'&format=json'),packet=await jsonResponse.json();assert.equal(jsonResponse.status,200);assert.equal(packet.submission.id,submission.id);assert.equal(packet.review.decision,'accepted');assert.equal(packet.content.brief.cost_scenario.total,null);assert.match(jsonResponse.headers.get('content-disposition'),/-v1.json/);assert.equal((await fetch(url+'&format=exe')).status,400);
 const report=f.tx('report',f.actor('bob'),{target_type:'submission',target_id:submission.id,reason:'QA stale gallery test'});f.tx('moderate',f.actor('moderator'),{report_id:report.id,action:'quarantine',reason:'QA quarantine test'});assert.equal((await fetch(url+'&format=html')).status,404);assert.equal((await fetch(url+'&format=json')).status,404);
 const privateSubmission=f.tx('submit',f.actor('bob'),evidence(f.tx('claim',f.actor('bob'),{task_id:'peace-practice'},'private-packet-claim')),'private-packet-submit');assert.equal((await fetch(url.replace(submission.id,privateSubmission.id))).status,404);
});
