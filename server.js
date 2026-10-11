import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SharedWorld } from './shared-world.js';
import { MissionBoard } from './mission-board.js';

const root = dirname(fileURLToPath(import.meta.url));
const world = new SharedWorld(process.env.LUCY_DATA_FILE || join(root, 'data', 'world.json'));
await world.load();
const missions = new MissionBoard(process.env.LUCY_MISSIONS_FILE || join(root, 'data', 'missions.json'), process.env.LUCY_REVIEW_TOKEN_FILE || join(root, 'data', 'reviewer-token'));
await missions.load();
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/world.js': ['world.js', 'text/javascript; charset=utf-8'],
  '/shared-world-client.js': ['shared-world-client.js', 'text/javascript; charset=utf-8'],
  '/missions': ['missions.html', 'text/html; charset=utf-8'],
  '/missions-client.js': ['missions-client.js', 'text/javascript; charset=utf-8'],
};

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
}

async function body(request) {
  let input = '';
  for await (const chunk of request) {
    input += chunk;
    if (input.length > 12000) throw Object.assign(new Error('Request too large.'), { status: 413 });
  }
  try { return JSON.parse(input); }
  catch { throw Object.assign(new Error('Expected JSON.'), { status: 400 }); }
}

export const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    try {
      if (path === '/api/world' && request.method === 'GET') {
        const view = world.view(request.headers.authorization?.replace(/^Bearer /, ''));
        const counts = missions.acceptedCounts();
        view.participants = view.participants.map((person) => ({ ...person, acceptedContributions: counts[person.id] || 0 }));
        return json(response, 200, view);
      }
      if (path === '/api/missions' && request.method === 'GET') return json(response, 200, missions.list());
      if (path === '/api/history' && request.method === 'GET') {
        const token = request.headers.authorization?.replace(/^Bearer /, '');
        if (request.headers['x-reviewer-token']) return json(response, 200, missions.history(null, request.headers['x-reviewer-token']));
        return json(response, 200, missions.history(world.authenticate(token).id));
      }
      if (path === '/api/participants/me' && request.method === 'DELETE') return json(response, 200, await world.transact(() => world.leave(request.headers.authorization?.replace(/^Bearer /, ''))));
      if (request.method === 'POST' && ['/api/claims', '/api/claims/release', '/api/submissions', '/api/reviews'].includes(path)) {
        const input = await body(request);
        if (path === '/api/reviews') return json(response, 201, await missions.transact(() => missions.review(input?.submissionId, input?.decision, input?.reason, request.headers['x-reviewer-token'])));
        const actor = world.authenticate(request.headers.authorization?.replace(/^Bearer /, ''));
        if (path === '/api/claims') return json(response, 201, await missions.transact(() => missions.claim(input?.taskId, actor)));
        if (path === '/api/claims/release') return json(response, 200, await missions.transact(() => missions.release(input?.claimId, actor)));
        return json(response, 201, await missions.transact(() => missions.submit(input?.claimId, actor, input)));
      }
      const actions = { '/api/join': 'join', '/api/move': 'move', '/api/messages': 'message' };
      if (request.method !== 'POST' || !actions[path]) return json(response, 404, { error: 'Not found' });
      const input = await body(request);
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      const result = await world.transact(() => {
        if (path === '/api/join') return world.join(input);
        if (path === '/api/move') return world.move(token, input?.direction);
        return world.message(token, input?.text, input?.channel, input?.recipientId);
      });
      return json(response, path === '/api/join' ? 201 : 200, result);
    } catch (error) { return json(response, error.status || 500, { error: error.status ? error.message : 'Server error' }); }
  }
  if (request.method !== 'GET') return response.writeHead(405).end('Method not allowed');
  const route = files[path];
  if (!route) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const contents = await readFile(join(root, route[0]));
    response.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-cache' }).end(contents);
  } catch {
    response.writeHead(500).end('Unable to load world');
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => {
    console.log(`Shared World is ready on port ${server.address().port}`);
  });
}
