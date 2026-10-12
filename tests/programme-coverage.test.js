import test from 'node:test';import assert from 'node:assert/strict';import {fixture} from './helpers.js';
test('reference catalog distinguishes treaty experts, Charter bodies, review mechanisms and climate bodies',async t=>{
 const f=await fixture(t),catalog=f.platform.assembly().programmes;assert.equal(catalog.institutions.filter(i=>i.type==='human-rights-treaty-body').length,10);assert.equal(catalog.institutions.filter(i=>i.type==='climate-constituted-body').length,7);assert.equal(catalog.institutions.find(i=>i.id==='ccpr').name,'Human Rights Committee');assert.equal(catalog.institutions.find(i=>i.id==='human-rights-council').type,'charter-based-body');assert.equal(catalog.institutions.find(i=>i.id==='universal-periodic-review').type,'human-rights-review-mechanism');assert.equal(new Set(catalog.institutions.map(i=>i.id)).size,catalog.institutions.length);assert.ok(catalog.coverageGaps.some(g=>/participation/.test(g)));
 for(const record of catalog.institutions.filter(i=>i.sourceCheckedOn)){assert.ok(record.countryResearchChecks.length);assert.match(record.mappingStatus,/editorial/);assert.ok(record.evidenceLocator);assert.equal(new URL(record.sourceUrl).protocol,'https:');}
});
test('new country programme tasks preserve mechanism checks, official discovery hosts and independent review boundaries',async t=>{
 const f=await fixture(t);for(const id of ['crpd','ldc-expert-group','standing-committee-finance','technology-executive-committee','universal-periodic-review']){
  assert.equal(f.tx('researchGenerate',f.actor('admin'),{country_code:'NP',institution_id:id}).added,2);assert.equal(f.tx('researchGenerate',f.actor('admin'),{country_code:'NP',institution_id:id}).added,0);
  const leads=f.platform.research(null,{country:'NP',institution:id}).leads;assert.equal(leads.length,2);const institution=f.platform.assembly().programmes.institutions.find(i=>i.id===id);for(const lead of leads){for(const check of institution.countryResearchChecks)assert.ok(lead.instructions.includes(check));for(const url of institution.relatedSourceUrls||[])assert.ok(lead.source_urls.includes(url));}
  const activation=f.tx('researchActivate',f.actor('admin'),{lead_id:leads[0].id,beneficiary:'Proposed country evidence users; no authority or funding agreement',reviewer_id:f.actor('reviewer').account.id}),task=f.platform.get('SELECT * FROM tasks WHERE id=?',activation.task_id);for(const check of institution.countryResearchChecks)assert.ok(task.instructions.includes(check));assert.match(task.rights,/no outreach authorization/);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n,0);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM adoptions').n,0);
 }
 const crpd=f.platform.research(null,{institution:'crpd'}).leads[0];assert.match(crpd.instructions,/treaty participation/);assert.match(crpd.instructions,/recommendations from implemented/);const finance=f.platform.research(null,{institution:'standing-committee-finance'}).leads[0];assert.match(finance.instructions,/actual disbursement/);assert.match(finance.instructions,/not.*funding offer/);assert.equal(f.platform.verifyAudit(),true);
});

test('stability and food-security references retain scoped checks, retrieval proof and financing/authority limits',async t=>{
 const f=await fixture(t),catalog=f.platform.assembly().programmes;assert.equal(catalog.institutions.length,100);assert.equal(Object.values(catalog.coverage.countsByType).reduce((n,count)=>n+count,0),100);assert.equal(catalog.coverage.exclusions.includes('Treaty bodies'),false);
 for(const id of ['peacebuilding-commission','peacebuilding-fund','committee-world-food-security','undrr']){const item=catalog.institutions.find(i=>i.id===id);assert.equal(item.sourceCheckedOn,'2026-10-12');assert.match(item.sourceVerification.sha256,/^[a-f0-9]{64}$/);assert.equal(f.tx('researchGenerate',f.actor('admin'),{country_code:'NP',institution_id:id}).added,2);assert.equal(f.tx('researchGenerate',f.actor('admin'),{country_code:'NP',institution_id:id}).added,0);const leads=f.platform.research(null,{country:'NP',institution:id}).leads;assert.equal(leads.length,2);for(const lead of leads)for(const check of item.countryResearchChecks)assert.ok(lead.instructions.includes(check));const activated=f.tx('researchActivate',f.actor('admin'),{lead_id:leads[0].id,beneficiary:'Fictional country evidence users; no consent or funding claim',reviewer_id:f.actor('reviewer').account.id}),task=f.platform.get('SELECT * FROM tasks WHERE id=?',activated.task_id);for(const check of item.countryResearchChecks)assert.ok(task.instructions.includes(check));assert.match(task.rights,/no outreach authorization/);}
 assert.match(catalog.institutions.find(i=>i.id==='peacebuilding-fund').countryResearchChecks.join(' '),/not a funding offer/);assert.match(catalog.institutions.find(i=>i.id==='committee-world-food-security').countryResearchChecks.join(' '),/not automatically binding/);assert.match(catalog.institutions.find(i=>i.id==='peacebuilding-commission').countryResearchChecks.join(' '),/country consent/);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n,0);assert.equal(f.platform.verifyAudit(),true);
});


test('climate mechanisms carry country checks, honest retrieval gaps and distinct assistance/compliance boundaries',async t=>{
 const f=await fixture(t),catalog=f.platform.assembly().programmes;
 assert.equal(catalog.institutions.filter(i=>i.type==='climate-constituted-body').length,7);
 assert.equal(catalog.institutions.filter(i=>i.type==='climate-technical-assistance-network').length,1);
 const before=f.platform.get('SELECT COUNT(*) AS n FROM research_leads').n;
 for(const id of ['adaptation-committee','paris-capacity-building','paris-implementation-compliance','wim-executive-committee','santiago-network']){
  const item=catalog.institutions.find(i=>i.id===id);assert.equal(item.sourceVerification.directReaderStatus,'collection-gap');assert.equal(item.sourceVerification.sha256,undefined);assert.match(item.sourceCheckNote,/full live source retrieval remains unverified/);
  assert.equal(f.tx('researchGenerate',f.actor('admin'),{country_code:'NP',institution_id:id}).added,2);assert.equal(f.tx('researchGenerate',f.actor('admin'),{country_code:'NP',institution_id:id}).added,0);
  const leads=f.platform.research(null,{country:'NP',institution:id}).leads;for(const lead of leads){assert.ok(lead.instructions.includes(item.sourceCheckNote));for(const check of item.countryResearchChecks)assert.ok(lead.instructions.includes(check));for(const url of item.relatedSourceUrls)assert.ok(lead.source_urls.includes(url));}
  const activated=f.tx('researchActivate',f.actor('admin'),{lead_id:leads[0].id,beneficiary:'Fictional workflow test; no actual country authority or support request',reviewer_id:f.actor('reviewer').account.id}),task=f.platform.get('SELECT * FROM tasks WHERE id=?',activated.task_id);
  for(const check of item.countryResearchChecks)assert.ok(task.instructions.includes(check));assert.ok(JSON.parse(task.allowed_domains).includes('unfccc.int'));assert.ok(task.instructions.includes(item.sourceCheckNote));
 }
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM research_leads').n,before+10);
 assert.match(catalog.institutions.find(i=>i.id==='paris-implementation-compliance').countryResearchChecks.join(' '),/missing search result does not establish non-compliance/);
 assert.match(catalog.institutions.find(i=>i.id==='santiago-network').countryResearchChecks.join(' '),/technical assistance from project funding/);
 assert.match(catalog.institutions.find(i=>i.id==='wim-executive-committee').countryResearchChecks.join(' '),/compensation entitlement/);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n,0);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM adoptions').n,0);assert.equal(f.platform.verifyAudit(),true);
});


test('coordination and country-review references preserve national ownership, source gaps and dated reporting requirements',async t=>{
 const f=await fixture(t),catalog=f.platform.assembly().programmes;assert.equal(catalog.institutions.length,100);const before=f.platform.get('SELECT COUNT(*) AS n FROM research_leads').n;
 for(const id of ['hlpf','voluntary-national-review','resident-coordinator-system','cooperation-framework']){const record=catalog.institutions.find(i=>i.id===id);assert.equal(record.sourceCheckedOn,'2026-10-12');if(['hlpf','voluntary-national-review'].includes(id)){assert.equal(record.sourceVerification.directReaderStatus,'retrieved');assert.match(record.sourceVerification.sha256,/^[a-f0-9]{64}$/);}else{assert.equal(record.sourceVerification.directReaderStatus,'collection-gap');assert.equal(record.sourceVerification.sha256,undefined);assert.match(record.sourceCheckNote,/unverified/);}
  assert.equal(f.tx('researchGenerate',f.actor('admin'),{country_code:'NP',institution_id:id}).added,2);assert.equal(f.tx('researchGenerate',f.actor('admin'),{country_code:'NP',institution_id:id}).added,0);const lead=f.platform.research(null,{country:'NP',institution:id}).leads[0];for(const check of record.countryResearchChecks)assert.ok(lead.instructions.includes(check));assert.ok(lead.instructions.includes(record.sourceCheckNote));const activated=f.tx('researchActivate',f.actor('admin'),{lead_id:lead.id,beneficiary:'Fictional coordination workflow only; no country representation',reviewer_id:f.actor('reviewer').account.id}),task=f.platform.get('SELECT * FROM tasks WHERE id=?',activated.task_id);for(const check of record.countryResearchChecks)assert.ok(task.instructions.includes(check));assert.ok(task.instructions.includes(record.sourceCheckNote));assert.match(task.rights,/no outreach authorization/);
 }
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM research_leads').n,before+8);assert.match(catalog.institutions.find(i=>i.id==='voluntary-national-review').countryResearchChecks.join(' '),/self-reporting is not independent certification/);assert.match(catalog.institutions.find(i=>i.id==='resident-coordinator-system').countryResearchChecks.join(' '),/fictional NemoWorld mayors are not/);assert.match(catalog.institutions.find(i=>i.id==='cooperation-framework').countryResearchChecks.join(' '),/not a country agreement/);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n,0);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM adoptions').n,0);assert.equal(f.platform.verifyAudit(),true);
});

test('UN programme and committee register keeps bodies, programmes, treaty processes, strategies and grant instruments distinct',async t=>{
 const f=await fixture(t),catalog=f.platform.assembly().programmes;
 const added=catalog.institutions.filter(record=>record.recordKind);
 assert.equal(added.length,17);assert.equal(new Set(added.map(record=>record.id)).size,17);
 assert.deepEqual(Object.keys(catalog.coverage.recordKindsAdded).sort(),['body','grant-instrument','programme','strategy','treaty-process']);
 assert.equal(added.filter(record=>record.recordKind==='grant-instrument').length,3);
 assert.equal(added.filter(record=>record.recordKind==='treaty-process').length,3);
 assert.equal(added.filter(record=>record.recordKind==='strategy').length,3);
 assert.match(catalog.coverage.recordKindRule,/recordKind in \{body, programme, treaty-process, strategy, grant-instrument\}/);
 assert.ok(catalog.coverage.exclusions.some(g=>/outside the UN system/.test(g)));
 for(const record of added){
  assert.equal(record.sourceCheckedOn,'2026-10-12');assert.equal(new URL(record.sourceUrl).protocol,'https:');
  assert.match(record.sourceVerification.sha256,/^[a-f0-9]{64}$/);assert.ok(record.sourceVerification.retrieved.startsWith('2026-10-12'));
  assert.ok(record.jurisdiction&&record.eligibility&&record.implementationEvidence&&record.publicAccessRoute&&record.researchTask);
  assert.ok(record.countryResearchChecks.length>=2);assert.match(record.mappingStatus,/editorial/);
 }
 const domains={agriculture:['codex-alimentarius','plant-genetic-resources-treaty','fao-committee-agriculture'],trade:['uncitral'],ldc:['un-ohrlls','technology-bank'],environment:['unea','cbd','kunming-montreal-gbf','unccd','gef','green-climate-fund','adaptation-fund'],peace:['dppa','un-peacekeeping','women-peace-security'],digital:['global-digital-compact']};
 assert.equal(Object.values(domains).flat().length,17);
 for(const id of Object.values(domains).flat())assert.ok(added.some(record=>record.id===id),id);
 const preexisting=catalog.institutions.filter(record=>!record.recordKind).map(record=>record.sourceUrl);
 for(const record of added)assert.equal(preexisting.includes(record.sourceUrl),false,'duplicate source '+record.sourceUrl);
 for(const id of ['codex-alimentarius','uncitral','gef','global-digital-compact']){
  const record=catalog.institutions.find(item=>item.id===id);
  assert.equal(f.tx('researchGenerate',f.actor('admin'),{country_code:'NP',institution_id:id}).added,2);
  assert.equal(f.tx('researchGenerate',f.actor('admin'),{country_code:'NP',institution_id:id}).added,0);
  const leads=f.platform.research(null,{country:'NP',institution:id}).leads;assert.equal(leads.length,2);
  for(const lead of leads){for(const check of record.countryResearchChecks)assert.ok(lead.instructions.includes(check));assert.ok(lead.instructions.includes(record.mandate.replace(/\.$/,'')));assert.ok(lead.source_urls.includes(record.sourceUrl));}
  const activated=f.tx('researchActivate',f.actor('admin'),{lead_id:leads[0].id,beneficiary:'Fictional register workflow; no authority, funding or endorsement implied',reviewer_id:f.actor('reviewer').account.id}),task=f.platform.get('SELECT * FROM tasks WHERE id=?',activated.task_id);
  for(const check of record.countryResearchChecks)assert.ok(task.instructions.includes(check));assert.match(task.rights,/no outreach authorization/);
 }
 assert.match(catalog.affiliation,/no UN affiliation, mandate or endorsement/);
 assert.match(catalog.institutions.find(i=>i.id==='green-climate-fund').countryResearchChecks.join(' '),/not an approval or a transfer of finance/);
 assert.match(catalog.institutions.find(i=>i.id==='cbd').countryResearchChecks.join(' '),/self-reporting/);
 assert.match(catalog.institutions.find(i=>i.id==='kunming-montreal-gbf').sourceCheckNote,/client-rendered/);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n,0);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM adoptions').n,0);assert.equal(f.platform.verifyAudit(),true);
});
