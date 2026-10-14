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
 *   1) v2.1 只挂了 alarms.onAlarm 监听、**从未 alarms.create()** —— SW 空闲 30 秒
 *      被杀后就没有任何唤醒源，写进浏览器的 PAC 从此是安装瞬间的快照：
 *      加速器开关、串接变化、服务重启统统不跟随，坏了也不自愈。
 *      现在真正创建周期 alarm（1 分钟），每次唤醒都重拉服务端 PAC 并重设。
 *   2) chrome.proxy 的控制权同时只能被一个扩展持有：Steamcommunity 302 之类的
 *      代理扩展先拿走控制权时，本扩展的 set() 会**静默失败**（错误只在回调
 *      lastError 里，界面毫无痕迹）。现在用 settings.get 的 levelOfControl 判定
 *      控制权归属，被别人压住时在扩展图标上打红色「!」并在控制台写明原因；
 *      对方让出（停用/卸载）后，下一轮 alarm 自动抢回并清除标记。
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
      const t = await r.text();
      if (t.indexOf('FindProxyForURL') !== -1) return t;
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

const OK_TITLE = '碧蓝幻想本地缓存程序：正在跟随服务端 PAC';

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
    chrome.action.setTitle({ title: '碧蓝幻想本地缓存程序未生效：' + reason });
  } catch (e) { /* 忽略 */ }
  console.warn('[碧蓝幻想本地缓存] 代理设置未生效：' + reason
    + '。若原因是其他扩展占用控制权，到 edge://extensions 停用对方的代理设置后，1 分钟内本扩展会自动恢复。');
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

chrome.runtime.onInstalled.addListener(apply);
chrome.runtime.onStartup.addListener(apply);
chrome.alarms.onAlarm.addListener(function (a) {
  if (a && a.name === ALARM_NAME) apply();
});
apply();
