'use strict';

/*
 * 碧蓝幻想缓存控制台 —— 浏览器侧的统一扩展（v2.1.0）
 *
 * 一份 Service Worker 干两件事：
 *   1) 侧边栏：点击工具栏图标打开控制台（控制台本体是 127.0.0.1:8799 的页面，
 *      侧栏只是一个壳；服务端只发一份 dashboard.html，数字与桌面端完全一致）
 *   2) 跟随浏览器：connectNative 让浏览器拉起本地程序，浏览器退出时程序跟着退
 *      （需 register-native-host.ps1 注册；未注册时静默跳过，不影响侧栏）
 *
 * 历史：V1.x 时代这是两个扩展 —— edge-extension（v2.2.1，管代理/PAC/跟随）与
 * console-extension（v1.1.1，只管侧栏）。2026-10-25 按用户要求合并为这一个，
 * 以侧栏扩展为主体；manifest 里的固定 key 沿用原 edge-extension 的，因此
 * 扩展 ID 不变（aflaenjbhecnfjclgbgplmpacjnealln），原生宿主注册无需重做。
 * V2.1.0 起扩展不再设置代理，只清理旧版自己留下的扩展级代理项。
 */

/* ============================== 第 1 件：侧边栏 ============================== */

const OPEN_ON_ACTION_CLICK = { openPanelOnActionClick: true };

function enableActionClick() {
  // sidePanel 是 Chromium 114+ 的 API；旧内核没有就静默跳过，
  // 这样同一份代码在更老的浏览器里也不会因为缺 API 而报错。
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) return;
  try {
    const p = chrome.sidePanel.setPanelBehavior(OPEN_ON_ACTION_CLICK);
    if (p && p.catch) p.catch(() => { /* 企业策略等场景下可能被拒，不影响控制台页面本身 */ });
  } catch (e) { /* 忽略 */ }
}

// 兜底：极少数企业策略会让 setPanelBehavior 被拒；这时至少保证点击图标还能开侧栏。
// 若 setPanelBehavior 已生效，Chrome 通常不会再触发 onClicked；即便触发，
// sidePanel.open 对已打开的面板也只是聚焦，不会开出第二份。
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(function (tab) {
    if (!chrome.sidePanel || !chrome.sidePanel.open) return;
    try {
      const p = chrome.sidePanel.open({ windowId: tab.windowId });
      if (p && p.catch) p.catch(function () { /* 忽略 */ });
    } catch (e) { /* 忽略 */ }
  });
}

/* ============================ 第 2 件：代理边界 ============================ */
/*
 * v2.1.0 起，本扩展只负责侧边栏控制台与原生宿主连接，不再设置浏览器代理。
 * 全局模式由 GBF-Cache 接管系统 PAC；
 * 主动模式由 GBF-Cache 在启动指定 GBF 浏览器时注入 --proxy-pac-url；
 * 被动模式完全由用户手动设置浏览器代理。
 *
 * 旧版扩展可能留下过 chrome.proxy 设置，因此启动时只清除本扩展自己的代理项。
 */

const ALARM_NAME = 'gbfcache-follow';
const FOLLOW_MINUTES = 1;   // MV3 周期下限 1 分钟；用于保持原生宿主连接
const OK_TITLE = '碧蓝幻想本地缓存程序：代理不由此扩展接管（点击图标打开侧栏控制台）';

function markOk() {
  try {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: OK_TITLE });
  } catch (e) { /* 忽略 */ }
}

function ensureAlarm() {
  try { chrome.alarms.create(ALARM_NAME, { periodInMinutes: FOLLOW_MINUTES }); }
  catch (e) { /* 极旧内核不支持时静默降级为仅事件驱动 */ }
}

async function apply() {
  ensureAlarm();
  try {
    // V2.1.0：扩展不再设置 chrome.proxy。旧版本可能留下扩展级 PAC，
    // 这里只清除本扩展自己的代理项，不修改系统代理或用户手动配置。
    await new Promise(function (done) {
      try {
        chrome.proxy.settings.clear({ scope: 'regular' }, function () {
          void chrome.runtime.lastError;
          done();
        });
      } catch (e) { done(); }
    });
    markOk();
  } catch (e) { /* 侧栏和原生宿主仍可正常工作 */ }
}

/* ========================= 第 3 件：跟随浏览器启动/退出 ========================= */
//
// 机制：Chromium 的「原生消息宿主」。register-native-host.ps1 在注册表里登记
// com.dasingduck.gbfcache 指向 GBFCache.exe 后，这里的 connectNative 一调用，
// 浏览器就替我们把程序拉起来（stdin/stdout 接管道）；浏览器退出时会终止宿主进程，
// 程序跟着退 —— 这就是「跟随浏览器开启/关闭」的全部实现。
//
// 扩展端只做三件事，刻意的极简：
//   1) SW 每次醒来（浏览器启动 / 每分钟 alarm）都确保原生端口连着；
//   2) 端口断开时分两种情况：宿主没注册（等下一轮 alarm 再试，不刷错误）/
//      宿主进程退了（先探活 —— 服务若被手动启动的实例接管就不抢，真没了才重连）；
//   3) 端口上不发送任何消息 —— 端口的存在本身就是「浏览器还活着，服务别退」的信号，
//      服务端（launcher 的原生宿主模式）也只认这个信号。
// 端口保持连接同时能让 SW 不被 30 秒空闲规则杀掉（Chrome 105+ 的官方行为，
// minimum_chrome_version 已提到 114），每分钟的 alarm 是兜底唤醒源。
const NATIVE_HOST = 'com.dasingduck.gbfcache';
const HEALTH_URL = 'http://127.0.0.1:8799/health';
let nativePort = null;

function ensureNative() {
  if (nativePort) return;
  if (!chrome.runtime || !chrome.runtime.connectNative) return;   // 极旧内核：静默降级
  try {
    const p = chrome.runtime.connectNative(NATIVE_HOST);
    p.onDisconnect.addListener(function () {
      nativePort = null;
      // lastError 必须读取（不读会报 Unchecked runtime.lastError）；它同时是
      // 「宿主没注册」与「宿主进程退出」的判别依据。
      const err = chrome.runtime.lastError;
      const msg = String((err && err.message) || '');
      console.info('[碧蓝幻想本地缓存] 原生宿主断开：' + (msg || '宿主进程退出/浏览器关闭'));
      if (msg.indexOf('not found') !== -1) {
        // 宿主没注册（register-native-host.ps1 没跑过/已注销）：不进入重试环，
        // 每分钟的 alarm 会再调 ensureNative，注册后自然接上。
        return;
      }
      // 宿主进程退了：4 秒后探活再决定。服务若已被手动启动的实例接管（双击 exe 的
      // 那份在跑），就不重连 —— 否则用户手动关掉服务，浏览器会立刻把它拉回来。
      setTimeout(function () {
        fetch(HEALTH_URL, { cache: 'no-store' })
          .then(function () { /* 服务活着：交给现有实例 */ })
          .catch(function () { ensureNative(); });
      }, 4000);
    });
    nativePort = p;
    console.info('[碧蓝幻想本地缓存] 原生宿主已连接：' + NATIVE_HOST);
  } catch (e) { /* 静默 */ }
}

/* ================================ 统一入口 ================================= */

chrome.runtime.onInstalled.addListener(function () { enableActionClick(); apply(); ensureNative(); });
chrome.runtime.onStartup.addListener(function () { enableActionClick(); apply(); ensureNative(); });
chrome.alarms.onAlarm.addListener(function (a) {
  if (a && a.name === ALARM_NAME) { apply(); ensureNative(); }
});
enableActionClick();
apply();
ensureNative();
