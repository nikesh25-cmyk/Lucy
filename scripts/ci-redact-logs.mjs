#!/usr/bin/env node
// CI log redactor and artifact sanitizer.
// Scans test results and log files to ensure no passwords, session tokens,
// private keys, or raw SQLite database files are uploaded as CI artifacts.

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const REDACTION_PATTERNS = [
  // Passwords and secrets
  /password-[\w-]+/gi,
  /(?:password|passwd|token|secret|authorization|auth_token)\s*[:=]\s*["']?([^\s"']+)["']?/gi,
  // Bearer tokens and session nonces
  /Bearer\s+[a-zA-Z0-9_\-.]+/gi,
  // Private keys and HMAC keys
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
  // Emails in logs
  /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/gi,
];

const FORBIDDEN_EXTENSIONS = ['.sqlite', '.sqlite-wal', '.sqlite-shm', '.db', '.key', '.pem', '.env'];

export function sanitizeDirectory(dir) {
  if (!existsSync(dir)) return { processed: 0, removed: 0 };
  let processed = 0;
  let removed = 0;

  function walk(currentDir) {
    const entries = readdirSync(currentDir);
    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        // Remove forbidden binary / database files immediately
        const lower = entry.toLowerCase();
        if (FORBIDDEN_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
          unlinkSync(fullPath);
          removed++;
          continue;
        }

        // Sanitize text files
        if (lower.endsWith('.log') || lower.endsWith('.txt') || lower.endsWith('.json') || lower.endsWith('.xml')) {
          try {
            let content = readFileSync(fullPath, 'utf8');
            let modified = false;
            for (const pattern of REDACTION_PATTERNS) {
              if (pattern.test(content)) {
                content = content.replace(pattern, '[REDACTED]');
                modified = true;
              }
            }
            if (modified) {
              writeFileSync(fullPath, content, 'utf8');
              processed++;
            }
          } catch {
            // Ignore unreadable files
          }
        }
      }
    }
  }

  walk(dir);
  return { processed, removed };
}

if (process.argv[1] && process.argv[1].endsWith('ci-redact-logs.mjs')) {
  const targetDir = process.argv[2] || 'test-results';
  const result = sanitizeDirectory(targetDir);
  console.log(`Log sanitizer: scanned ${targetDir} (redacted ${result.processed} text files, removed ${result.removed} sensitive files).`);
}
