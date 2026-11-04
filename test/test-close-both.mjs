// 关经验库要连台账一起关：否则身后那张卡片还在，看起来只关掉一个页面。
import { loadClient } from './lib/load-client.mjs';

const CLIENT = new URL('../client.js', import.meta.url).pathname;
const stubFetch = async (url) => {
  const u = String(url);
  const body = u.includes('/config')
    ? { ok: true, hasKey: false, shadow: true }
    : u.includes('/lessons')
      ? { ok: true, status: 'ready', memoryLimit: 50, lessons: [], proposals: [] }
      : { ok: true };
  return { ok: true, status: 200, json: async () => body };
};
const { mod, window, document, React, ReactDOM } = loadClient(CLIENT, { fetch: stubFetch });
const { EvolutionOverlay, publishOverlay } = mod.__internal;

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const outcome = {
  entries: [{ kind: 'memory', action: 'create', title: '一条经验', path: '/x/AGENTS.md' }],
  total: { memory: 1, skills: 0 },
  trigger: { reasons: ['steps'], steps: 15, distinctTools: 4, shellFailures: 0, toolFailures: 0 },
};
publishOverlay({
  signature: 'sig-close-test',
  view: 'settled',
  sessionId: 'session-close-test',
  sessionCount: 1,
  outcome,
  history: [],
  pendingTitle: '',
  pendingKind: '',
  live: true,
});

const container = document.createElement('div');
document.body.appendChild(container);
const root = ReactDOM.createRoot(container);
root.render(React.createElement(EvolutionOverlay));
await sleep(60);

const clickText = async (needle) => {
  const btn = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').includes(needle));
  if (btn === undefined) throw new Error(`no button containing ${needle}`);
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(50);
};
const clickEl = async (el) => {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(50);
};
const text = () => {
  const clone = container.cloneNode(true);
  clone.querySelectorAll('style').forEach((n) => n.remove());
  return clone.textContent;
};

// 点桌宠 → 展开台账
const pet = container.querySelector('.self-evolve-pet-wrap');
check('pet is on screen', pet !== null, true);
await clickEl(pet);
check('ledger card opened', text().includes('查看全部经验'), true);

// 查看全部经验 → 经验库
await clickText('查看全部经验');
check('library opened', text().includes('经验库'), true);

// 关经验库 → 两个都该没了
const closeBtn = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '✕')
  ?? [...container.querySelectorAll('button')].find((b) => (b.title || '').includes('关闭'));
check('close button found', closeBtn !== undefined, true);
await clickEl(closeBtn);
check('library is gone', text().includes('经验库'), false);
check('ledger card is gone too', text().includes('查看全部经验'), false);
check('back to the idle pet', container.querySelector('.self-evolve-pet-wrap') !== null, true);

root.unmount();
container.remove();
console.log(`close-both test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
