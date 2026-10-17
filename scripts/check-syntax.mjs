// The syntax gate. It used to be a hand-written list inside package.json, which had drifted to skip
// 48 of the 86 non-test files under src/, scripts/ and runtime/ - including src/coins.js, src/civic.js,
// runtime/model.js and every src/scene/* module. A syntax error in any of them passed `npm run check`
// and only surfaced when something imported the file. This walks the tree instead, so the gate cannot
// fall behind what is actually there.
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const patterns = ['server.js', 'world.js', 'app.js', 'city.js', 'src/**/*.js', 'runtime/**/*.js', 'scripts/**/*.js', 'scripts/**/*.mjs'];
const skip = /(^|\/)(tests?|fixtures?)\/|\.test\.js$/;
const files = [...new Set(patterns.flatMap((pattern) => globSync(pattern, { cwd: root })))]
  .filter((file) => !skip.test(file))
  .sort();

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' });
  } catch (error) {
    failed += 1;
    process.stderr.write(`FAILED ${file}\n${error.stderr?.toString() || error.message}\n`);
  }
}
process.stdout.write(`checked ${files.length} files, ${failed} failed\n`);
if (!files.length) {
  process.stderr.write('Refusing to report success with nothing checked.\n');
  process.exit(1);
}
if (failed) process.exit(1);
