// 「记完了有没有反馈」：庆祝触发的判定必须是纯比较，且只有一处领记录。
import { loadClient } from './lib/load-client.mjs';

const CLIENT = new URL('../client.js', import.meta.url).pathname;
const { mod } = loadClient(CLIENT);
const { shouldFlash } = mod.__internal;

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
};

const boot = 1_700_000_000_000;
const now = boot + 5000;

check('a fresh record should celebrate', shouldFlash({ atMs: now }, 0, boot), true);
check('the same record must not replay', shouldFlash({ atMs: now }, now, boot), false);
check('an older record should not celebrate', shouldFlash({ atMs: now - 1000 }, now, boot), false);
check('a record from before boot is ignored', shouldFlash({ atMs: boot - 120000 }, 0, boot), false);
check('but one within the 60s grace still counts', shouldFlash({ atMs: boot - 30000 }, 0, boot), true);
check('missing record', shouldFlash(undefined, 0, boot), false);
check('record without atMs', shouldFlash({}, 0, boot), false);

console.log(`feedback test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
