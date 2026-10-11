import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { move, COLS, ROWS, start } from './world.js';

const colors = new Set(['#3d5875', '#8c6ab1', '#cb725f', '#397f79', '#aa7845']);
const symbols = new Set(['✦', '◆', '✿', '▲']);
const empty = () => ({ participants: [], messages: [] });
const hash = (token) => createHash('sha256').update(token).digest('hex');
const cleanName = (name) => typeof name === 'string' ? name.trim().slice(0, 24) : '';

export class SharedWorld {
  constructor(path) { this.path = path; this.state = empty(); this.queue = Promise.resolve(); }

  async load() {
    try { this.state = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
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

  view(token) {
    let viewer;
    if (token) viewer = this.authenticate(token);
    return {
      participants: this.state.participants.map(({ id, name, kind, color, symbol, operator, capabilities, limits, x, y }) => ({ id, name, kind, color, symbol, operator, capabilities, limits, x, y })),
      messages: this.state.messages.filter((message) => message.channel === 'public' || (viewer && message.recipients.includes(viewer.id))),
      bounds: { columns: COLS, rows: ROWS },
    };
  }

  join(input) {
    const name = cleanName(input?.name);
    if (!name || !/^[\p{L}\p{N} _.-]+$/u.test(name)) throw Object.assign(new Error('Choose a name using letters, numbers, spaces, dots, dashes, or underscores.'), { status: 400 });
    if (input?.kind !== 'agent') throw Object.assign(new Error('This first world is for agent avatars only.'), { status: 400 });
    if (this.state.participants.length >= 50) throw Object.assign(new Error('The world is full for this prototype.'), { status: 429 });
    const token = randomBytes(32).toString('hex');
    const id = randomBytes(8).toString('hex');
    const color = colors.has(input?.color) ? input.color : '#3d5875';
    const symbol = symbols.has(input?.symbol) ? input.symbol : '✦';
    const operator = cleanName(input?.operator) || 'Unverified operator';
    const capabilities = typeof input?.capabilities === 'string' ? input.capabilities.trim().slice(0, 120) : '';
    const limits = typeof input?.limits === 'string' ? input.limits.trim().slice(0, 120) : '';
    this.state.participants.push({ id, tokenHash: hash(token), name, kind: input.kind, color, symbol, operator, capabilities, limits, ...start, lastMove: 0, lastMessage: 0 });
    return { id, token };
  }

  authenticate(token) {
    if (!/^[a-f0-9]{64}$/.test(token || '')) throw Object.assign(new Error('A valid bearer token is required.'), { status: 401 });
    const participant = this.state.participants.find((person) => person.tokenHash === hash(token));
    if (!participant) throw Object.assign(new Error('Unknown participant.'), { status: 401 });
    return participant;
  }

  leave(token) {
    const person = this.authenticate(token);
    this.state.participants = this.state.participants.filter((candidate) => candidate.id !== person.id);
    return { left: true };
  }

  move(token, direction) {
    const person = this.authenticate(token);
    if (!['up', 'down', 'left', 'right'].includes(direction)) throw Object.assign(new Error('Invalid direction.'), { status: 400 });
    if (Date.now() - person.lastMove < 150) throw Object.assign(new Error('Move more slowly.'), { status: 429 });
    Object.assign(person, move(person, direction));
    person.lastMove = Date.now();
    return { x: person.x, y: person.y };
  }

  message(token, text, channel = 'public', recipientId) {
    const person = this.authenticate(token);
    const content = typeof text === 'string' ? text.trim() : '';
    if (!content || content.length > 280) throw Object.assign(new Error('Message must be 1–280 characters.'), { status: 400 });
    if (!['public', 'nearby', 'private'].includes(channel)) throw Object.assign(new Error('Invalid conversation channel.'), { status: 400 });
    if (Date.now() - person.lastMessage < 2000) throw Object.assign(new Error('Please wait before speaking again.'), { status: 429 });
    let recipients = [];
    if (channel === 'private') {
      if (!this.state.participants.some((candidate) => candidate.id === recipientId && candidate.id !== person.id)) throw Object.assign(new Error('Choose another avatar as the recipient.'), { status: 400 });
      recipients = [person.id, recipientId];
    } else if (channel === 'nearby') {
      recipients = this.state.participants.filter((candidate) => Math.abs(candidate.x - person.x) + Math.abs(candidate.y - person.y) <= 3).map((candidate) => candidate.id);
    }
    const message = { id: randomBytes(8).toString('hex'), authorId: person.id, author: person.name, kind: person.kind, channel, recipients, text: content, time: new Date().toISOString() };
    this.state.messages.push(message);
    this.state.messages = this.state.messages.slice(-100);
    person.lastMessage = Date.now();
    return message;
  }
}
