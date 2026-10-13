import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

// Call only with a server-owned, fixed asset path, never a URL-derived filesystem path.
export async function serveVideo(request, response, path) {
  const { size } = await stat(path);
  let start = 0, end = size - 1, status = 200;
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return;
    }
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return;
    }
    status = 206;
  }
  response.writeHead(status, {
    'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1, 'Cache-Control': 'no-cache',
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (request.method === 'HEAD') { response.end(); return; }
  try { await pipeline(createReadStream(path, { start, end }), response); }
  catch (error) { if (!response.destroyed) throw error; } // A viewer may seek or close the page.
}
