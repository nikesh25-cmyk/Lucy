#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { backupDatabase, restoreDatabase, validateDatabase, acquireProcessLock } from '../src/recovery.js';

const [command, source, destination] = process.argv.slice(2);
try {
  if (command === 'verify' && source && !destination) {
    console.log(JSON.stringify(validateDatabase(resolve(source))));
  } else if (command === 'restore' && source && destination) {
    console.log(JSON.stringify(restoreDatabase(source, destination)));
  } else if (command === 'backup' && source && destination) {
    validateDatabase(resolve(source));
    const release = acquireProcessLock(resolve(dirname(source), 'server.lock'));
    let db;
    try {
      db = new DatabaseSync(resolve(source));
      console.log(JSON.stringify(backupDatabase(db, destination)));
    } finally { db?.close(); release(); }
  } else {
    throw new Error('Usage: node scripts/recovery.js verify DATABASE | backup DATABASE BACKUP | restore BACKUP DATABASE. Stop the server before CLI backup or restore; live backups are available in the admin console.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
