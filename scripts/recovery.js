#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { backupDatabase, restoreDatabase, validateDatabase, acquireProcessLock } from '../src/recovery.js';
import { decryptBackupFile, encryptBackupFile, generateBackupKey, readBackupKey } from '../src/encrypted-backup.js';

const [command, source, destination, keyFile] = process.argv.slice(2);
try {
  if (command === 'keygen' && source && !destination) {
    console.log(JSON.stringify(generateBackupKey(source)));
  } else if (command === 'verify' && source && !destination) {
    console.log(JSON.stringify(validateDatabase(resolve(source))));
  } else if (command === 'verify-encrypted' && source && destination && !keyFile) {
    const key = readBackupKey(destination);
    const directory = mkdtempSync(join(tmpdir(), 'nemoworld-verify-encrypted-'));
    try {
      const temporary = join(directory, 'world.sqlite');
      await decryptBackupFile(source, temporary, key);
      console.log(JSON.stringify(validateDatabase(temporary)));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  } else if (command === 'restore' && source && destination) {
    console.log(JSON.stringify(restoreDatabase(source, destination)));
  } else if (command === 'restore-encrypted' && source && destination && keyFile) {
    const key = readBackupKey(keyFile);
    const temporary = resolve(dirname(destination), `.${basename(destination)}.encrypted-restore-${randomUUID()}.sqlite`);
    try {
      await decryptBackupFile(source, temporary, key);
      console.log(JSON.stringify(restoreDatabase(temporary, destination)));
    } finally { rmSync(temporary, { force: true }); }
  } else if (command === 'backup' && source && destination) {
    validateDatabase(resolve(source));
    const release = acquireProcessLock(resolve(dirname(source), 'server.lock'));
    let db;
    try {
      db = new DatabaseSync(resolve(source));
      console.log(JSON.stringify(backupDatabase(db, destination)));
    } finally { db?.close(); release(); }
  } else if (command === 'backup-encrypted' && source && destination && keyFile) {
    const input = resolve(source), key = readBackupKey(keyFile);
    validateDatabase(input);
    const release = acquireProcessLock(resolve(dirname(input), 'server.lock'));
    const temporary = resolve(dirname(input), `.${basename(input)}.encrypted-stage-${randomUUID()}.sqlite`);
    let db;
    try {
      db = new DatabaseSync(input);
      backupDatabase(db, temporary);
      console.log(JSON.stringify(await encryptBackupFile(temporary, destination, key)));
    } finally { db?.close(); rmSync(temporary, { force: true }); release(); }
  } else {
    throw new Error('Usage: recovery.js keygen KEYFILE | verify DATABASE | backup DATABASE BACKUP | restore BACKUP DATABASE | backup-encrypted DATABASE ENCRYPTED KEYFILE | verify-encrypted ENCRYPTED KEYFILE | restore-encrypted ENCRYPTED DATABASE KEYFILE. Stop the server before CLI backup or restore; live backups are available in the admin console.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
