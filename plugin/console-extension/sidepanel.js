'use strict';

/* 侧栏壳：先确认本地服务活着，再把控制台装进 iframe。
 *
 * 为什么是 iframe 而不是把 dashboard.html 搬进扩展：
 *   1) 控制台里全是相对路径（/api/...、/events、/test），搬到 chrome-extension://
 *      下会全部打到扩展自己的源；
 *   2) 服务端 isLocalApiRequest 只认 127.0.0.1/localhost 的 Origin，扩展页直接
 *      fetch 管理接口会被 403；iframe 的文档源就是服务本身，天然通过；
 *   3) 控制台只有一份，侧栏 / 独立窗口 / 普通标签页不会出现三份需要同步的副本。
 */

const CONSOLE_URL = 'http://127.0.0.1:8799/#side';
const HEALTH_URL = 'http://127.0.0.1:8799/health';
const RETRY_MS = 2500;
const PROBE_TIMEOUT_MS = 1500;

const frame = document.getElementById('console');
const loading = document.getElementById('loading');
const offline = document.getElementById('offline');
const retry = document.getElementById('retry');

let retryTimer = 0;
let connecting = false;
let loadedOnce = false;

function showOffline() {
  loading.hidden = true;
  frame.hidden = true;
  offline.hidden = false;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, RETRY_MS);
}

function showConsole() {
  offline.hidden = true;
  if (loadedOnce) {
    // 服务重启后控制台自己的 EventSource 会自动重连，不必重新加载整个页面
    loading.hidden = true;
    return;
  }
  // 控制台自己会显示“正在连接服务…”，壳的提示到此为止；不要让它继续盖在
  // iframe 上（跨源 iframe 的 load 事件偶尔比内容到达晚，留着会挡住读屏与点击测试）。
  loading.hidden = true;
  frame.hidden = false;
  loadedOnce = true;
  frame.src = CONSOLE_URL;
}

async function probe() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(HEALTH_URL, { cache: 'no-store', signal: ctl.signal });
    return res.ok;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function connect() {
  if (connecting) return;
  connecting = true;
  clearTimeout(retryTimer);
  const ok = await probe();
  connecting = false;
  if (ok) showConsole();
  else showOffline();
}

frame.addEventListener('load', function () {
  loading.hidden = true;
});

retry.addEventListener('click', function () {
  connect();
});

// 侧栏重新获得焦点时（例如用户刚去启动了程序），立刻再探一次
window.addEventListener('focus', function () {
  if (!offline.hidden) connect();
});

connect();
