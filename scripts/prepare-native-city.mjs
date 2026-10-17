#!/usr/bin/env node
// Packaging only: no live config edits, process control, or overwrite of existing output files.
import { lstatSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadNativeCityComposition } from '../src/veloren-ext/city-composition.js';

function main(args) {
  if (args.length !== 2 || args[0] !== '--output-dir' || !args[1] || args[1].startsWith('--')) {
    throw new Error('Usage: node scripts/prepare-native-city.mjs --output-dir DIRECTORY');
  }
  const output = resolve(args[1]);
  const documents = loadNativeCityComposition();
  const paths = Object.fromEntries(Object.keys(documents).map(key => [key, join(output, `${key}.json`)]));
  for (const path of Object.values(paths)) {
    try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Refusing existing output: ${path}`);
  }
  mkdirSync(output, {recursive: true});
  const created = [];
  try {
    for (const [key,path] of Object.entries(paths)) {
      const fd = openSync(path, 'wx', 0o600);
      created.push(path);
      try { writeFileSync(fd, `${JSON.stringify(documents[key], null, 2)}\n`); } finally { closeSync(fd); }
    }
  } catch (error) {
    // Remove only new files this invocation successfully reserved; existing files are untouched.
    for (const path of created) { try { unlinkSync(path); } catch {} }
    throw error;
  }
  process.stdout.write(`${JSON.stringify(paths)}\n`);
}
try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode=1; }
