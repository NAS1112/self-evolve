// 在 jsdom 里装配 Client 半：只取 factory 的返回值，不跑 Cordis apply。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(new URL('../package.json', import.meta.url));
const React = require('react');
const ReactDOM = require('react-dom/client');

export function loadClient(clientPath, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:62771/',
    pretendToBeVisual: true,
  });

  const { window } = dom;
  window.__DSH_BOOT__ = {};
  // 必须在客户端脚本求值之前装好：它会在模块初始化时抓一次 fetch。
  // 客户端脚本是在 Node 全局作用域里求值的：裸 `fetch` 取的是 global.fetch，
  // 只打 window.fetch 会漏掉一半调用（表现为「配置一直读取中」）。
  if (typeof options.fetch === 'function') {
    window.fetch = options.fetch;
    global.fetch = options.fetch;
  }
  global.window = window;
  global.document = window.document;
  try { Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true }); } catch { /* 有的 Node 版本 navigator 只读，跳过 */ }
  global.HTMLElement = window.HTMLElement;
  global.Element = window.Element;
  global.Node = window.Node;
  global.Event = window.Event;
  global.MouseEvent = window.MouseEvent;
  global.CustomEvent = window.CustomEvent;
  global.getComputedStyle = window.getComputedStyle.bind(window);
  global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  global.matchMedia = window.matchMedia ? window.matchMedia.bind(window) : () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

  let mod;
  window.__ModuleLoader__ = {
    load({ factory }) {
      mod = factory((name) => {
        if (name === 'react') return React;
        if (name === 'react-dom/client') return ReactDOM;
        if (name === 'react-dom') return require('react-dom');
        return require(name);
      });
    },
  };

  // client.js 是给浏览器直接跑的脚本，用 Function 包一层即可（它只依赖 window/require）。
  // eslint-disable-next-line no-new-func
  new Function(readFileSync(clientPath, 'utf8'))();

  if (mod === undefined) throw new Error('client module did not register');
  return { mod, window, document: window.document, React, ReactDOM };
}

/** 把组件挂到 jsdom 里，返回 { root, container, rerender, unmount }。 */
export function mount(ReactDOM, container, element) {
  const root = ReactDOM.createRoot(container);
  root.render(element);
  return root;
}
