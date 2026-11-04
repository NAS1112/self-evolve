// 桌宠形象：状态 → GIF 的映射、兜底、拖拽/睡眠/醒来。
import { loadClient } from './lib/load-client.mjs';

const CLIENT = new URL('../client.js', import.meta.url).pathname;
const { mod, document, React, ReactDOM } = loadClient(new URL('../client.js', import.meta.url).pathname);
const { EvolutionPet } = mod.__internal;

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const make = async (props) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  root.render(React.createElement(EvolutionPet, props));
  await sleep(30);
  return { root, container };
};
const imgSrc = (container) => {
  const img = container.querySelector('img');
  if (img === null) return undefined;
  // 素材 URL 带 ?v=<版本> 做缓存击穿，这里只比路径
  return String(img.getAttribute('src')).split('?')[0];
};

// 1. 待机
let { root, container } = await make({ phase: 'settled', idle: true, count: 0 });
check('idle renders the character gif', imgSrc(container), '/api/self-evolve/pet/idle.webp');
check('idle has no bubble', container.textContent.includes('记住啦'), false);
root.unmount();
container.remove();

// 2. 思考 / 忘掉 / 成功
for (const [props, slug] of [
  [{ phase: 'settled', mood: 'think', count: 1 }, 'think'],
  [{ phase: 'settled', mood: 'forget', count: 2 }, 'forget'],
  [{ phase: 'flash', count: 3, idle: false, entries: [{ kind: 'memory', title: 'x' }] }, 'happy'],
]) {
  ({ root, container } = await make(props));
  check(`${slug} state uses ${slug}.webp`, imgSrc(container), `/api/self-evolve/pet/${slug}.webp`);
  root.unmount();
  container.remove();
}

// 3. 静置后睡着，碰一下就醒
({ root, container } = await make({ phase: 'settled', idle: true, count: 0, sleepAfterMs: 900, wakeMs: 200 }));
check('starts awake', imgSrc(container), '/api/self-evolve/pet/idle.webp');
await sleep(1000);
check('sleeps after the idle timeout', imgSrc(container), '/api/self-evolve/pet/sleep.webp');
const img = container.querySelector('img');
img.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
await sleep(40);
check('pointer wakes it up with the wake frame', imgSrc(container), '/api/self-evolve/pet/wake.webp');
window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
await sleep(260);
check('back to idle after waking', imgSrc(container), '/api/self-evolve/pet/idle.webp');
root.unmount();
container.remove();

// 3.5 沉淀中：记忆碎片 + 进度弧
({ root, container } = await make({ phase: 'burst', count: 1, idle: false, pendingTitle: '正在写进记忆' }));
check('burst renders memory motes', container.querySelectorAll('.self-evolve-pet-mote').length, 6);
check('burst shows the writing bubble', container.textContent.includes('记一下'), true);
check('burst keeps the character', imgSrc(container), '/api/self-evolve/pet/idle.webp');
root.unmount();
container.remove();

({ root, container } = await make({ phase: 'settled', idle: true, count: 0 }));
check('settled has no motes', container.querySelectorAll('.self-evolve-pet-mote').length, 0);
root.unmount();
container.remove();

// 4. 右键菜单：手动钉住动作、可回到跟随状态
({ root, container } = await make({ phase: 'settled', idle: true, count: 0 }));
check('no menu before right click', container.querySelector('.self-evolve-pet-menu'), null);
const wrap = container.querySelector('.self-evolve-pet-wrap');
wrap.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
await sleep(40);
const menu = container.querySelector('.self-evolve-pet-menu');
check('right click opens the action menu', menu !== null, true);
check('menu lists every action', menu.textContent.includes('待机') && menu.textContent.includes('睡觉')
  && menu.textContent.includes('醒来') && menu.textContent.includes('跟随状态'), true);
const sleepItem = [...menu.querySelectorAll('button')].find((b) => b.textContent.includes('睡觉'));
// 真实浏览器里先 pointerdown 再 click：菜单不能在 pointerdown 阶段就把自己关掉。
sleepItem.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
await sleep(20);
check('menu survives a pointerdown on itself', container.querySelector('.self-evolve-pet-menu') !== null, true);
sleepItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(40);
check('picking an action pins it', imgSrc(container), '/api/self-evolve/pet/sleep.webp');
check('menu closes after picking', container.querySelector('.self-evolve-pet-menu'), null);

wrap.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
await sleep(40);
const autoItem = [...container.querySelectorAll('.self-evolve-pet-menu button')].find((b) => b.textContent.includes('跟随状态'));
autoItem.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
autoItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(40);
check('follow-state restores the automatic one', imgSrc(container), '/api/self-evolve/pet/idle.webp');

// 点菜单外面应该关掉
wrap.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
await sleep(30);
document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
await sleep(30);
check('clicking outside closes the menu', container.querySelector('.self-evolve-pet-menu'), null);
root.unmount();
container.remove();

// 5. 图片加载失败退回 SVG
({ root, container } = await make({ phase: 'settled', idle: true, count: 0 }));
const broken = container.querySelector('img');
broken.dispatchEvent(new window.Event('error', { bubbles: true }));
await sleep(40);
check('image failure falls back to the svg pet', container.querySelector('img'), null);
check('fallback draws an svg', container.querySelector('svg') !== null, true);
root.unmount();
container.remove();

console.log(`pet test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
