// 「本会话第 N 次进化」：计数从会话快照里数成功记录，气泡用它做标题。
import { loadClient } from './lib/load-client.mjs';

const CLIENT = new URL('../client.js', import.meta.url).pathname;
const { mod, document, React, ReactDOM } = loadClient(CLIENT);
const { selectSessionCount, EvolutionPet } = mod.__internal;

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 造快照：两成功（真写入）、一失败
const resultNode = (payload, isError = false) => ({
  kind: 'tool-call',
  data: {
    root: {
      kind: 'tool-result',
      name: 'self_evolve_record',
      isError,
      content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    },
  },
});
const real = { ok: true, written: [{ kind: 'memory', action: 'create', title: '真实' }] };
const dry = { ok: true, dryRun: true, written: [{ kind: 'skill', action: 'dry-run', title: '演练' }] };
const dup = { ok: true, written: [{ kind: 'memory', action: 'unchanged', title: '重复' }] };

const nodes = new Map([
  ['a', resultNode(real)],
  ['b', resultNode('boom', true)],
  ['c', resultNode(real)],
]);
const snapshot = { nodes, order: ['a', 'b', 'c'] };

check('counts only successful records', selectSessionCount(snapshot), 2);

// 演练与纯去重不算进化
const mixed = new Map([['r', resultNode(real)], ['d', resultNode(dry)], ['u', resultNode(dup)]]);
check('dry runs and duplicates do not count', selectSessionCount({ nodes: mixed, order: ['r', 'd', 'u'] }), 1);

check('empty snapshot counts 0', selectSessionCount({ nodes: new Map(), order: [] }), 0);
check('missing snapshot counts 0', selectSessionCount(undefined), 0);

// 气泡：第 3 次
const container = document.createElement('div');
document.body.appendChild(container);
const root = ReactDOM.createRoot(container);
root.render(React.createElement(EvolutionPet, {
  phase: 'flash',
  count: 3,
  idle: false,
  entries: [{ kind: 'memory', title: '用户偏好' }],
}));
await sleep(40);
const text = container.textContent;
check('bubble says which round this is', text.includes('本会话第 3 次'), true);
check('bubble still carries the entry summary', text.includes('用户偏好'), true);
root.unmount();
container.remove();

// 数不出来时不显示 0
const zero = document.createElement('div');
document.body.appendChild(zero);
const zroot = ReactDOM.createRoot(zero);
zroot.render(React.createElement(EvolutionPet, { phase: 'flash', count: 0, idle: false, entries: [] }));
await sleep(40);
check('zero count falls back to a plain 记住啦', zero.textContent.includes('记住啦') && !zero.textContent.includes('第 0 次'), true);
zroot.unmount();
zero.remove();

console.log(`session-count test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
