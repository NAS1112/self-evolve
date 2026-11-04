// 桌宠形象路由：白名单、大小、防穿越。打的是本地真服务。
// 端口每次启动都可能变：优先读环境变量，其次读 DSH 的运行时地址，最后才用默认值。
const BASE = process.env.SELF_EVOLVE_BASE
  || process.env.DSH_WEB_URL
  || 'http://127.0.0.1:62100';

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
};

const FRAMES = ['idle', 'think', 'happy', 'drag', 'forget', 'sleep', 'wake'];
for (const name of FRAMES) {
  const res = await fetch(`${BASE}/api/self-evolve/pet/${name}.webp`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // RIFF....WEBP
  const isWebp = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF'
    && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP';
  check(`${name}.webp serves webp`, [res.status, res.headers.get('content-type'), isWebp, bytes.length > 100000],
    [200, 'image/webp', true, true]);
}

for (const bad of ['../index.js', '../../package.json', 'evil', 'idle.js']) {
  const res = await fetch(`${BASE}/api/self-evolve/pet/${bad}`);
  // 穿越会被服务本身拦（401/403）或落在白名单外（404）；只要不是 200 就算挡住了。
  check(`rejects ${bad}`, res.status !== 200, true);
}

const noHeader = await fetch(`${BASE}/api/self-evolve/lessons`);
check('lessons still requires the header', noHeader.status, 403);

console.log(`route test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
