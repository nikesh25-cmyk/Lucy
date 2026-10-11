import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SharedWorld } from './shared-world.js';

const root = dirname(fileURLToPath(import.meta.url));
const world = new SharedWorld(process.env.LUCY_DATA_FILE || join(root, 'data', 'world.json'));
await world.load();
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/world.js': ['world.js', 'text/javascript; charset=utf-8'],
  '/shared-world-client.js': ['shared-world-client.js', 'text/javascript; charset=utf-8'],
};

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
}

async function body(request) {
  let input = '';
  for await (const chunk of request) {
    input += chunk;
    if (input.length > 4096) throw Object.assign(new Error('Request too large.'), { status: 413 });
  }
  try { return JSON.parse(input); }
  catch { throw Object.assign(new Error('Expected JSON.'), { status: 400 }); }
}

export const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    try {
      if (path === '/api/world' && request.method === 'GET') return json(response, 200, world.view(request.headers.authorization?.replace(/^Bearer /, '')));
      if (path === '/api/participants/me' && request.method === 'DELETE') return json(response, 200, await world.transact(() => world.leave(request.headers.authorization?.replace(/^Bearer /, ''))));
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
    console.log(`Lucy is ready on port ${server.address().port}`);
  });
}
