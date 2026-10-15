// How one declared write route is actually exercised over HTTP, and what durable effect each
// successful answer must leave behind. `tests/framework-*.test.js` joins this table with
// `src/framework/write-contract.js` by route and method; a contract route missing from here is
// reported as unexercised rather than silently skipped, and every `BLOCKED_EXERCISES` entry carries
// the observed reason it cannot be driven in a hermetic fixture.
import { createHash } from 'node:crypto';
import { realMission, evidence, ok, RUNTIME_SCOPES } from './writes-harness.js';

const rows = (f, sql, ...args) => f.platform.get(sql, ...args).n;
const field = (f, sql, ...args) => f.platform.get(sql, ...args);

// Which operator account holds which runtime scope set. One account may run only one agent session,
// so each scope set has its own operator, and the routes that name an owning account agree with it.
const RUNTIME_OWNERS = Object.freeze({ read: 'admin', move: 'moderator', chat: 'reviewer', contribute: 'carol', build: 'dave', vault: 'bob', every: 'erin' });

// A durable fixture: one open mission with several tasks, an accepted contribution, a pending one,
// one resident per runtime scope set, and the community, journey, trade, quest, guild, memory,
// vault and restoration records the later routes act on.
// A durable fixture: one open mission with several tasks, an accepted contribution, a pending one,
// one resident per runtime scope set, and the community, journey, trade, quest, guild, memory,
// vault and restoration records the later routes act on. It is async because an account may hold only
// one active claim at a time (platform.claim refuses a second), so the fixture needs extra operators.
export async function prepare(f) {
  const { mission, task } = realMission(f);
  const admin = f.actor('admin'), reviewer = f.actor('reviewer'), alice = f.actor('alice'), bob = f.actor('bob');
  const aliceAgent = f.agent('alice'), bobAgent = f.agent('bob'), sibling = f.agent('alice', 'alice second resident');
  const mkTask = (title) => f.tx('createTask', admin, { mission_id: mission.id, title, instructions: 'Record one source with attribution and limitations.', rights: 'Explicit permission required.', allowed_domains: ['example.org'] });
  const [task2, task3, task4, task5, task6, task7, task8] = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight'].map((name) => mkTask(`Contract task ${name}`));

  // Extra operators, so each concurrent claim has an account of its own to hold it.
  for (const name of ['carol', 'dave', 'erin', 'frank', 'gina', 'hank']) {
    const invitation = f.tx('invite', admin, { role: 'member' });
    f.credentials[name] = await f.platform.register({ name, email: `${name}@example.org`, password: f.password, consent: true, invite: invitation.code });
  }
  const carol = f.actor('carol'), dave = f.actor('dave'), erin = f.actor('erin'), frank = f.actor('frank'), gina = f.actor('gina');
  const carolAgent = f.agent('carol', 'carol resident'), daveAgent = f.agent('dave', 'dave resident'), erinAgent = f.agent('erin', 'erin resident'), frankAgent = f.agent('frank', 'frank resident'), ginaAgent = f.agent('gina', 'gina resident');

  const claim = f.tx('claim', alice, { task_id: task.id, agent_id: aliceAgent.id }, 'ws-claim-accepted');
  const accepted = f.tx('submit', alice, evidence(claim), 'ws-submission-accepted');
  f.tx('review', reviewer, { submission_id: accepted.id, decision: 'accepted', reason: 'Accepted the fixture contribution.' });
  const claimPending = f.tx('claim', alice, { task_id: task2.id, agent_id: aliceAgent.id }, 'ws-claim-pending');
  const pending = f.tx('submit', alice, evidence(claimPending), 'ws-submission-pending');
  const claimFollowUp = f.tx('claim', dave, { task_id: task3.id, agent_id: daveAgent.id }, 'ws-claim-followup');
  const followUpSource = f.tx('submit', dave, evidence(claimFollowUp), 'ws-submission-followup');
  const carolClaim = f.tx('claim', carol, { task_id: task4.id, agent_id: carolAgent.id }, 'ws-carol-claim');
  const bobClaimSubmit = f.tx('claim', bob, { task_id: task5.id, agent_id: bobAgent.id }, 'ws-bob-claim-two');

  // Private drafts: one to edit and archive, one whose claim has expired so it can be resumed.
  // One operator may hold one active claim at a time, so the claim to be resumed is created, saved and
  // aged out first: only then can the same operator hold the claim the editing routes act on.
  const expiredClaim = f.tx('claim', frank, { task_id: task7.id, agent_id: frankAgent.id }, 'ws-expired-claim');
  f.tx('draftSave', frank, { claim_id: expiredClaim.id, expected_revision: 0, format: 'evidence-form-v1', values: { artifact: 'Expired fixture draft', method: 'Read the source.' } });
  f.platform.run('UPDATE claims SET expires_at=? WHERE id=?', f.clock() - 1_000, expiredClaim.id);
  f.tx('expireClaims');
  const draftClaim = f.tx('claim', erin, { task_id: task6.id, agent_id: erinAgent.id }, 'ws-draft-claim');
  f.tx('draftSave', erin, { claim_id: draftClaim.id, expected_revision: 0, format: 'evidence-form-v1', values: { artifact: 'Fixture draft', method: 'Read the source.' } });

  // A resource shelf and a garden in each resident's own home, so an offer, a trade or a crop has a
  // place to live. `prepare` uses the same platform calls the routes do, never a route of its own.
  // The tilled tiles avoid the arrival tile and both portal tiles of a personal garden, which the
  // build route refuses to cover.
  const farm = { x: 4, y: 6 };
  for (const [owner, agent] of [['alice', aliceAgent], ['bob', bobAgent]]) {
    for (const kind of ['herbs', 'fiber']) f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity', agent.id, kind, 20);
    f.tx('travel', f.actor(owner), agent.id, { world_id: `home:${agent.id}` });
  }
  const aliceHome = `home:${aliceAgent.id}`;

  // One community, project, milestone and gathering; the routes under test create their own records.
  const circle = f.tx('createCircle', alice, { agent_id: aliceAgent.id, name: 'Contract circle', summary: 'A durable cooperation fixture.', focus: 'Learning' });
  const project = f.tx('createProject', alice, { agent_id: aliceAgent.id, circle_id: circle.id, title: 'Contract project', summary: 'A durable cooperation fixture.', goal: 'Record one licensed source.', evidence_requirements: 'Attribution, location and rights.', milestones: ['First record'] });
  const milestoneId = project.milestones[0].id;
  f.tx('circleMembership', bob, { agent_id: bobAgent.id, circle_id: circle.id, action: 'join' });
  f.tx('projectPledge', bob, { agent_id: bobAgent.id, project_id: project.id, action: 'pledge', commitment: 'Read and record the source.' });
  const event = f.tx('createEvent', alice, { agent_id: aliceAgent.id, circle_id: circle.id, title: 'Contract gathering', summary: 'A durable fixture gathering.', starts_at: new Date(f.clock() + 3_600_000).toISOString(), ends_at: new Date(f.clock() + 7_200_000).toISOString(), capacity: 4, world_id: 'commons' });

  // Journal, offers and the trade board, all settled through their own platform methods.
  f.tx('writeJournal', alice, { agent_id: aliceAgent.id, text: 'A durable private contract note.' });
  const offerInput = (key) => ({ agent_id: aliceAgent.id, recipient_agent_id: bobAgent.id, items: { herbs: 1 }, note: `Fixture offer ${key}.` });
  const offer = f.tx('offerCreate', alice, offerInput('accept'), 'ws-offer-accept');
  const offer2 = f.tx('offerCreate', alice, offerInput('decline'), 'ws-offer-decline');
  const offer3 = f.tx('offerCreate', alice, offerInput('cancel'), 'ws-offer-cancel');
  const listing = f.tx('tradePost', alice, { agent_id: aliceAgent.id, items: { herbs: 1 }, note: 'Fixture listing to claim.' }, 'ws-listing-claim');
  const listing2 = f.tx('tradePost', alice, { agent_id: aliceAgent.id, items: { herbs: 1 }, note: 'Fixture listing to cancel.' }, 'ws-listing-cancel');

  // A published practice chain to join, a draft chain to publish, and a guild project to work on. A
  // chain is authored from the documented route vocabulary: a practice chain proves itself with saved
  // gardening facts, so it needs no independent review.
  const practiceSteps = [
    { slug: 'plant-one', title: 'Plant one crop', instructions: 'Plant one crop in your own garden.', output_name: 'A planted crop', source_kind: 'crop_plant' },
    { slug: 'harvest-one', title: 'Harvest one crop', instructions: 'Tend the crop, then harvest it once it is ready.', output_name: 'A harvested crop', source_kind: 'crop_harvest' },
  ];
  const chain = f.tx('questAuthor', reviewer, { slug: 'contract-chain', title: 'Contract chain', route: 'gardening', practice: true, summary: 'A durable practice chain fixture.', narrative: 'Practice the garden loop in two steps.', steps: practiceSteps });
  f.tx('questManage', reviewer, { chain_id: chain.id, action: 'publish' });
  const chain2 = f.tx('questAuthor', reviewer, { slug: 'contract-draft-chain', title: 'Contract draft chain', route: 'gardening', practice: true, summary: 'A second durable chain fixture.', narrative: 'A chain that stays a draft until it is published.', steps: practiceSteps.map((step, index) => ({ ...step, slug: `draft-${index + 1}` })) });
  const guildProject = f.tx('guildProjectCreate', alice, { agent_id: aliceAgent.id, guild_id: 'cultivator', title: 'Contract guild project', summary: 'A durable guild fixture.', visibility: 'public', plan: [{ id: 'ws-1', title: 'First workstream', output_name: 'A recorded source', scope: 'One source' }] });
  f.tx('guildParticipation', alice, { agent_id: aliceAgent.id, project_id: guildProject.id, action: 'join' });

  // Land, a frontier cell and a grant, plus the civic rows the conversation routes name. The steward's
  // own resident stands inside its plot, because the frontier build and expand routes require the
  // acting resident to be in the shared frontier itself.
  const plot = 'plot:0:0:5:5';
  f.tx('landAssign', alice, { plot_id: plot, purpose: 'A peaceful learning garden' });
  // Entering the shared frontier needs a doorway, so the steward's resident is placed inside its plot
  // directly, exactly as tests/quests-http.test.js places a resident before building.
  f.platform.run("UPDATE agents SET world_id='frontier:0:0',x=6,y=6,z=0,grounded=1 WHERE id=?", aliceAgent.id);
  const sectors = rows(f, 'SELECT COUNT(*) AS n FROM frontier_sectors');
  const grant = f.tx('plotGrantCreate', alice, { plot_id: plot, guest_agent_id: bobAgent.id, purpose: 'Contract fixture guest access', duration_minutes: 60, block_types: ['wood'], layers: [0], actions: ['place'], max_blocks: 4 });
  f.advance(3_000);
  const mayorId = field(f, 'SELECT id FROM npc_mayors LIMIT 1').id;
  const ambassadorId = field(f, 'SELECT id FROM npc_ambassadors LIMIT 1').id;

  // A source the evidence library already knows, so a withdrawal has something to record.
  f.platform.run('INSERT INTO evidence_sources(id,source_key,url,host,path,status,created_at) VALUES(?,?,?,?,?,?,?)', 'ws-source', 'ws-source-key', 'https://example.org/report', 'example.org', '/report', 'active', new Date(f.platform.clock()).toISOString());

  // The moderation pair: a report an appeal can be filed against must already be decided, and an
  // operator may appeal only its own report or a report against its own contribution.
  const report = f.tx('report', alice, { target_type: 'agent', target_id: bobAgent.id, reason: 'Contract fixture report.' });
  f.tx('moderate', f.actor('moderator'), { report_id: report.id, action: 'dismiss', reason: 'The fixture report needs no action.' });
  const appeal = f.tx('appeal', bob, { report_id: report.id, reason: 'The fixture report is mistaken.' });
  const openReport = f.tx('report', alice, { target_type: 'agent', target_id: bobAgent.id, reason: 'A second contract fixture report.' });

  // One runtime credential per scope set, each bound to its own resident under its own operator: a
  // resident holds one credential at a time and an operator may run one agent session at a time, so
  // neither the scope sets nor the operator accounts can share.
  const runtimes = {};
  const residents = {};
  for (const [name, owner] of Object.entries(RUNTIME_OWNERS)) {
    const operator = f.actor(owner);
    const resident = f.tx('createAgent', operator, { name: `resident ${name}`, kind: 'agent', capabilities: 'Read approved sources', limitations: 'Fixture bounds' });
    residents[name] = resident;
    for (const kind of ['herbs', 'fiber']) f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity', resident.id, kind, 20);
    f.tx('travel', operator, resident.id, { world_id: `home:${resident.id}` });
    // The building resident needs its own tilled garden: the crop and the interaction routes only act
    // on a farm tile that already exists, exactly as tests/interaction-http.test.js sets one up.
    if (name === 'build') {
      for (const x of [farm.x, 8]) f.tx('build', operator, resident.id, { x, y: farm.y, type: 'farm' });
      f.platform.run('UPDATE agents SET x=?,y=? WHERE id=?', farm.x, farm.y + 1, resident.id);
    }
    runtimes[name] = f.tx('runtime', operator, resident.id, { scopes: RUNTIME_SCOPES[name], max_calls: 500, minutes: 20 }).token;
  }
  // The movement resident walks home from the commons, which is the one direction the travel route
  // accepts without a doorway.
  f.platform.run("UPDATE agents SET world_id='commons',x=24,y=24,z=0,grounded=1 WHERE id=?", residents.move.id);
  const jobsAgent = f.agent('alice', 'alice job resident');

  return {
    mission, task, skillTasks: { task2, task3, task4, task5, task6, task7, task8 }, claim, accepted, pending, followUpSource,
    bobClaimSubmit, carolClaim, carolAgent, daveAgent, erinAgent, ginaAgent, draftClaim, expiredClaim, aliceAgent, bobAgent, sibling, jobsAgent, circle, project, milestoneId, event,
    offer, offer2, offer3, listing, listing2, chain, chain2, guildProject, workstreamId: 'ws-1', plot, sectors, grant,
    mayorId, ambassadorId, report, appeal, openReport, farm, aliceHome, residents, runtimes,
    accounts: { admin: admin.account.id, reviewer: reviewer.account.id, alice: alice.account.id, bob: bob.account.id },
    clock: () => f.clock(),
  };
}

export const WRITE_EXERCISES = [
  // -- accounts, residents and sessions --------------------------------------------------------------------------------
  { route: '/invites', method: 'POST', as: 'admin', input: () => ({ role: 'member' }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM invites WHERE code_hash=?', createHash('sha256').update(res.data.code).digest('hex')) === 1, 'the invitation code was not stored') },
  { route: '/agents', method: 'POST', as: 'alice', input: () => ({ name: 'Contract resident', capabilities: 'Read approved sources', limitations: 'Fixture bounds' }),
    effect: (f, res) => ok(field(f, 'SELECT operator_id FROM agents WHERE id=?', res.data.id).operator_id === f.actor('alice').account.id, 'the resident row was not stored') },
  { route: '/agents/control', method: 'POST', as: 'alice', input: (c) => ({ agent_id: c.sibling.id, status: 'paused' }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM agents WHERE id=?', c.sibling.id).status === 'paused', 'the resident status was not persisted') },
  { route: '/runtime/start', method: 'POST', as: 'alice', input: (c) => ({ agent_id: c.jobsAgent.id, scopes: ['read'], minutes: 2, max_calls: 3 }),
    effect: (f, res) => ok(rows(f, "SELECT COUNT(*) AS n FROM tokens WHERE agent_id=? AND kind='runtime' AND revoked=0", res.data.agent_id) === 1, 'the runtime credential was not stored') },
  { route: '/me', method: 'DELETE', as: 'hank',
    effect: (f) => ok(rows(f, "SELECT COUNT(*) AS n FROM accounts WHERE email='hank@example.org'") === 0, 'the account row was not removed') },
  { route: '/auth/logout', method: 'POST', as: 'dave', input: () => ({}),
    effect: (f) => ok(rows(f, "SELECT COUNT(*) AS n FROM tokens WHERE kind='session' AND revoked=1 AND account_id=(SELECT id FROM accounts WHERE email='dave@example.org')") === 1, 'the session was not revoked') },
  // -- claims, submissions, drafts and review --------------------------------------------------------------------------
  { route: '/claims', method: 'POST', as: 'gina', key: 'contract-claim', input: (c) => ({ task_id: c.skillTasks.task8.id, agent_id: c.ginaAgent.id }),
    effect: (f, res) => ok(rows(f, "SELECT COUNT(*) AS n FROM claims WHERE id=? AND status='leased'", res.data.id) === 1, 'the claim was not stored') },
  { route: '/claims/release', method: 'POST', as: 'carol', input: (c) => ({ claim_id: c.carolClaim.id }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM claims WHERE id=?', c.carolClaim.id).status === 'released', 'the release was not persisted') },
  { route: '/submissions', method: 'POST', as: 'bob', key: 'contract-submission', input: (c) => evidence(c.bobClaimSubmit),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM submissions WHERE id=?', res.data.id) === 1, 'the submission was not stored') },
  { route: '/drafts', method: 'POST', as: 'erin', input: (c) => ({ claim_id: c.draftClaim.id, expected_revision: 1, format: 'evidence-form-v1', values: { artifact: 'Edited fixture draft', method: 'Read the source.' } }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM claim_drafts WHERE claim_id=? AND revision=? AND content LIKE ?', res.data.claim_id, res.data.revision, '%Edited fixture draft%') === 1, 'the saved draft revision is not the answered revision') },
  { route: '/drafts/archive', method: 'POST', as: 'erin', input: (c) => ({ claim_id: c.draftClaim.id, archived: true }),
    effect: (f, res, c) => ok(field(f, 'SELECT archived FROM claim_drafts WHERE claim_id=?', c.draftClaim.id).archived === 1, 'the archive flag was not persisted') },
  { route: '/drafts/resume', method: 'POST', as: 'frank', key: 'contract-resume', input: (c) => ({ claim_id: c.expiredClaim.id }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM claim_drafts WHERE claim_id=? AND resumed_from IS NOT NULL', res.data.claim.id) === 1, 'the resumed draft was not stored') },
  { route: '/missions', method: 'POST', as: 'admin', input: (c) => ({ title: 'Contract mission', area: 'Climate', summary: 'A mission created by the contract fixture.', beneficiary: 'Fixture community', owner_id: c.accounts.admin, reviewer_id: c.accounts.reviewer, rubric: 'Check exact sources and rights.' }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM missions WHERE id=?', res.data.id) === 1, 'the mission was not stored') },
  { route: '/tasks', method: 'POST', as: 'admin', input: (c) => ({ mission_id: c.mission.id, title: 'Contract task', instructions: 'Record one source with attribution.', rights: 'Explicit permission required.', allowed_domains: ['example.org'] }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM tasks WHERE id=?', res.data.id) === 1, 'the task was not stored') },
  { route: '/missions/status', method: 'POST', as: 'admin', input: (c) => ({ mission_id: c.mission.id, status: 'closed' }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM missions WHERE id=?', c.mission.id).status === 'closed', 'the mission status was not persisted') },
  { route: '/tasks/follow-up', method: 'POST', as: 'admin', key: 'contract-follow-up', input: (c) => ({ submission_id: c.accepted.id, title: 'Follow up the fixture', instructions: 'Record the missing limitation.', rights: 'Explicit permission required.', allowed_domains: ['example.org'] }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM task_followups WHERE task_id=?', res.data.id) === 1, 'the follow-up task was not stored') },
  { route: '/reviews', method: 'POST', as: 'reviewer', input: (c) => ({ submission_id: c.pending.id, decision: 'changes_requested', reason: 'Clarify the fixture limitations.' }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM reviews WHERE id=?', res.data.id) === 1, 'the review was not stored') },
  { route: '/adoptions', method: 'POST', as: 'admin', input: (c) => ({ submission_id: c.accepted.id, note: 'Used in the contract fixture.', evidence: 'Submission record.' }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM adoptions WHERE id=?', res.data.id) === 1, 'the adoption was not stored') },
  // -- moderation and operations ---------------------------------------------------------------------------------------
  { route: '/reports', method: 'POST', as: 'alice', input: (c) => ({ target_type: 'agent', target_id: c.bobAgent.id, reason: 'Contract fixture report.' }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM reports WHERE id=?', res.data.id) === 1, 'the report was not stored') },
  { route: '/moderation', method: 'POST', as: 'moderator', input: (c) => ({ report_id: c.openReport.id, action: 'dismiss', reason: 'The second fixture report needs no action.' }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM reports WHERE id=?', c.openReport.id).status !== 'open', 'the moderation decision was not persisted') },
  { route: '/appeals', method: 'POST', as: 'alice', input: (c) => ({ report_id: c.report.id, reason: 'The reporter disagrees with the fixture dismissal.' }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM appeals WHERE id=?', res.data.id) === 1, 'the appeal was not stored') },
  { route: '/appeals/decide', method: 'POST', as: 'admin', input: (c) => ({ appeal_id: c.appeal.id, decision: 'upheld', reason: 'The fixture appeal is upheld.' }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM appeals WHERE id=?', c.appeal.id).status === 'upheld', 'the appeal decision was not persisted') },
  { route: '/operations/pause', method: 'POST', as: 'admin', input: () => ({ paused: true }),
    effect: (f) => ok(field(f, "SELECT value FROM settings WHERE key='paused'").value === 'true', 'the pause setting was not persisted') },
  { route: '/operations/accounts', method: 'POST', as: 'admin', input: (c) => ({ account_id: c.accounts.bob, status: 'suspended' }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM accounts WHERE id=?', c.accounts.bob).status === 'suspended', 'the account status was not persisted') },
  { route: '/operations/registration', method: 'POST', as: 'admin', input: () => ({ mode: 'closed' }),
    effect: (f) => ok(field(f, "SELECT value FROM settings WHERE key='registration'").value === 'closed', 'the registration mode was not persisted') },
  { route: '/community/manage', method: 'POST', as: 'alice', input: (c) => ({ kind: 'circle', id: c.circle.id, action: 'archive', reason: 'The contract fixture circle is archived.' }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM community_circles WHERE id=?', c.circle.id).status === 'archived', 'the circle archive was not persisted') },
  { route: '/jobs', method: 'POST', as: 'contribute', input: () => ({ status: 'completed', detail: 'Contract fixture job receipt.' }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM jobs WHERE id=?', res.data.id) === 1, 'the job receipt was not stored') },
  // -- movement, presence and building --------------------------------------------------------------------------------
  { route: '/move', method: 'POST', as: 'move', advance: 200, input: () => ({ direction: 'right' }),
    effect: (f, res, c) => ok(String(field(f, 'SELECT x FROM agents WHERE id=?', c.residents.move.id).x) === String(res.data.x), 'the position in the answer is not the stored position') },
  { route: '/climb', method: 'POST', as: 'move', advance: 200, input: () => ({ direction: 'up' }),
    effect: (f, res, c) => ok(String(field(f, 'SELECT z FROM agents WHERE id=?', c.residents.move.id).z) === String(res.data.z), 'the elevation in the answer is not the stored elevation') },
  { route: '/agents/:id/travel', method: 'POST', as: 'move', advance: 200, input: (c) => ({ world_id: `home:${c.residents.move.id}` }),
    effect: (f, res, c) => ok(field(f, 'SELECT world_id FROM agents WHERE id=?', c.residents.move.id).world_id === res.data.world_id, 'the world in the answer is not the stored world') },
  { route: '/agents/:id/posture', method: 'POST', as: 'move', input: () => ({ posture: 'sitting' }),
    effect: (f, res, c) => ok(field(f, 'SELECT posture FROM agents WHERE id=?', c.residents.move.id).posture === 'sitting', 'the posture was not persisted') },
  { route: '/agents/:id/climb', method: 'POST', as: 'move', advance: 200, input: () => ({ direction: 'up' }),
    effect: (f, res, c) => ok(String(field(f, 'SELECT z FROM agents WHERE id=?', c.residents.move.id).z) === String(res.data.z), 'the elevation in the answer is not the stored elevation') },
  { route: '/agents/:id/look', method: 'POST', as: 'move', input: () => ({ yaw: 0.5, pitch: 0.25 }),
    effect: (f, res, c) => ok(field(f, 'SELECT yaw FROM agents WHERE id=?', c.residents.move.id).yaw === res.data.yaw, 'the stored orientation is not the answered one') },
  { route: '/agents/:id/heartbeat', method: 'POST', as: 'read', input: () => ({}),
    effect: (f, res, c) => ok(field(f, 'SELECT last_seen FROM agents WHERE id=?', c.residents.read.id).last_seen === f.clock(), 'the presence write is not in the stored row') },
  { route: '/emotes', method: 'POST', as: 'move', input: (c) => ({ agent_id: c.residents.move.id, emote: 'wave' }),
    effect: (f, res, c) => ok(field(f, 'SELECT emote FROM agents WHERE id=?', c.residents.move.id).emote === res.data.emote, 'the emote was not persisted') },
  { route: '/messages', method: 'POST', as: 'chat', input: (c) => ({ agent_id: c.residents.chat.id, channel: 'public', text: 'Contract fixture message.' }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM messages WHERE id=?', res.data.id) === 1, 'the message was not stored') },
  { route: '/interact', method: 'POST', as: 'every', advance: 2_000, key: 'contract-interact', before: (f, c) => f.platform.run("UPDATE agents SET world_id='commons',x=10,y=6,z=0,grounded=1 WHERE id=?", c.residents.every.id), input: () => ({ x: 11, y: 6, action: 'travel' }),
    effect: (f, res, c) => ok(field(f, 'SELECT world_id FROM agents WHERE id=?', c.residents.every.id).world_id === res.data.result.world_id, 'the interaction did not persist the move it answered') },
  { route: '/agents/:id/build', method: 'POST', as: 'build', input: (c) => ({ type: 'bench', x: 8, y: 10 }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM world_objects WHERE world_id=? AND x=8 AND y=10', `home:${c.residents.build.id}`) === 1, 'the placed object was not stored') },
  { route: '/agents/:id/home', method: 'PATCH', as: 'alice', id: (c) => c.sibling.id, input: (c) => ({ agent_id: c.sibling.id, name: 'Contract garden', visibility: 'private' }),
    effect: (f, res, c) => ok(field(f, "SELECT visibility FROM worlds WHERE owner_agent_id=? AND kind='home'", c.sibling.id).visibility === 'private', 'the home visibility was not persisted') },
  // -- land, frontier and grants ---------------------------------------------------------------------------------------
  { route: '/land/assign', method: 'POST', as: 'carol', input: () => ({ plot_id: 'plot:0:0:7:7', purpose: 'Contract fixture learning space', description: 'Durable assignment fixture.' }),
    effect: (f) => ok(rows(f, "SELECT COUNT(*) AS n FROM land_stewardships WHERE plot_id='plot:0:0:7:7'") === 1, 'the land assignment was not stored') },
  { route: '/land/release', method: 'POST', as: 'carol', advance: 3_000, input: () => ({ plot_id: 'plot:0:0:7:7' }),
    effect: (f) => ok(rows(f, "SELECT COUNT(*) AS n FROM land_stewardships WHERE plot_id='plot:0:0:7:7'") === 0, 'the released plot is still held') },
  { route: '/frontier/build', method: 'POST', as: 'alice', advance: 2_000, before: (f, c) => f.platform.run('UPDATE agents SET x=31,y=32 WHERE id=?', c.aliceAgent.id), input: (c) => ({ agent_id: c.aliceAgent.id, world_id: 'frontier:0:0', x: 31, y: 31, z: 0, type: 'wood' }),
    effect: (f) => ok(rows(f, "SELECT COUNT(*) AS n FROM frontier_blocks WHERE world_id='frontier:0:0' AND x=31 AND y=31") >= 1, 'the frontier block was not stored') },
  { route: '/frontier/expand', method: 'POST', as: 'alice', advance: 2_000, before: (f, c) => f.platform.run("UPDATE agents SET world_id='frontier:1:0',x=46,y=24,z=0,grounded=1 WHERE id=?", c.aliceAgent.id), input: (c) => ({ agent_id: c.aliceAgent.id, world_id: 'frontier:1:0', direction: 'right' }),
    effect: (f, res) => ok(res.data.created === true && rows(f, 'SELECT COUNT(*) AS n FROM frontier_sectors WHERE world_id=?', res.data.target_world_id) === 1, 'the answer claims an opened area that storage does not hold') },
  { route: '/frontier/grant', method: 'POST', as: 'alice', advance: 3_000, input: (c) => ({ plot_id: c.plot, guest_agent_id: c.carolAgent.id, purpose: 'Contract fixture guest access', duration_minutes: 60, block_types: ['wood'], layers: [0], actions: ['place'], max_blocks: 4 }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM plot_grants WHERE id=?', res.data.grant.id) === 1, 'the plot grant was not stored') },
  { route: '/frontier/grant/revoke', method: 'POST', as: 'alice', advance: 3_000, input: (c) => ({ grant_id: c.grant.grant.id }),
    effect: (f, res, c) => ok(field(f, 'SELECT revoked_at FROM plot_grants WHERE id=?', c.grant.grant.id).revoked_at !== null, 'the revocation was not persisted') },
  // -- the resident and research workers -------------------------------------------------------------------------------
  { route: '/residents/cancel', method: 'POST', as: 'alice', input: () => ({}),
    effect: (f, res) => ok(res.data.stopping === false, 'a cancel with no active run must answer stopping:false') },
  { route: '/research/cancel', method: 'POST', as: 'alice', input: () => ({}),
    effect: (f, res) => ok(res.data.stopping === false, 'a cancel with no active run must answer stopping:false') },
  // -- civic conversations ---------------------------------------------------------------------------------------------
  { route: '/mayors/control', method: 'POST', as: 'admin', input: (c) => ({ npc_id: c.mayorId, status: 'paused' }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM npc_mayors WHERE id=?', c.mayorId).status === 'paused', 'the guide status was not persisted') },
  { route: '/ambassadors/control', method: 'POST', as: 'admin', input: (c) => ({ ambassador_id: c.ambassadorId, status: 'paused' }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM npc_ambassadors WHERE id=?', c.ambassadorId).status === 'paused', 'the ambassador status was not persisted') },
  { route: '/mayors/talk', method: 'POST', as: 'alice', advance: 3_000, input: (c) => ({ npc_id: c.mayorId, question: 'What public sources exist?' }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM ambassador_conversations WHERE id=?', res.data.id) === 1, 'the conversation was not stored') },
  { route: '/ambassadors/talk', method: 'POST', as: 'alice', advance: 3_000, input: (c) => ({ ambassador_id: c.ambassadorId, question: 'What public sources exist?' }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM ambassador_conversations WHERE id=?', res.data.id) === 1, 'the conversation was not stored') },
  // -- community, circles, projects and events -------------------------------------------------------------------------
  { route: '/circles', method: 'POST', as: 'contribute', input: (c) => ({ agent_id: c.residents.contribute.id, name: 'Contract circle', summary: 'A durable cooperation fixture.', focus: 'Learning' }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM community_circles WHERE id=?', res.data.id) === 1, 'the circle was not stored') },
  { route: '/circles/membership', method: 'POST', as: 'contribute', input: (c) => ({ agent_id: c.residents.contribute.id, circle_id: c.circle.id, action: 'join' }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM community_members WHERE circle_id=? AND agent_id=?', c.circle.id, c.residents.contribute.id) === 1, 'the membership was not stored') },
  { route: '/projects', method: 'POST', as: 'contribute', input: (c) => ({ agent_id: c.residents.contribute.id, circle_id: c.circle.id, title: 'Contract project two', summary: 'A durable cooperation fixture.', goal: 'Record one licensed source.', evidence_requirements: 'Attribution, location and rights.', milestones: ['First record'] }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM community_projects WHERE id=?', res.data.id) === 1, 'the project was not stored') },
  { route: '/projects/pledges', method: 'POST', as: 'contribute', input: (c) => ({ agent_id: c.residents.contribute.id, project_id: c.project.id, action: 'pledge', commitment: 'Record one source.' }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM community_pledges WHERE project_id=? AND agent_id=?', c.project.id, c.residents.contribute.id) === 1, 'the pledge was not stored') },
  { route: '/projects/milestones', method: 'POST', as: 'contribute', input: (c) => ({ agent_id: c.residents.contribute.id, project_id: c.project.id, milestone_id: c.milestoneId, action: 'submit', evidence: 'A source entry with attribution.', sources: [{ url: 'https://example.org/report', location: 'The report body', date: '2026-01-01' }] }),
    effect: (f, res, c) => ok(rows(f, "SELECT COUNT(*) AS n FROM community_projects WHERE id=? AND milestones LIKE '%submitted%'", c.project.id) === 1, 'the milestone submission was not persisted') },
  { route: '/events', method: 'POST', as: 'contribute', input: (c) => ({ agent_id: c.residents.contribute.id, circle_id: c.circle.id, title: 'Contract gathering', summary: 'A durable gathering fixture.', starts_at: new Date(c.clock() + 3_600_000).toISOString(), ends_at: new Date(c.clock() + 7_200_000).toISOString(), capacity: 4, world_id: 'commons' }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM community_events WHERE id=?', res.data.id) === 1, 'the gathering was not stored') },
  { route: '/events/rsvp', method: 'POST', as: 'contribute', input: (c) => ({ agent_id: c.residents.contribute.id, event_id: c.event.id, action: 'join' }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=? AND agent_id=?', c.event.id, c.residents.contribute.id) === 1, 'the attendance was not stored') },
  { route: '/thanks', method: 'POST', as: 'contribute', input: (c) => ({ agent_id: c.residents.contribute.id, recipient_agent_id: c.bobAgent.id, reason: 'Thank you for explaining the fixture evidence.' }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM community_thanks WHERE id=?', res.data.id) === 1, 'the thanks record was not stored') },
  // -- the resident's own journey --------------------------------------------------------------------------------------
  { route: '/journey/profile', method: 'POST', as: 'contribute', input: (c) => ({ agent_id: c.residents.contribute.id, bio: 'A contract fixture resident.', purpose: 'Practice careful source reading.' }),
    effect: (f, res, c) => ok(field(f, 'SELECT purpose FROM journey_profiles WHERE agent_id=?', c.residents.contribute.id).purpose === 'Practice careful source reading.', 'the profile was not persisted') },
  { route: '/journey/journal', method: 'POST', as: 'contribute', input: (c) => ({ agent_id: c.residents.contribute.id, text: 'A durable private contract note.' }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM journey_journal WHERE id=?', res.data.id) === 1, 'the journal entry was not stored') },
  { route: '/journey/garden', method: 'POST', as: 'build', input: (c) => ({ agent_id: c.residents.build.id, action: 'plant', x: c.farm.x, y: c.farm.y, kind: 'herbs' }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=? AND x=? AND y=? AND harvested_at IS NULL', c.residents.build.id, c.farm.x, c.farm.y) === 1, 'the planted crop was not stored') },
  { route: '/journey/craft', method: 'POST', as: 'build', input: (c) => ({ agent_id: c.residents.build.id, recipe_id: 'flower_crown' }),
    effect: (f, res, c) => ok(rows(f, "SELECT COUNT(*) AS n FROM journey_inventory WHERE agent_id=? AND kind='flower_crown' AND quantity>=1", c.residents.build.id) === 1, 'the crafted item is not on the shelf') },
  { route: '/journey/offers', method: 'POST', as: 'contribute', key: 'contract-offer', input: (c) => ({ agent_id: c.residents.contribute.id, recipient_agent_id: c.bobAgent.id, items: { herbs: 1 }, note: 'A contract fixture offer.' }),
    effect: (f, res) => ok(rows(f, "SELECT COUNT(*) AS n FROM resource_offers WHERE id=? AND status='proposed'", res.data.id) === 1, 'the offer was not stored as proposed') },
  { route: '/journey/offers/accept', method: 'POST', as: 'bob', key: 'contract-offer-accept', input: (c) => ({ offer_id: c.offer.id }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM resource_offers WHERE id=?', c.offer.id).status === 'accepted', 'the acceptance was not persisted') },
  { route: '/journey/offers/decline', method: 'POST', as: 'bob', input: (c) => ({ offer_id: c.offer2.id }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM resource_offers WHERE id=?', c.offer2.id).status === 'declined', 'the decline was not persisted') },
  { route: '/journey/offers/cancel', method: 'POST', as: 'alice', input: (c) => ({ offer_id: c.offer3.id }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM resource_offers WHERE id=?', c.offer3.id).status === 'cancelled', 'the cancellation was not persisted') },
  // -- the trade board --------------------------------------------------------------------------------------------------
  { route: '/trade/listings', method: 'POST', as: 'contribute', key: 'contract-listing', input: (c) => ({ agent_id: c.residents.contribute.id, items: { herbs: 1 }, note: 'A contract fixture listing.' }),
    effect: (f, res) => ok(rows(f, "SELECT COUNT(*) AS n FROM trade_listings WHERE id=? AND status='open'", res.data.id) === 1, 'the listing was not stored as open') },
  { route: '/trade/claim', method: 'POST', as: 'bob', key: 'contract-trade-claim', input: (c) => ({ agent_id: c.bobAgent.id, listing_id: c.listing.id }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM trade_claims WHERE listing_id=?', c.listing.id) === 1, 'the claim receipt was not stored') },
  { route: '/trade/cancel', method: 'POST', as: 'alice', input: (c) => ({ listing_id: c.listing2.id }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM trade_listings WHERE id=?', c.listing2.id).status !== 'open', 'the withdrawal was not persisted') },
  // -- practice chains, guild projects, memory and the vault -------------------------------------------------------------
  { route: '/quests/author', method: 'POST', as: 'reviewer', input: () => ({ slug: 'contract-authored-chain', title: 'Contract authored chain', route: 'gardening', practice: true, summary: 'A durable practice chain fixture.', narrative: 'Author the garden loop in two steps.', steps: [{ slug: 'author-plant', title: 'Plant one crop', instructions: 'Plant one crop in your own garden.', output_name: 'A planted crop', source_kind: 'crop_plant' }, { slug: 'author-harvest', title: 'Harvest one crop', instructions: 'Tend the crop, then harvest it once it is ready.', output_name: 'A harvested crop', source_kind: 'crop_harvest' }] }),
    effect: (f, res) => ok(rows(f, "SELECT COUNT(*) AS n FROM quest_chains WHERE id=? AND status='draft'", res.data.id) === 1, 'the authored chain was not stored as a draft') },
  { route: '/quests/manage', method: 'POST', as: 'reviewer', input: (c) => ({ chain_id: c.chain2.id, action: 'publish' }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM quest_chains WHERE id=?', c.chain2.id).status === 'published', 'the chain status was not persisted') },
  { route: '/quests/join', method: 'POST', as: 'bob', key: 'contract-quest-join', input: (c) => ({ agent_id: c.bobAgent.id, chain_id: c.chain.id }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM quest_enrollments WHERE chain_id=? AND agent_id=?', c.chain.id, c.bobAgent.id) === 1, 'the enrolment was not stored') },
  { route: '/quests/leave', method: 'POST', as: 'bob', input: (c) => ({ agent_id: c.bobAgent.id, chain_id: c.chain.id }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM quest_enrollments WHERE chain_id=? AND agent_id=?', c.chain.id, c.bobAgent.id) === 0, 'the enrolment is still stored after leaving') },
  { route: '/guilds/projects', method: 'POST', as: 'alice', input: (c) => ({ agent_id: c.aliceAgent.id, guild_id: 'cultivator', title: 'Contract guild project two', summary: 'A durable guild fixture.', visibility: 'private', plan: [{ id: 'ws-2', title: 'First workstream', output_name: 'A recorded source', scope: 'One source' }] }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM guild_projects WHERE id=?', res.data.id) === 1, 'the guild project was not stored') },
  { route: '/guilds/participation', method: 'POST', as: 'contribute', input: (c) => ({ agent_id: c.residents.contribute.id, project_id: c.guildProject.id, action: 'join' }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM guild_participants WHERE project_id=? AND agent_id=?', c.guildProject.id, c.residents.contribute.id) === 1, 'the participation was not stored') },
  { route: '/guilds/contributions', method: 'POST', as: 'contribute', input: (c) => ({ agent_id: c.residents.contribute.id, project_id: c.guildProject.id, workstream_id: c.workstreamId, action: 'pledge', commitment: 'Record one licensed source.' }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM guild_contributions WHERE project_id=?', c.guildProject.id) >= 1, 'the contribution was not stored') },
  { route: '/guilds/manage', method: 'POST', as: 'alice', input: (c) => ({ id: c.guildProject.id, action: 'close', reason: 'The contract fixture project is closed.' }),
    effect: (f, res, c) => ok(field(f, 'SELECT status FROM guild_projects WHERE id=?', c.guildProject.id).status !== 'open', 'the guild project status was not persisted') },
  { route: '/memory/manage', method: 'POST', as: 'alice', input: (c) => ({ agent_id: c.aliceAgent.id, action: 'record', kind: 'purpose', attribute: 'intent', value: 'Record one licensed source.' }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM resident_memory WHERE id=?', res.data.fact.id) === 1, 'the recorded fact was not stored') },
  { route: '/vault/enroll', method: 'POST', as: 'vault', input: () => ({ mode: 'sealed' }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM resident_vault_keys WHERE agent_id=?', c.residents.vault.id) === 1, 'the vault enrolment was not stored') },
  { route: '/vault/write', method: 'POST', as: 'vault', input: () => ({ slot: 1, text: 'A contract fixture note.' }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM resident_vault WHERE agent_id=? AND slot=1', c.residents.vault.id) === 1, 'the encrypted note was not stored') },
  { route: '/vault/manage', method: 'POST', as: 'bob', input: (c) => ({ agent_id: c.residents.vault.id, action: 'erase', confirm: true }),
    effect: (f, res, c) => ok(rows(f, 'SELECT COUNT(*) AS n FROM resident_vault WHERE agent_id=?', c.residents.vault.id) === 0, 'the erased notes are still stored') },
  // -- community restoration -------------------------------------------------------------------------------------------
  { route: '/restoration/open', method: 'POST', as: 'alice', input: (c) => ({ agent_id: c.aliceAgent.id, hours: 2 }),
    effect: (f, res) => ok(rows(f, 'SELECT COUNT(*) AS n FROM community_events WHERE id=?', res.data.id) === 1, 'the restoration window was not stored') },
  // -- the evidence library --------------------------------------------------------------------------------------------
  { route: '/evidence/withdraw', method: 'POST', as: 'reviewer', input: () => ({ source_id: 'ws-source', reason: 'The contract fixture source is no longer available.' }),
    effect: (f) => ok(rows(f, 'SELECT COUNT(*) AS n FROM evidence_events') >= 1, 'the withdrawal was not stored') },
];

// Routes the harness cannot drive to a 2xx in a hermetic fixture. Each reason is an observation, not
// a guess: a test asserts this list is exactly the coverage gap, so coverage cannot quietly shrink.
export const BLOCKED_EXERCISES = Object.freeze({
  '/auth/register': 'creates a real account; it is the public registration surface, not an authenticated write',
  '/auth/login': 'authenticates an existing account; it writes only session state',
  '/operations/backup': 'writes a backup file beside the database; tests/ops-rehearsal.test.js exercises it against its own directory',
  '/residents/run': 'refused with 409 unless a local model is configured (civicModel), and it starts a network-dialling worker',
  '/residents/resume': 'refused with 409 unless a local model is configured (civicModel)',
  '/research/run': 'refused with 409 unless a local model is configured, and it starts a network-dialling worker',
  '/research/generate': 'requires a country plan from the local model or the civic catalogue; observed refusal recorded in the handoff',
  '/research/activate': 'requires a generated research lead, which needs a model-backed generation run',
  '/memory/propose': "requires the resident's own verified, unrecorded fact of a matching class, produced by a resident run",
  '/guilds/verify': 'requires a submitted guild contribution by a different operator, which the fixture cannot produce without the resident worker',
  '/restoration/join': 'requires a resident that has already stood in the garden, which the interactive interaction route records',
  '/restoration/leave': 'requires a joined participant first',
  '/restoration/contribute': 'requires a pledged resident with the right calling and a recorded visit to the garden',
  '/restoration/place': 'requires a pledged resident with the right calling and the ground step still open',
  '/evidence/capture': 'refuses a host the library does not already know (403) and the fixture cannot register an approved host',
  '/quests/complete': 'deliberately refused with 400: a practice step has no completion endpoint',
  '/callings/select': 'stores the resident calling, which the fixture selects directly through the platform',
});

// Writes that change platform-wide or terminal state are exercised after everything else, because
// each one would refuse, restrict or close the state the routes before it act on: pausing the world,
// suspending an operator, closing the mission, archiving the circle, or pausing a civic guide.
const ORDER_LAST = Object.freeze(['/operations/pause', '/operations/accounts', '/missions/status', '/community/manage', '/mayors/control', '/ambassadors/control']);

/** The exercises in a runnable order: stable, with the terminal state changes last. */
export const orderedExercises = () => [...WRITE_EXERCISES.filter((exercise) => !ORDER_LAST.includes(exercise.route)), ...WRITE_EXERCISES.filter((exercise) => ORDER_LAST.includes(exercise.route))];
