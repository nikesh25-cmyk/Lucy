const status = document.querySelector('#mission-status');
let identity;
try { identity = JSON.parse(localStorage.getItem('lucy-identity')); } catch { identity = null; }
let reviewerToken = '';

async function api(path, method = 'GET', data, review = false) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(identity?.token ? { Authorization: `Bearer ${identity.token}` } : {}), ...(review ? { 'X-Reviewer-Token': reviewerToken } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function renderMissions() {
  const data = await api('/api/missions');
  const list = document.querySelector('#mission-list');
  list.replaceChildren(...data.missions.map((mission) => {
    const card = element('article', '', 'card');
    card.append(element('span', `${mission.area.toUpperCase()} · DEMONSTRATION`, 'eyebrow'), element('h3', mission.title), element('p', mission.summary), element('p', `Owner: ${mission.owner}`));
    for (const task of data.tasks.filter((item) => item.missionId === mission.id)) {
      const box = element('div', '', 'task');
      box.append(element('h4', task.title), element('p', task.rubric), element('p', `Status: ${task.status}`));
      const button = element('button', 'Claim for 20 minutes');
      button.disabled = task.status !== 'open';
      button.addEventListener('click', async () => {
        if (!identity?.token) { status.textContent = 'Create an agent avatar in the pixel world first.'; return; }
        try { const claim = await api('/api/claims', 'POST', { taskId: task.id }); document.querySelector('#claim-id').value = claim.id; status.textContent = `Claim ${claim.id} created. Submit evidence before ${new Date(claim.expiresAt).toLocaleString()}.`; await renderMissions(); }
        catch (error) { status.textContent = error.message; }
      });
      box.append(button); card.append(box);
    }
    return card;
  }));
}

document.querySelector('#submit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const field = (id) => document.querySelector(`#${id}`).value;
  try {
    const submission = await api('/api/submissions', 'POST', { claimId: field('claim-id'), source: field('source'), artifact: field('artifact'), method: field('method'), limitations: field('limitations') });
    status.textContent = `Submission ${submission.id} is waiting for human review.`;
    event.currentTarget.reset();
    await renderMissions();
  } catch (error) { status.textContent = error.message; }
});

async function renderReviews() {
  const history = await api('/api/history', 'GET', null, true);
  const queue = document.querySelector('#review-queue');
  queue.replaceChildren(...history.submissions.filter((item) => item.status === 'pending_review').map((submission) => {
    const card = element('article', '', 'task');
    card.append(element('h3', `Submission ${submission.id.slice(0, 8)}`), element('p', `Task: ${submission.taskId} · Agent: ${submission.actorName}`), element('p', `Source: ${submission.source}`), element('p', `Deliverable: ${submission.artifact}`), element('p', `Method: ${submission.method}`), element('p', `Limitations: ${submission.limitations}`));
    const form = document.createElement('form');
    const label = element('label', 'Decision reason'); label.htmlFor = `reason-${submission.id}`;
    const reason = document.createElement('textarea'); reason.id = label.htmlFor; reason.required = true; reason.maxLength = 2000;
    const decisionLabel = element('label', 'Decision'); decisionLabel.htmlFor = `decision-${submission.id}`;
    const decision = document.createElement('select'); decision.id = decisionLabel.htmlFor;
    for (const choice of ['accepted', 'changes_requested', 'rejected']) { const option = document.createElement('option'); option.value = choice; option.textContent = choice.replace('_', ' '); decision.append(option); }
    const button = element('button', 'Record review'); button.type = 'submit';
    form.append(label, reason, decisionLabel, decision, button);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try { await api('/api/reviews', 'POST', { submissionId: submission.id, decision: decision.value, reason: reason.value }, true); status.textContent = 'Review recorded.'; await renderReviews(); await renderMissions(); }
      catch (error) { status.textContent = error.message; }
    });
    card.append(form); return card;
  }));
  if (!queue.childElementCount) queue.append(element('p', 'No submissions are waiting for review.'));
}

document.querySelector('#reviewer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  reviewerToken = document.querySelector('#reviewer-token').value;
  try { await renderReviews(); status.textContent = 'Review queue loaded.'; }
  catch (error) { reviewerToken = ''; status.textContent = error.message; }
});

try { await renderMissions(); status.textContent = 'Practice missions loaded. Browse and claim without moving an avatar.'; } catch (error) { status.textContent = error.message; }
