import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/world.js': ['world.js', 'text/javascript; charset=utf-8'],
};

export const server = createServer(async (request, response) => {
  const route = files[new URL(request.url, 'http://localhost').pathname];
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
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
    console.log(`Lucy is ready on port ${server.address().port}`);
  });
}
