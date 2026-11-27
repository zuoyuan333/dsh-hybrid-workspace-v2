import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SUITES = [
  'autocreate.test.mjs',
  'core.test.mjs',
  'entry.test.mjs',
  'filter.test.mjs',
  'governance.test.mjs',
  'inbox.test.mjs',
  'inbox-executor.test.mjs',
  'isolation.test.mjs',
  'lifecycle.test.mjs',
  'memory.test.mjs',
  'migrate.test.mjs',
  'reassign.test.mjs',
  'migration.test.mjs',
  'multi.test.mjs',
  'regressions2.test.mjs',
  'review.test.mjs',
  'router.test.mjs',
  'segment.test.mjs',
  'state-corrupt.test.mjs',
  'v23.test.mjs',
  'eval-synth.mjs',
  'ui-smoke.mjs',
  'load-check.mjs',
];

const picked = process.argv.slice(2);
const list = picked.length ? SUITES.filter(s => picked.some(p => s.includes(p))) : SUITES;
const failed = [];
for (const name of list) {
  const file = fileURLToPath(new URL('./' + name, import.meta.url));
  process.stdout.write('\n=== ' + name + ' ===\n');
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(name + ' (status ' + (r.status ?? 'signal ' + r.signal) + ')');
}
process.stdout.write('\n=== summary ===\n');
if (failed.length) {
  process.stdout.write('FAIL: ' + failed.join(', ') + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write('PASS: ' + list.length + ' suites\n');
}