'use strict';

/*
 * 碧蓝幻想缓存控制台 —— 浏览器侧的统一扩展（v2.0.0 合并版）
 *
 * 一份 Service Worker 干三件事：
 *   1) 侧边栏：点击工具栏图标打开控制台（控制台本体是 127.0.0.1:8799 的页面，
 *      侧栏只是一个壳；服务端只发一份 dashboard.html，数字与桌面端完全一致）
 *   2) 代理/PAC：先同步写入兜底规则，再升级为服务端 PAC；每分钟 alarm 跟随服务端
 *      变化；控制权被别的代理扩展压住时在图标上打红色 "!"（悬停看原因）
 *   3) 跟随浏览器：connectNative 让浏览器拉起本地程序，浏览器退出时程序跟着退
 *      （需 register-native-host.ps1 注册；未注册时静默跳过，不影响 1/2）
 *
 * 历史：V1.x 时代这是两个扩展 —— edge-extension（v2.2.1，管代理/PAC/跟随）与
 * console-extension（v1.1.1，只管侧栏）。2026-10-25 按用户要求合并为这一个，
 * 以侧栏扩展为主体；manifest 里的固定 key 沿用原 edge-extension 的，因此
 * 扩展 ID 不变（aflaenjbhecnfjclgbgplmpacjnealln），原生宿主注册无需重做。
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

/* ============================ 第 2 件：代理 / PAC ============================ */
/*
 * 把碧蓝幻想的「静态资源请求」交给本地 HTTPS 代理 —— v2.1 起跟随服务端 PAC。
 *
 * 历史（为什么要跟着服务端走）：
 *   v1/v2.0 时代本扩展自带一份写死的 PAC（资源走代理、其余一律 DIRECT）。
 *   v4 起程序改为「系统 PAC 分流 + 加速器串接」：资源走缓存、接口直连、
 *   其余流量交回加速器/VPN 的本地代理。但 Chromium 里**扩展的代理设置优先于系统 PAC**，
 *   旧规则里写死的 DIRECT 会把加速器串接整个旁路掉 —— 表现为默认浏览器
 *   「有缓存、没加速」（那种窗口没装本扩展，所以不受影响）。
 *
 *   v2.1 修复：不再自带规则，改为从服务端拉取 /proxy.pac 的**当前内容**再设置，
 *   与系统 PAC 完全同源 —— 与「默认浏览器」那条路行为一致。服务不在线时退回
 *   旧的兜底规则（至少保证游戏资源还能走缓存代理）。
 *
 *   v2.1.1 修复两个「装了也没效果」的静默失效（实测踩到）：
 *   1) 只挂了 alarms.onAlarm 监听、**从未 alarms.create()** —— SW 空闲 30 秒
 *      被杀后就没有任何唤醒源，写进浏览器的 PAC 从此是安装瞬间的快照：
 *      加速器开关、串接变化、服务重启统统不跟随，坏了也不自愈。
 *      现在真正创建周期 alarm（1 分钟），每次唤醒都重拉服务端 PAC 并重设。
 *   2) chrome.proxy 的控制权同时只能被一个扩展持有：Steamcommunity 302 之类的
 *      代理扩展先拿走控制权时，set() 会**静默失败**（错误只在回调
 *      lastError 里，界面毫无痕迹）。现在用 settings.get 的 levelOfControl 判定
 *      控制权归属，被别人压住时在扩展图标上打红色「!」并在控制台写明原因；
 *      对方让出（停用/卸载）后，下一轮 alarm 自动抢回并清除标记。
 *
 *   v2.2.1（合并前最后一版）修复：服务端 PAC 带中文注释时被 Chromium 整单拒绝
 *   （'pacScript.data' supports only ASCII）—— 拉取后整行剔除注释 + ASCII 保险丝。
 *
 * 两个不变的关键点：
 *   1) 用代理而不是重定向（重定向会被「跨源带凭据禁止换源」拒绝，InvalidAllowCredentials）。
 *   2) 接口（/rest/、/ob/、/od/ ...）绝不接管 —— 碰了会「新しいバージョンがあります」重载循环。
 *
 * 卸载/禁用本扩展时，浏览器自动清除这里设置的代理。
 */

const SERVER_PAC_URL = 'http://127.0.0.1:8799/proxy.pac';
const ALARM_NAME = 'gbfcache-follow';
const FOLLOW_MINUTES = 1;   // MV3 周期下限 1 分钟；每次唤醒只是拉一次本机 PAC，开销可忽略

// 服务不在线时的兜底规则（v2.0 的内容原样保留）
const FALLBACK_PAC = [
  'function FindProxyForURL(url, host) {',
  '  host = (host || "").toLowerCase();',
  '  if (isPlainHostName(host) || host === "localhost" || host === "127.0.0.1") return "DIRECT";',
  '  if (/granbluefantasy[.]akamaized[.]net$/.test(host)) return "PROXY 127.0.0.1:8899; DIRECT";',
  '  if (/granbluefantasy[.]jp$/.test(host) && url.indexOf("/assets/") !== -1) return "PROXY 127.0.0.1:8899; DIRECT";',
  '  return "DIRECT";',
  '}',
].join(String.fromCharCode(10));

let applying = false;

async function currentPac() {
  try {
    const r = await fetch(SERVER_PAC_URL, { cache: 'no-store' });
    if (r.ok) {
      let t = await r.text();
      if (t.indexOf('FindProxyForURL') !== -1) {
        // 【v2.2.1】Chromium 的 pacScript.data 只接受纯 ASCII（2026-10-25 实测：带中文
        // 注释的服务端 PAC 被整单拒绝，报 "'pacScript.data' supports only ASCII code"，
        // 浏览器里就只剩兜底 PAC）。V4.23.0 及之前的服务端发的 PAC 带中文注释行 ——
        // 这里整行剔除注释（生成器里的注释全部是整行 // 开头），再做一道 ASCII 保险丝。
        // 两道都过了才交给 set，新旧服务端通吃。
        const NL = String.fromCharCode(10);
        t = t.split(NL)
          .filter(function (ln) { return !/^\s*\/\//.test(ln); })
          .join(NL)
          .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
        if (t.indexOf('FindProxyForURL') !== -1) return t;
      }
    }
  } catch (e) { /* 服务不在线，用兜底 */ }
  return null;
}

// set 的回调里必须读 lastError（不读会报 Unchecked runtime.lastError），
// 并把错误交给调用方 —— 最常见的就是控制权被别的扩展持有。
function setProxy(pac, cb) {
  try {
    chrome.proxy.settings.set({
      value: {
        mode: 'pac_script',
        pacScript: { data: pac, mandatory: false },
      },
      scope: 'regular',
    }, function () {
      const err = chrome.runtime.lastError;
      if (cb) cb(err ? String(err.message || err) : '');
    });
  } catch (e) { if (cb) cb(String((e && e.message) || e)); }
}

// 控制权在谁手里。levelOfControl：
//   controlled_by_this_extension      —— 本扩展持有，设置有效
//   controllable_by_this_extension    —— 空着，本扩展可设
//   controlled_by_other_extensions    —— 被别的扩展压着，我们的设置会被静默拒绝
//   not_controllable                  —— 被企业策略/系统锁定
function controlState(cb) {
  try {
    chrome.proxy.settings.get({}, function (d) {
      const err = chrome.runtime.lastError;
      if (err) return cb('unknown');
      cb((d && d.levelOfControl) || 'unknown');
    });
  } catch (e) { cb('unknown'); }
}

const OK_TITLE = '碧蓝幻想本地缓存程序：正在跟随服务端 PAC（点击图标打开侧栏控制台）';

function markOk() {
  try {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: OK_TITLE });
  } catch (e) { /* 忽略 */ }
}

function markConflict(reason) {
  try {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#d1242f' });
    // 徽章只说明「有问题」，悬停提示说明「是什么问题」—— 用户不会去开扩展的
    // Service Worker 控制台，所以原因必须挂在图标本体上。
    chrome.action.setTitle({ title: '碧蓝幻想本地缓存程序未生效：' + reason + '（侧栏控制台不受影响）' });
    console.warn('[碧蓝幻想本地缓存] 代理设置未生效：' + reason
      + '。若原因是其他扩展占用控制权，到 edge://extensions 停用对方的代理设置后，1 分钟内本扩展会自动恢复。');
  } catch (e) { /* 忽略 */ }
}

function ensureAlarm() {
  try { chrome.alarms.create(ALARM_NAME, { periodInMinutes: FOLLOW_MINUTES }); }
  catch (e) { /* 极旧内核不支持时静默降级为仅事件驱动 */ }
}

async function apply() {
  if (applying) return;
  applying = true;
  ensureAlarm();
  try {
    // 关键：先【同步】写入兜底规则，再升级为服务端 PAC。
    // 历史教训：v1 早期版本曾写入过一份「整个游戏域名不分路径全部走代理」的持久化配置，
    // 它被 Chromium 持久保存（重启也在）。如果 SW 先去 await fetch 再 set，
    // 生命周期可能抢先挂起 SW，旧配置就永远留在那里 —— 表现为默认浏览器
    // 接口流量全被拖过本机代理（v3 同款问题）。先同步覆盖，竞态即消除。
    await new Promise(function (done) {
      setProxy(FALLBACK_PAC, function () { done(); });
    });
    const state = await new Promise(function (done) { controlState(done); });
    if (state !== 'controlled_by_this_extension' && state !== 'controllable_by_this_extension') {
      markConflict(state === 'controlled_by_other_extensions'
        ? '代理控制权被其他扩展持有，本扩展的规则被覆盖'
        : state === 'not_controllable'
          ? '代理设置被浏览器策略锁定'
          : '代理设置状态异常（' + state + '）');
      applying = false;
      return;
    }
    const pac = await currentPac();
    if (pac) {
      await new Promise(function (done) {
        setProxy(pac, function (err) {
          if (err) markConflict('写入服务端 PAC 失败：' + err);
          else markOk();
          done();
        });
      });
    } else {
      markOk();   // 服务离线：兜底规则已生效，至少缓存还能用
    }
  } catch (e) {
    markConflict('apply 异常：' + ((e && e.message) || e));
  }
  applying = false;
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
