// 经验库面板：渲染、四个页面切换、设置页齿轮/返回。
import { loadClient } from './lib/load-client.mjs';

const CLIENT = new URL('../client.js', import.meta.url).pathname;
const stubFetch = async (url) => {
  const u = String(url);
  const body = u.includes('/config')
    ? { ok: true, hasKey: true, shadow: false, model: 'doubao-seed-2-1-lite-260915', keyMasked: 'ark-****9f2', last: { at: '10-23 16:10:18', verdict: 'worth', score: 0.97, ms: 910 } }
    : u.includes('/judgements')
      ? { ok: true, judgements: [] }
      : u.includes('/lessons')
        ? { ok: true, status: 'ready', scope: 'workspace', memoryLimit: 50,
            protocol: { used: 1200, limit: 2400 }, lessons: LEESSONS, proposals: PROPOSALS }
        : { ok: true };
  return { ok: true, status: 200, json: async () => body };
};
const { mod, window, document, React, ReactDOM } = loadClient(new URL('../client.js', import.meta.url).pathname, { fetch: stubFetch });
const { LessonLibrary } = mod.__internal;

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


const LEESSONS = [
  { id: 'memory:global:1', kind: 'memory', scope: 'global', title: '联网一律走豆包', body: 'b', path: '/x/AGENTS.md', original: '' },
  { id: 'memory:project:1', kind: 'memory', scope: 'project', title: 'Seedance 耗时单算 PE', body: 'b', path: '/x/AGENTS.md', original: '' },
  { id: 'skill:1', kind: 'skill', title: 'debug-cgt', path: '/x/SKILL.md', date: '2026-10-20', body: '第一条经验', original: '' },
  { id: 'skill:2', kind: 'skill', title: 'debug-cgt', path: '/x/SKILL.md', date: '2026-10-21', body: '第二条经验', original: '' },
];
const PROPOSALS = [{ id: 'p1', kind: 'skill', title: '微调协议措辞', add: 3, remove: 1 }];

const fixture = {
  status: 'ready',
  scope: 'workspace',
  memoryLimit: 50,
  protocol: { used: 1200, limit: 2400 },
  lessons: [
    { id: 'memory:global:1', kind: 'memory', scope: 'global', title: '联网一律走豆包', body: 'b', path: '/x/AGENTS.md', original: '' },
    { id: 'memory:project:1', kind: 'memory', scope: 'project', title: 'Seedance 耗时单算 PE', body: 'b', path: '/x/AGENTS.md', original: '' },
    { id: 'skill:1', kind: 'skill', scope: 'global', title: 'debug-cgt', skillName: 'debug-cgt', path: '/x/SKILL.md', original: '', date: '2026-10-20', body: '第一条经验' },
    { id: 'skill:2', kind: 'skill', scope: 'global', title: 'debug-cgt', skillName: 'debug-cgt', path: '/x/SKILL.md', original: '', date: '2026-10-21', body: '第二条经验' },
  ],
  proposals: [{ id: 'p1', kind: 'skill', title: '微调协议措辞', add: 3, remove: 1 }],
  judgements: [],
  lastRecord: undefined,
};

const SESSION = window.localStorage.getItem('self-evolve.session') || '';
const container = document.createElement('div');
document.body.appendChild(container);
const root = ReactDOM.createRoot(container);
root.render(React.createElement(LessonLibrary, { initialData: fixture, initialTab: 'home' }));
await sleep(40);

// 面板把 CSS 也塞在 DOM 里，直接把 <style> 剔掉再看文字。
const text = () => {
  const clone = container.cloneNode(true);
  clone.querySelectorAll('style').forEach((n) => n.remove());
  return clone.textContent;
};
const clickables = () => [...container.querySelectorAll('button')];
const pick = (label) => {
  const hit = clickables().find((b) => (b.textContent || '').trim() === label);
  if (hit === undefined) throw new Error(`no button labelled ${label}: ${clickables().map((b) => b.textContent.trim()).join(' | ')}`);
  return hit;
};
const click = async (label) => {
  pick(label).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
};
const clickContains = async (needle) => {
  const hit = clickables().find((b) => (b.textContent || '').trim().includes(needle));
  if (hit === undefined) throw new Error(`no button containing ${needle}`);
  hit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
};

check('home shows the title', text().includes('经验库'), true);
check('home shows the memory limit', text().includes('记忆上限 50 条'), true);
check('home splits global and project', text().includes('全局 1 · 项目 1'), true);
check('home lists the pending proposal', text().includes('待应用'), true);
check('no version chip in the header', /v\d+/.test(text()), false);

check('home tile counts skills not entries', text().includes('2 条经验 · 1 个技能'), true);
await clickContains('🧠记忆');
check('memory tab has its own title', text().includes('🧬 记忆'), true);
check('memory tab has a back button', text().includes('返回'), true);

await click('‹ 返回');
check('back returns home', text().includes('🧬 经验库'), true);

await clickContains('🛠技能');
check('skill tab lists the sunk skill', text().includes('debug-cgt'), true);
// 同一技能多条经验聚成一张卡（此刻在技能页）
check('same skill shows one grouped card', text().split('debug-cgt').length - 1, 1);
check('group shows entry count', text().includes('2 条'), true);
check('entries hidden until expanded', text().includes('第二条经验'), false);
await clickContains('展开');
check('expanding lists both entry rows', text().includes('10-21'), true);
// 点开第二条（行头是 div，不是 button），正文出现
const dateSpan = [...container.querySelectorAll('span')].find((e) => (e.textContent || '').trim() === '10-21');
check('second entry rendered', dateSpan !== undefined, true);
const rowHead = dateSpan.parentElement;
rowHead.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(40);
check('opening the second entry shows its body', text().includes('第二条经验'), true);
await click('‹ 返回');
check('back returns home from skills', text().includes('🧬 经验库'), true);

await click('⚙');
check('gear opens the settings page', text().includes('影子模式'), true);
check('settings page titles itself', text().includes('设置'), true);
check('settings page has save/cancel', text().includes('保存') && text().includes('取消'), true);

await click('取消');
check('cancel returns home', text().includes('🧬 经验库'), true);

await click('判断日志');
check('log page opens', text().includes('🧬 判断日志'), true);
await click('‹ 返回');
check('log page closes', text().includes('🧬 经验库'), true);

root.unmount();
container.remove();

console.log(`library test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
