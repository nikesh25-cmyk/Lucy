import test from 'node:test';
import assert from 'node:assert/strict';
import {assessmentReason} from '../src/review-assessment.js';
import {briefFixture} from './brief-fixture.js';
import {fixture,realMission,evidence} from './helpers.js';
import {Platform} from '../src/platform.js';
const assessment=(changes={})=>({findings:[{finding_number:1,result:'supported',checked_source_numbers:[1],notes:'QA fixture passage identifies this as a workflow test, not a trade conclusion.'}],scope_notes:'Fictional fixture only; proposed institutional roles are unconfirmed.',rights_notes:'QA attributed source; no actual reuse permission has been established.',cost_notes:'Artificial estimates sum to 0.30; freight remains unknown and no budget is approved.',...changes});
test('human finding assessments reject unrelated citations and unsupported acceptance without treating unknown costs as known',()=>{
 const brief=briefFixture(),entry=assessment();assert.match(assessmentReason('QA review',entry,brief,'accepted'),/freight remains unknown/);
 for(const bad of [assessment({findings:[]}),assessment({findings:[{...entry.findings[0],finding_number:2}]}),assessment({findings:[{...entry.findings[0],checked_source_numbers:[2]}]}),assessment({findings:[{...entry.findings[0],checked_source_numbers:[1,1]}]}),assessment({findings:[{...entry.findings[0],result:'uncertain'}]}),assessment({findings:[{...entry.findings[0],notes:''}]}),assessment({scope_notes:''}),assessment({cost_notes:''})])assert.throws(()=>assessmentReason('QA review',bad,brief,'accepted'),{status:400});
 const unchecked=assessment({findings:[{finding_number:1,result:'not_checked',checked_source_numbers:[],notes:'The cited passage still needs to be read.'}]});assert.match(assessmentReason('Check the passage',unchecked,brief,'changes_requested'),/Checked sources: None/);assert.throws(()=>assessmentReason('QA review',unchecked,brief,'accepted'),{status:400});
 assert.throws(()=>assessmentReason('QA review',entry,null,'accepted'),{status:400});assert.equal(assessmentReason('Existing plain review',undefined,brief,'accepted'),'Existing plain review');
});
test('review assessments remain version-specific through corrections, publication, export and restart',async t=>{
 const f=await fixture(t),{task}=realMission(f),claim=f.tx('claim',f.actor('alice'),{task_id:task.id},'assessed-claim');
 const first=f.tx('submit',f.actor('alice'),evidence(claim,{brief:briefFixture()}),'first-assessed');
 const uncertain=assessment({findings:[{finding_number:1,result:'uncertain',checked_source_numbers:[1],notes:'QA correction: clarify the fixture scope.'}]});
 assert.throws(()=>f.tx('review',f.actor('alice'),{submission_id:first.id,decision:'accepted',reason:'Self review',assessment:assessment()}),{status:403});
 assert.throws(()=>f.tx('review',f.actor('reviewer'),{submission_id:first.id,decision:'accepted',reason:'Uncertain',assessment:uncertain}),{status:400});assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?',first.id).status,'pending_review');
 f.tx('review',f.actor('reviewer'),{submission_id:first.id,decision:'changes_requested',reason:'Clarify the fixture.',assessment:uncertain});
 const second=f.tx('submit',f.actor('alice'),evidence(claim,{brief:briefFixture({recipient:'Proposed QA focal point; no real appointment'})}),'second-assessed');
 f.tx('review',f.actor('reviewer'),{submission_id:second.id,decision:'accepted',reason:'Fixture reviewed only.',assessment:assessment()});
 const history=f.platform.history(f.actor('alice'));assert.match(history.reviews.find(r=>r.submission_id===first.id).reason,/uncertain/);assert.match(history.reviews.find(r=>r.submission_id===second.id).reason,/Supported within/);assert.match(f.platform.gallery()[0].reason,/no recipient consent/);assert.equal(f.platform.gallery()[0].adoption_count,0);assert.equal(f.platform.history(f.actor('bob')).reviews.length,0);assert.match(f.platform.exportAccount(f.actor('alice')).reviews.find(r=>r.submission_id===second.id).reason,/Cost assumptions/);
 f.platform.close();const reopened=new Platform(f.database);t.after(()=>reopened.close());assert.match(reopened.gallery()[0].reason,/HUMAN EVIDENCE ASSESSMENT/);assert.equal(reopened.verifyAudit(),true);
});
