import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const MAGIC = Buffer.from('NEMOBK01');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + NONCE_BYTES;

function regular(path) {
  const file = resolve(path);
  if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('Expected an existing regular file.');
  return file;
}

export function generateBackupKey(path) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, randomBytes(32), { flag: 'wx', mode: 0o600 });
  return { path: target };
}

export function readBackupKey(path) {
  const file = regular(path);
  if ((statSync(file).mode & 0o077) !== 0) throw new Error('Backup key file must be owner-only.');
  const key = readFileSync(file);
  if (key.length !== 32) throw new Error('Backup key file must contain exactly 32 random bytes.');
  return key;
}

export async function encryptBackupFile(source, destination, key) {
  const input = regular(source), output = resolve(destination);
  if (input === output) throw new Error('Backup source and encrypted destination must differ.');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('An exact 32-byte backup key is required.');
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const nonce = randomBytes(NONCE_BYTES), header = Buffer.concat([MAGIC, nonce]);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  let started = false;
  const seal = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        if (!started) { this.push(header); started = true; }
        this.push(cipher.update(chunk)); callback();
      } catch (error) { callback(error); }
    },
    flush(callback) {
      try {
        if (!started) this.push(header);
        this.push(cipher.final()); this.push(cipher.getAuthTag()); callback();
      } catch (error) { callback(error); }
    },
  });
  const fd = openSync(output, 'wx', 0o600);
  try {
    await pipeline(createReadStream(input), seal, createWriteStream(output, { fd, autoClose: true }));
    return { path: output, format: MAGIC.toString() };
  } catch (error) {
    if (existsSync(output)) unlinkSync(output);
    throw error;
  }
}

export async function decryptBackupFile(source, destination, key) {
  const input = regular(source), output = resolve(destination);
  if (input === output) throw new Error('Encrypted source and restore staging path must differ.');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('An exact 32-byte backup key is required.');
  const size = statSync(input).size;
  if (size < HEADER_BYTES + TAG_BYTES + 1) throw new Error('Encrypted backup is incomplete.');
  const fd = openSync(input, 'r');
  let header, tag;
  try {
    header = Buffer.alloc(HEADER_BYTES); tag = Buffer.alloc(TAG_BYTES);
    if (readSync(fd, header, 0, HEADER_BYTES, 0) !== HEADER_BYTES || readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES) !== TAG_BYTES) throw new Error('Encrypted backup is incomplete.');
  } finally { closeSync(fd); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Unknown encrypted backup format.');
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
  decipher.setAAD(header); decipher.setAuthTag(tag);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const targetFd = openSync(output, 'wx', 0o600);
  try {
    await pipeline(createReadStream(input, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }), decipher, createWriteStream(output, { fd: targetFd, autoClose: true }));
    return { path: output };
  } catch (error) {
    if (existsSync(output)) unlinkSync(output);
    throw new Error('Encrypted backup authentication failed or output could not be written.', { cause: error });
  }
}
