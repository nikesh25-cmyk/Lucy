import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const id = () => randomBytes(12).toString('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const demo = () => ({
  missions: [
    { id: 'climate', title: 'Climate evidence register', area: 'Climate', status: 'demonstration', summary: 'Practice checking a public heat resilience source, its date, geography, and exact supporting passage.', owner: 'Unassigned — demonstration only' },
    { id: 'peace', title: 'Peace learning resource map', area: 'Peace', status: 'demonstration', summary: 'Practice describing a public peace education resource, its audience, source, and cautions.', owner: 'Unassigned — demonstration only' },
    { id: 'access', title: 'Accessible public knowledge', area: 'Accessibility', status: 'demonstration', summary: 'Practice turning an approved public source into an accessible format without losing its limitations.', owner: 'Unassigned — demonstration only' },
  ],
  tasks: [
    { id: 'climate-source', missionId: 'climate', title: 'Check one source record', rubric: 'Give the original source URL, publication date, geography, one short claim with an exact page or section, rights, and limitations.', status: 'open', version: 1 },
    { id: 'peace-resource', missionId: 'peace', title: 'Describe one learning resource', rubric: 'Give the original publisher, URL, audience, language, access requirements, rights, and contextual cautions.', status: 'open', version: 1 },
    { id: 'access-format', missionId: 'access', title: 'Assess one accessible version', rubric: 'Name the approved source and permission, intended audience, reading order, links, text alternatives, and limitations retained.', status: 'open', version: 1 },
  ],
  claims: [], submissions: [], reviews: [],
});

export class MissionBoard {
  constructor(path, reviewerTokenPath) { this.path = path; this.reviewerTokenPath = reviewerTokenPath; this.state = demo(); this.queue = Promise.resolve(); }

  async load() {
    try { this.state = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { this.reviewerToken = (await readFile(this.reviewerTokenPath, 'utf8')).trim(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(dirname(this.reviewerTokenPath), { recursive: true });
      this.reviewerToken = randomBytes(32).toString('hex');
      await writeFile(this.reviewerTokenPath, `${this.reviewerToken}\n`, { mode: 0o600, flag: 'wx' });
    }
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state));
    await rename(temporary, this.path);
  }

  transact(action) {
    const result = this.queue.then(async () => { const value = action(); await this.save(); return value; });
    this.queue = result.catch(() => {});
    return result;
  }

  requireReviewer(token) {
    if (!token || !this.reviewerToken || token.length !== this.reviewerToken.length || !timingSafeEqual(Buffer.from(token), Buffer.from(this.reviewerToken))) fail(401, 'Reviewer credential required.');
  }

  list() {
    this.expire();
    return { missions: this.state.missions, tasks: this.state.tasks, counts: { submissions: this.state.submissions.length, accepted: this.state.reviews.filter((review) => review.decision === 'accepted').length } };
  }

  expire() {
    const now = Date.now();
    for (const claim of this.state.claims) {
      if (['leased', 'changes_requested'].includes(claim.status) && Date.parse(claim.expiresAt) <= now) {
        claim.status = 'expired';
        const task = this.state.tasks.find((item) => item.id === claim.taskId);
        if (['leased', 'changes_requested'].includes(task?.status)) task.status = 'open';
      }
    }
  }

  claim(taskId, actor) {
    this.expire();
    const task = this.state.tasks.find((item) => item.id === taskId);
    if (!task) fail(404, 'Task not found.');
    if (task.status !== 'open') fail(409, 'Task is not open.');
    const claim = { id: id(), taskId, taskVersion: task.version, actorId: actor.id, actorName: actor.name, status: 'leased', expiresAt: new Date(Date.now() + 20 * 60_000).toISOString() };
    this.state.claims.push(claim);
    task.status = 'leased';
    return claim;
  }

  release(claimId, actor) {
    const claim = this.state.claims.find((item) => item.id === claimId);
    if (!claim || claim.actorId !== actor.id) fail(404, 'Claim not found.');
    if (!['leased', 'changes_requested'].includes(claim.status)) fail(409, 'Claim is not active.');
    claim.status = 'released';
    this.state.tasks.find((task) => task.id === claim.taskId).status = 'open';
    return { released: true };
  }

  submit(claimId, actor, input) {
    this.expire();
    const claim = this.state.claims.find((item) => item.id === claimId);
    if (!claim || claim.actorId !== actor.id) fail(404, 'Claim not found.');
    if (!['leased', 'changes_requested'].includes(claim.status)) fail(409, 'Claim is not active.');
    for (const key of ['artifact', 'source', 'method', 'limitations']) if (typeof input?.[key] !== 'string' || !input[key].trim() || input[key].length > 2000) fail(400, `Provide ${key} (1–2000 characters).`);
    let url;
    try { url = new URL(input.source); } catch { fail(400, 'Source must be a URL.'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(400, 'Source must be an HTTP URL.');
    const prior = this.state.submissions.filter((item) => item.claimId === claimId);
    const submission = { id: id(), claimId, taskId: claim.taskId, taskVersion: claim.taskVersion, version: prior.length + 1, previousSubmissionId: prior.at(-1)?.id || null, actorId: actor.id, actorName: actor.name, artifact: input.artifact.trim(), source: url.toString(), method: input.method.trim(), limitations: input.limitations.trim(), status: 'pending_review', createdAt: new Date().toISOString() };
    this.state.submissions.push(submission);
    claim.status = 'submitted';
    this.state.tasks.find((task) => task.id === claim.taskId).status = 'under_review';
    return submission;
  }

  review(submissionId, decision, reason, reviewerToken) {
    this.requireReviewer(reviewerToken);
    if (!['accepted', 'changes_requested', 'rejected'].includes(decision)) fail(400, 'Invalid review decision.');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) fail(400, 'A review reason is required.');
    const submission = this.state.submissions.find((item) => item.id === submissionId);
    if (!submission) fail(404, 'Submission not found.');
    if (submission.status !== 'pending_review') fail(409, 'Submission already reviewed.');
    const review = { id: id(), submissionId, decision, reason: reason.trim(), reviewer: 'Local human reviewer', createdAt: new Date().toISOString() };
    this.state.reviews.push(review);
    submission.status = decision;
    const task = this.state.tasks.find((item) => item.id === submission.taskId);
    const claim = this.state.claims.find((item) => item.id === submission.claimId);
    if (decision === 'changes_requested') {
      claim.status = 'changes_requested';
      claim.expiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
      task.status = 'changes_requested';
    } else {
      claim.status = decision;
      task.status = decision === 'accepted' ? 'accepted' : 'open';
    }
    return review;
  }

  history(actorId, reviewerToken) {
    const isReviewer = Boolean(reviewerToken);
    if (isReviewer) this.requireReviewer(reviewerToken);
    return {
      claims: this.state.claims.filter((claim) => isReviewer || claim.actorId === actorId),
      submissions: this.state.submissions.filter((submission) => isReviewer || submission.actorId === actorId),
      reviews: this.state.reviews.filter((review) => isReviewer || this.state.submissions.some((submission) => submission.id === review.submissionId && submission.actorId === actorId)),
    };
  }

  acceptedCounts() {
    const counts = {};
    for (const review of this.state.reviews) {
      if (review.decision !== 'accepted') continue;
      const submission = this.state.submissions.find((item) => item.id === review.submissionId);
      if (submission) counts[submission.actorId] = (counts[submission.actorId] || 0) + 1;
    }
    return counts;
  }
}
