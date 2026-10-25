#!/usr/bin/env node
/*
 * 碧蓝幻想本地缓存程序（独立版）
 *
 * 作用：把本机已有的游戏资源缓存目录当作 CDN 用。
 *   - 命中缓存 -> 直接读盘返回，完全不联网
 *   - 未命中   -> 回源站拉取，按既有缓存的原格式写回，然后返回
 *
 * 请求格式（由 Edge 扩展重定向产生）：
 *   GET http://127.0.0.1:8799/f/<原始主机>/<原始路径>?<原始查询>
 * 例：
 *   https://game.granbluefantasy.jp/assets/img/a.png
 *     -> http://127.0.0.1:8799/f/game.granbluefantasy.jp/assets/img/a.png
 *
 * 缓存键 = URL 路径（与既有缓存的磁盘布局一致，仅替换路径分隔符）。
 * 查询串**不进缓存键**，但会当作"资源版本"记进同目录的 .ext 元数据：请求带查询串时
 * 只有版本一致才命中，否则回源重取并覆盖 —— 既不会拿旧版本文件顶（游戏会判定
 * 「有新版本」而反复重载），也不会像 V4.6.0 那样把这类资源整个跳过、永远不落盘。
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');
const fsp = fs.promises;

// ---------------------------------------------------------------- 配置

const PORT = parseInt(process.env.GBFCACHE_PORT || process.env.ACGP_PORT || '8799', 10);
const HOST = '127.0.0.1';

// 程序版本号（唯一来源）。格式 Vx.x.x：主版本.功能版本.修订号。
// 规矩：**每次功能性改动都要同步递增**——新功能 +1 中间位，修 bug/小调整 +1 末位，
// 架构级重构 +1 首位。改这里之后，控制台头部、/api/stats、启动日志、托盘悬停提示全部自动跟随。
const VERSION = 'V4.24.0';

// ---------------------------------------------------------------- 缓存目录配置
//
// 优先级：环境变量 > config.json > 内置的默认目录。
// 目录可以在控制台界面里随时改，改动会写进 config.json 持久保存。
//
// ⚠️ 下面三条规矩都是被真实故障逼出来的（V4.5.4 修）：
//
//   1) 默认目录必须在**程序目录内**。旧规则是「程序目录的上一级\cache\gbf」，
//      于是程序只要被放进一级子目录（开发机上就是 H:\GBF Cache\exe-dist\），
//      默认值就落到宿主目录旁边 —— 表现为"缓存跑进开发者目录去了"。
//      更普遍的问题是：程序解压到 C:\Program Files\GBFCache\ 时默认目录会变成
//      C:\Program Files\cache\gbf，普通权限根本写不进去。
//
//   2) config.json 里的 cacheRoot 只代表**用户显式选过的目录**：环境变量与内置
//      默认值都不写回文件。旧版本的 saveConfig 无条件把当前生效值写回去，于是
//      "回落到的默认路径"被固化成这台机器上的绝对路径 —— 用户看到的就是
//      "我设过缓存目录，重启后程序自己又改回默认了"，换机器后更说不清。
//
//   3) cacheRoot 为空只表示"没选过"，不等于"这份配置无效"。旧版本据此把整份配置
//      丢掉，随包发出的 pacMode / autoLaunchGame / autoLaunchAccel /
//      acceleratorPath / gameLaunchPath 在首次运行（第一次 saveConfig）后一起消失
//      —— exe-dist\config.json 实测被刷成只剩 pacPrev + cacheRoot。

const CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_CACHE_ROOT = path.join(__dirname, 'cache', 'gbf');
// 旧规则（≤V4.5.3）的默认值。用来识别"被旧版本固化下来的默认路径"，见 loadConfig
const LEGACY_DEFAULT_CACHE_ROOT = path.join(__dirname, '..', 'cache', 'gbf');

let legacyFrozenRoot = '';   // 非空 = 启动时忽略掉了这个被固化的旧默认值（用于启动日志）

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    const c = JSON.parse(raw);
    if (!c || typeof c !== 'object') return {};
    // 一次性迁移：值正好等于旧规则的默认目录 —— 那多半不是用户选的，而是旧版本
    // 固化进来的。误判也不会丢东西：改用新默认目录后，在控制台里再选一次即可。
    if (typeof c.cacheRoot === 'string' && c.cacheRoot.trim()
        && samePath(c.cacheRoot, LEGACY_DEFAULT_CACHE_ROOT)) {
      legacyFrozenRoot = c.cacheRoot.trim();
      delete c.cacheRoot;
    }
    return c;
  } catch { /* 没有配置文件或格式不对，用默认值 */ }
  return {};
}

const config = loadConfig();

// 用户显式选过的目录（空 = 没选过）。**只有这个值允许写回 config.json**。
let chosenCacheRoot = String(config.cacheRoot || '').trim();

let CACHE_ROOT = process.env.GBFCACHE_CACHE_ROOT || process.env.ACGP_CACHE_ROOT
  || chosenCacheRoot || DEFAULT_CACHE_ROOT;

// patch 里的字段会合并进现有配置（例如 pacPrev 记录了系统代理的原值）。
// 之所以要合并而不是整份重写：改成缓存目录时不能顺手把别的记录冲掉。
function saveConfig(patch) {
  try {
    const next = Object.assign({}, config, patch || {});
    // 没选过就不写这个键：写进去等于把一个"默认值"固化成本机绝对路径（见上面 2)）
    if (chosenCacheRoot) next.cacheRoot = chosenCacheRoot;
    else delete next.cacheRoot;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
    Object.assign(config, next);
    // V4.18.2：配置一变就广播一次 stats —— 控制台"更新日"卡片的档位/开关依赖 SSE 推送
    // 才会即时刷新（此前切档位后卡片要等下一次请求或 5 秒轮询，观感像"没生效"）。
    scheduleStatsBroadcast();
    return true;
  } catch (e) {
    log(`保存配置失败: ${e.message}`);
    return false;
  }
}

// ------------------------------------------------------- 系统代理（自动配置脚本）
//
// Windows 的「自动配置脚本」(AutoConfigURL) 只有一个槽位，而加速器的网页加速
// 用的就是它：实测雷神加速器目录下有
//   C:\ProgramData\leigod_person_7002\sslproxy\cert\ca.cer      （根证书 → 做 HTTPS 中间人）
//   C:\ProgramData\leigod_person_7002\sslproxy\proxy\           （nginx + networktunnel_proxy.exe + 图片缓存）
// 与我们是同一原理、同一层面，所以两边一定会抢这个槽位。
//
// 若我们的 PAC 对非 GBF 流量一律返回 DIRECT，就等于把加速器的加速整个旁路掉 ——
// 表现就是「用了这个程序，加速器就失效了」。因此这里做 **PAC 串接**：
//
//   GBF 的 /assets/  -> 本地缓存代理（本程序）
//   其余流量        -> 加速器当前的代理（每次取 PAC 时从注册表现读，随它开关自动变化）
//
// 探测不准时可以在 config.json 里手填 upstreamProxy（如 "127.0.0.1:12345"）。
const INET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const PAC_PATH = '/proxy.pac';

function ourPacUrl() {
  return `http://${HOST}:${PORT}${PAC_PATH}`;
}

// 判断某个 AutoConfigURL 是不是本程序自己的
function isOurPacUrl(u) {
  return !!u && u.indexOf('proxy.pac') !== -1 && u.indexOf(String(HOST)) !== -1;
}

// 从「别的程序」（典型：雷神网页加速）写入槽位的 PAC 里提取它使用的本地代理地址。
// 只接受本机 PAC（file:// 或 127.0.0.1/localhost 的 http 地址），远程 PAC 一律不碰。
//
// 返回值：{ proxy: 'host:port' | null, reason: '没提取到的原因（中文，可直接显示给用户）' }
// 为什么要带 reason：见下面调用处与 foreignPac 的注释 —— 这个失败以前是静默的，
// 而"为什么不让位"决定了用户接下来该做什么，必须写清楚。
function extractProxyFromPac(pacUrl) {
  const u = String(pacUrl || '');
  let text = '';
  if (/^file:\/\//i.test(u)) {
    try {
      text = require('fs').readFileSync(require('url').fileURLToPath(u), 'utf8');
    } catch (e) {
      return { proxy: null, reason: '它是本机 PAC 文件，但读不到（' + e.message + '）' };
    }
  } else if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(u)) {
    try {
      const { execSync } = require('child_process');
      // reg.exe 的教训同样适用于这里：整条命令交给 cmd，避免转义问题
      text = execSync(`curl -s --max-time 3 "${u}"`, { encoding: 'utf8', timeout: 5000 });
    } catch (e) {
      return { proxy: null, reason: '它是本机 PAC 服务，但取不到内容（curl 失败或超时）' };
    }
    if (!String(text || '').trim()) {
      return { proxy: null, reason: '它是本机 PAC 服务，但返回了空内容' };
    }
  } else {
    return { proxy: null, reason: '它是远程 PAC（不是本机地址），本程序不解析远程 PAC' };
  }
  // 支持 PROXY / HTTPS / SOCKS5 / SOCKS 这些写法，host:port 一并抓出来 ——
  // 这样报错时能点名"它用的是 HTTPS 代理 127.0.0.1:7890"，而不是含糊地说"没找到 PROXY 写法"。
  // 先找可串接的那类（PROXY/HTTP），找不到再看 HTTPS/SOCKS —— 一个 PAC 里两种都写着时，
  // 优先挑我们真能走的那种，别因为顺序不同就从"能接"退化成"不能接"。
  let m = /\b(PROXY|HTTP)\s+([A-Za-z0-9.\-]+:\d+)/i.exec(text);
  let kind = 'PROXY';
  if (!m) {
    m = /\b(HTTPS|SOCKS5|SOCKS)\s+([A-Za-z0-9.\-]+:\d+)/i.exec(text);
    if (m) kind = m[1].toUpperCase();
  }
  if (!m) {
    // 连 host:port 都抓不到：把"它用了什么"一并报出来，供远程支持判断。
    const kinds = ['HTTPS', 'SOCKS5', 'SOCKS', 'HTTP', 'DIRECT'].filter(function (k) {
      return new RegExp('\\b' + k + '\\b', 'i').test(text);
    });
    return {
      proxy: null, kind: '',
      reason: 'PAC 里没有 "PROXY 本机地址:端口" 这种写法'
        + (kinds.length ? '（它用到的是 ' + kinds.join(' / ') + '）' : '（也没有 HTTPS/SOCKS 之类的语句）'),
    };
  }
  const addr = m[2];
  const h = addr.split(':')[0].toLowerCase();
  if (h !== '127.0.0.1' && h !== 'localhost') {
    return { proxy: null, kind, reason: 'PAC 里的代理不在本机（' + addr + '），无法串接' };
  }
  if (kind !== 'PROXY' && kind !== 'HTTP') {
    // 如实说清楚"识别到了但接不上"，别让人以为已经接上了。
    // Node 的 http/https agent 不能直接走 HTTPS 或 SOCKS 代理（需要自己实现 CONNECT 隧道或
    // SOCKS5 握手），所以这两种只能让位 —— 给出可操作的替代做法。
    return {
      proxy: null, kind,
      reason: 'PAC 用的是 ' + kind + ' 代理（' + addr + '），本程序只能串接 HTTP 代理（PROXY 写法）——'
        + ' ' + kind + ' 需要额外的隧道实现。可改用「系统代理」方式配置加速器，'
        + '或在 config.json 里显式填 upstreamProxy（形如 127.0.0.1:7890）',
    };
  }
  return { proxy: addr, kind, reason: '' };
}

// 从 reg query 输出里取一个值的字符串内容
function pickRegValue(text, name) {
  const m = new RegExp('^\\s*' + name + '\\s+REG_\\w+\\s+(.*)$', 'mi').exec(text);
  return m ? m[1].trim() : '';
}

// ProxyServer 允许写成 host:port，也允许按协议分别写：http=..;https=..;ftp=..;socks=..
function normalizeProxyServer(v) {
  const raw = String(v || '').trim();
  if (!raw) return null;
  if (raw.indexOf('=') === -1) return /^[\w.\-]+:\d+$/.test(raw) ? raw : null;
  const map = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) map[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  for (const k of ['https', 'http']) {
    if (map[k] && /^[\w.\-]+:\d+$/.test(map[k])) return map[k];
  }
  return null;
}

let systemProxyCache = { at: 0, value: null };
const SYS_PROXY_TTL_MS = 10000;

// 解析 reg query 的输出（纯函数：同步/异步两路共用，避免两处写法漂移）
function parseProxyRegText(text) {
  const out = {
    enable: false, server: '', override: '', autoConfig: '',
    upstream: null, upstreamFrom: '', error: '',
  };
  out.enable = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(text);
  out.server = pickRegValue(text, 'ProxyServer');
  out.override = pickRegValue(text, 'ProxyOverride');
  out.autoConfig = pickRegValue(text, 'AutoConfigURL');
  return out;
}

// 上游代理（加速器）地址：config.json 手填值优先，其次用系统静态代理
function resolveUpstreamFor(out) {
  const manual = String(config.upstreamProxy || '').trim();
  if (manual) {
    out.upstream = manual;
    out.upstreamFrom = 'config';
  } else if (out.enable && out.server) {
    out.upstream = normalizeProxyServer(out.server);
    out.upstreamFrom = out.upstream ? 'registry' : '';
  }
  return out;
}

const REG_QUERY_CMD = `reg query "${INET_SETTINGS_KEY}"`;

// 读系统代理设置（**同步**版）。仍保留给两处必须同步的调用点：
//   · PAC 下发与 /api/stats —— 有 10 秒缓存、且配合 revalidateSystemProxy 后基本只吃缓存；
//   · restorePacSetting（退出还原）—— process.on('exit') 里不能 await。
function readSystemProxy(force) {
  // 非强制：只要读过一次就返回缓存值（哪怕略旧）—— 过期由 revalidateSystemProxy 在后台
  // 异步保鲜，请求路径上绝不同步查注册表。value 为空（首次）或 force 时才同步执行。
  if (!force && systemProxyCache.value) {
    return systemProxyCache.value;
  }
  let out;
  try {
    const { execSync } = require('child_process');
    // 注意：reg.exe 不能用 execFileSync 调（libuv 的参数转义会把键名里的反斜杠吃掉，
    // 实测报「无效项名」），必须整条命令交给 cmd。
    out = parseProxyRegText(execSync(REG_QUERY_CMD, { encoding: 'latin1', timeout: 5000 }));
  } catch (e) {
    out = parseProxyRegText('');
    out.error = e.message;
  }
  resolveUpstreamFor(out);
  systemProxyCache = { at: Date.now(), value: out };
  return out;
}

// ---- V4.12.0：异步版。20 秒巡检改走这里，注册表查询不再阻塞事件循环 ——
// 同步版的 execSync 每次卡住线程几十毫秒，叠加 netstat/PowerShell 的几百毫秒，
// 游戏请求会跟着每 20 秒顿一下。转义语义与同步版一致：child_process.exec 默认经 cmd 跑。
let sysProxyRefreshing = false;
let systemProxyInflight = null;

function readSystemProxyAsync(force) {
  if (!force && systemProxyCache.value && Date.now() - systemProxyCache.at < SYS_PROXY_TTL_MS) {
    return Promise.resolve(systemProxyCache.value);
  }
  // 并发去重（force 除外）：巡检三个函数同一个 tick 到达时，只发一次 reg query
  if (sysProxyRefreshing && !force && systemProxyInflight) return systemProxyInflight;
  const { exec } = require('child_process');
  sysProxyRefreshing = true;
  systemProxyInflight = new Promise((resolve) => {
    exec(REG_QUERY_CMD, { encoding: 'latin1', timeout: 5000 }, (err, stdout) => {
      const out = parseProxyRegText(err ? '' : String(stdout || ''));
      if (err) out.error = err.message;
      resolveUpstreamFor(out);
      systemProxyCache = { at: Date.now(), value: out };
      sysProxyRefreshing = false;
      systemProxyInflight = null;
      resolve(out);
    });
  });
  return systemProxyInflight;
}

// 数据过期就**后台**刷新、本次先用旧值（stale-while-revalidate）。
// 给 PAC 下发与 /api/stats 这类"必须立刻回答"的调用点用：它们不再同步查注册表，
// 而缓存又被 20 秒巡检持续保鲜 —— 浏览器侧几乎永远拿到的是新鲜的。
function revalidateSystemProxy() {
  if (sysProxyRefreshing) return;
  if (systemProxyCache.value && Date.now() - systemProxyCache.at < SYS_PROXY_TTL_MS) return;
  readSystemProxyAsync().catch(() => {});
}

// ProxyOverride 里的绕过项。<local> 表示本机名（PAC 里已单独处理）。
// 只接受保守字符集，免得把奇怪内容带进 PAC。
function bypassPatterns(override) {
  const out = [];
  for (const raw of String(override || '').split(';')) {
    const p = raw.trim();
    if (!p || p === '<local>') continue;
    if (!/^[A-Za-z0-9.*_\-]+$/.test(p)) continue;
    out.push(p);
  }
  return out;
}

// 生成 PAC（v4 · 域名/路径分流）。
//   · 资源 CDN（*.granbluefantasy.akamaized.net）整站走本地缓存代理 —— 游戏的引导 JS
//     （require.js / main.js 等）也全在这个域名上（2026-09-14 抓页面核实，33 处引用）。
//     注意 granbluefantasy 前面是连字符（prd-game-a-granbluefantasy），所以只能后缀匹配。
//   · 游戏本站（*.granbluefantasy.jp）只有 /assets/ 走缓存代理；接口（/rest/ /ob/ /od/）
//     必须直连 —— 2026-09-14 实测：接口流量一旦过本代理（node 逐请求新建连接、非浏览器
//     TLS 指纹），上游会频繁 RST，自动重试也救不回来时游戏内直接报错；直连走浏览器原生
//     HTTP/2 + keep-alive，是「不用缓存工具时」验证过的可靠路径，雷神路由加速照常生效。
// ---------------------------------------------------------------- 链候选存活判定（V4.7.1）
//
// 背景（原清单 P1-6 / P1-5）：系统的 ProxyServer、或从外部 PAC 提取的 accelProxy 里，
// 可能留着一个**已经不监听**的本机端口。典型现场：Clash 已经关掉，注册表里
// `ProxyServer=127.0.0.1:4780` 却还在（而且 ProxyEnable=0，所以看起来"没启用"）。
// 而上面 buildPac 的注释写着"端口没开时连接被立即拒绝，浏览器自动回直连"—— 问题就在这里：
// **每个新域名都要先白吃一次连接拒绝**才回退。域名一多就是肉眼可见的卡顿。
//
// 所以给**本机**链候选加一层存活判定，结果缓存下来供同步的 buildPac 使用。
// 只判本机地址：远程代理探不通未必代表不可用（可能只是慢/被限流），误判会让回源绕远路。
const CHAIN_LIVE_TTL = 120000;   // 存活结论缓存 2 分钟
let chainLiveness = { key: '', alive: null, at: 0, error: '' };
let chainProbing = false;

// 纯函数：是不是本机地址（决定"要不要做存活判定"）
// 只认这两种：链候选的写法由 normalizeProxyServer 的白名单限定为 `[\w.\-]+:\d+`，
// IPv6 的 host:port（[::1]:7890 或 ::1:1080）根本通不过那个白名单、到不了这里 ——
// 所以不为它写分支（写了也是不可达的死代码，任何 mutation 都杀不掉）。
function isLoopbackAddr(hp) {
  const h = String(hp || '').split(':')[0].toLowerCase();
  return h === '127.0.0.1' || h === 'localhost';
}

// 纯函数：该不该把这个链候选写进 PAC？
// 抽出来是为了能离线把所有分支（没候选 / 远程 / 还没结论 / 探明可用 / 探明不通）都测到 ——
// 探测本身需要真的 TLS 握手到外网，那样的测试必然是慢且不稳的。
function shouldChainTo(addr, live) {
  if (!addr) return { chain: false, why: '没有链候选' };
  if (!isLoopbackAddr(addr)) return { chain: true, why: '非本机地址：不做存活判定（远程代理探不通不代表不可用）' };
  // 还没有结论（key 不匹配 / 没探过）时**照旧串接**：宁可保留旧行为，也不要凭"没探过"就摘掉。
  if (!live || live.key !== addr || live.alive === null || live.alive === undefined) {
    return { chain: true, why: '还没有存活结论，先照旧串接' };
  }
  if (live.alive === false) {
    return { chain: false, why: '已探明探不通（' + (live.error || '连不上') + '）' };
  }
  return { chain: true, why: '已探明可用' };
}

// 异步刷新存活结论。buildPac 是同步的，所以它只读缓存、顺手触发一次刷新。
async function refreshChainLiveness(addr) {
  if (!addr) return chainLiveness;
  if (chainProbing) return chainLiveness;
  if (chainLiveness.key === addr && Date.now() - chainLiveness.at < CHAIN_LIVE_TTL) return chainLiveness;
  const m = /^([\w.\-]+):(\d+)$/.exec(addr);
  if (!m) { chainLiveness = { key: addr, alive: null, at: Date.now(), error: '地址写法无法解析' }; return chainLiveness; }
  if (!isLoopbackAddr(addr)) { chainLiveness = { key: addr, alive: null, at: Date.now(), error: '非本机地址，不做存活判定' }; return chainLiveness; }
  chainProbing = true;
  const wasKnown = chainLiveness.key === addr ? chainLiveness.alive : null;
  try {
    const r = await probeHttpProxy(m[1], parseInt(m[2], 10), null, 3000);
    chainLiveness = { key: addr, alive: !!r.ok, at: Date.now(), error: r.ok ? '' : (r.error || '连不上') };
    // 只在结论**变化**时写日志，否则每 2 分钟刷一条会把日志淹掉
    if (wasKnown !== chainLiveness.alive) {
      if (r.ok) log(`[链路] 本机代理 ${addr} 可用 —— 其余流量继续经它出去`);
      else log(`[链路] 本机代理 ${addr} 探不通（${chainLiveness.error}）—— 已从 PAC 的串接里摘掉，`
        + '避免每个新域名都白吃一次连接拒绝（原清单 P1-6 就是这个现象）');
    }
    return chainLiveness;
  } catch (e) {
    chainLiveness = { key: addr, alive: false, at: Date.now(), error: e.message };
    return chainLiveness;
  } finally { chainProbing = false; }
}

function chainLivenessInfo() {
  return { addr: chainLiveness.key || '', alive: chainLiveness.alive, at: chainLiveness.at, error: chainLiveness.error };
}

//   · 其余流量交回系统里配置的静态代理（VPN/加速器网页模式）。"PROXY x; DIRECT" 的回退
//     语义保证 VPN 开/关都不用重取 PAC：端口没开时连接被立即拒绝，浏览器自动回直连。
//     因此这里取「配置过就算」（不看 ProxyEnable），config.json 手填 upstreamProxy 优先。
//     ⚠️ 但"立即拒绝"本身也是有代价的（每个新域名一次），所以 V4.7.1 起本机候选要过存活判定，
//        已探明探不通的直接不写进 PAC —— 见上面 shouldChainTo。
function buildPac(s) {
  const L = [];
  // 【PAC 必须纯 ASCII（V4.23.1）】Chromium 的 chrome.proxy.settings.set（pacScript.data）
  // 只接受 ASCII，出现一个非 ASCII 字符就整单拒绝 —— 2026-10-25 实测：扩展端
  // 「跟随服务端 PAC」一直静默失败、浏览器里只剩兜底 PAC，根因就是这里的中文注释。
  // 所以：注释一律用 ASCII 写；动态插值（如探测错误串）过 asciiOnly；末端再加保险丝。
  L.push('function FindProxyForURL(url, host) {');
  L.push('  host = (host || "").toLowerCase();');
  L.push('  // local / LAN names: direct');
  L.push('  if (isPlainHostName(host) || host === "localhost" || host === "127.0.0.1") return "DIRECT";');
  L.push('  // GBF asset CDN (JP & EN trees): whole domain via local cache proxy');
  L.push('  if (/granbluefantasy[.]akamaized[.]net$/.test(host) || /gbf[.]akamaized[.]net$/.test(host)) {');
  L.push('    return "PROXY ' + HOST + ':' + PROXY_PORT + '; DIRECT";');
  L.push('  }');
  L.push('  // game site: only asset paths (/assets/, /assets_en/) via cache; API must stay direct (upstream RST)');
  L.push('  if (/granbluefantasy[.]jp$/.test(host) && /\\/assets(?:_[a-z]{2})?\\//.test(url)) {');
  L.push('    return "PROXY ' + HOST + ':' + PROXY_PORT + '; DIRECT";');
  L.push('  }');
  for (const pat of bypassPatterns(s.override)) {
    L.push('  if (shExpMatch(host, "' + pat + '")) return "DIRECT";');
  }
  // 串接优先级：系统当前启用的静态代理 > 从外部 PAC 提取的加速器本地代理（雷神网页加速）
  // > 系统里配置过（未启用）的静态代理。都有 DIRECT 兜底，代理死了自动回直连。
  const chain = s.upstream || normalizeProxyServer(config.accelProxy) || normalizeProxyServer(s.server);
  const verdict = shouldChainTo(chain, chainLiveness);
  if (chain && isLoopbackAddr(chain)) {
    // 顺手触发一次异步存活探测（buildPac 是同步的，只能读缓存；结论下次生成 PAC 时生效）。
    // 不 await：这里是响应 /proxy.pac 的路径，绝不能被探测拖住。
    refreshChainLiveness(chain).catch(() => {});
  }
  const asciiOnly = (x) => String(x).replace(/[^\x20-\x7E]/g, '');
  if (verdict.chain) {
    L.push('  // everything else: hand to VPN/accelerator local proxy (DIRECT fallback)');
    L.push('  return "PROXY ' + chain + '; DIRECT";');
  } else if (chain) {
    // 已知探不通：直接直连，别再给每个新域名加一次连接拒绝（原清单 P1-6）
    L.push('  // local proxy ' + chain + ' known unreachable (' + asciiOnly(chainLiveness.error || '') + '), DIRECT');
    L.push('  return "DIRECT";');
  } else {
    L.push('  return "DIRECT";');
  }
  L.push('}');
  const pac = L.join(String.fromCharCode(10));
  // 保险丝：任何路径混进非 ASCII 都在这里去掉并留痕，宁可丢一个注释也不丢整份 PAC。
  const safe = pac.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
  if (safe !== pac) log('[PAC] 生成的 PAC 含非 ASCII 字符，已剥离（Chromium 的 pacScript.data 只接受 ASCII）');
  return safe;
}

function writeAutoConfig(value) {
  const { execSync } = require('child_process');
  if (value) {
    execSync(`reg add "${INET_SETTINGS_KEY}" /v AutoConfigURL /t REG_SZ /d "${value}" /f`, { stdio: 'ignore' });
  } else {
    try { execSync(`reg delete "${INET_SETTINGS_KEY}" /v AutoConfigURL /f`, { stdio: 'ignore' }); }
    catch { /* 本来就没有这个值 */ }
  }
  systemProxyCache = { at: 0, value: null };   // 置空缓存，下次读到最新值
}

// 让系统代理槽位处于「本程序接管」的状态。**幂等**，启动时和之后每 20 秒都会调用。
//
// 为什么要定期调：加速器切换模式（如雷神的模式三）时会清掉或覆写 AutoConfigURL。
// 如果只在启动时检查一次，就会出现「加速器把槽位清空了 → 控制台一直显示未接管 →
// 缓存悄悄不工作」这种状态 —— 实测踩到过。
//
// 三条规则：
//   空着          -> 装上我们的 PAC（并把原值记进 config.json，退出时还原）
//   已经是我们的  -> 什么都不做
//   被别人占着    -> 让位，不抢（加速器自己的 PAC），日志与界面写明
// 另外：如果装上后反复被别人清掉，会暂停接管 10 分钟，避免两个程序来回抢。
let pacLogSig = '';
let pacTakenThenLost = 0;
let pacPauseUntil = 0;
// 临时直连（V4.14.9）：true = 暂停缓存接管，把 PAC 槽位让出去（恢复接管后重新装回）。
// 刻意**不持久化** —— 这是"临时"语义：重启程序即回到正常接管，不存在"忘了恢复"的持久状态。
let pacBypass = false;
// 槽位被别的程序占用、而我们没能从中提取出可串接的本地代理时，记下「占用者 + 为什么没提取到」。
// 过去这个失败是**静默**的：界面只说"槽位被占用，已让位"，用户（和远程支持）看不出原因，
// 只能靠猜 —— 而这份信息恰好是唯一能决定"该改加速器的模式 / 该让它让位 / 该用扩展"的依据。
let foreignPac = null;

function notePacState(sig, prev) {
  if (sig === pacLogSig) return;
  if ((pacLogSig === 'ours' || pacLogSig === 'installed') && sig !== 'ours') {
    log('[系统代理] 槽位已被其他程序改写（原本由本程序接管）');
  }
  pacLogSig = sig;
  if (sig === 'ours' || sig === 'installed') {
    log(`[系统代理] 已接管自动配置脚本 -> ${ourPacUrl()}（退出时还原）`);
    const s = systemProxyCache.value || {};
    // 与 buildPac 的回退链**完全一致**（含 V4.7.1 起的存活判定）。两点都要对齐，否则日志会骗人：
    //   · 候选顺序漏了 config.accelProxy —— 原来这里只算了 s.upstream 与 s.server；
    //   · 没做存活判定 —— 实测踩过：PAC 里其实已经是 DIRECT 了，日志却还写"其余流量交回 127.0.0.1:4780"，
    //     排障时照着看会得出错误结论。
    const chain = s.upstream || normalizeProxyServer(config.accelProxy) || normalizeProxyServer(s.server);
    const verdict = shouldChainTo(chain, chainLiveness);
    if (chain && verdict.chain) {
      // 冷启动那一刻还没探过，所以这里不能断言"交回它会怎样" —— 分两种情况说清楚，
      // 免得日志在"其实还没探明"时就先撒一个谎（用户照着日志排障会被带偏）。
      const knownAlive = chainLiveness.key === chain && chainLiveness.alive === true;
      log(`[系统代理] 其余流量交回 ${chain}（${knownAlive ? '已探明可用' : '端口没开时浏览器自动回直连'}；来源：${s.upstreamFrom === 'config' ? 'config.json' : '系统代理设置'}）`);
    } else if (chain) {
      log(`[系统代理] 其余流量直连（本机代理 ${chain} 已探明探不通：${chainLiveness.error || '连不上'}，已从串接里摘掉）`);
    } else {
      log('[系统代理] 未探测到代理配置，其余流量直连');
    }
  } else if (sig === 'disabled') {
    log('[系统代理] GBFCACHE_NO_PAC=1 —— 跳过接管，系统代理保持原样');
  } else if (sig === 'bypass') {
    log('[系统代理] 临时直连中 —— 缓存接管已暂停（恢复：控制台「恢复缓存接管」或悬浮窗右键菜单）');
  } else if (sig.indexOf('mode:') === 0) {
    log(`[系统代理] pacMode=${sig.slice(5)} —— 不占用系统槽位（留给加速器）；缓存接管已关闭`);
  } else if (sig === 'paused') {
    log('[系统代理] 槽位反复被清掉，暂缓接管中（避免互相抢）');
  } else if (sig.indexOf('foreign-chain:') === 0) {
    const i = sig.indexOf(' -> ');
    log(`[系统代理] 其它程序的 PAC 占用了槽位：${sig.slice(14, i)}`);
    log(`[系统代理] 已从其中提取本地代理 ${sig.slice(i + 4)} 并串接进我们的 PAC —— 接管槽位，加速与缓存并用`);
  } else if (sig.indexOf('foreign:') === 0) {
    log(`[系统代理] 自动配置脚本已被其他程序占用：${sig.slice(8)}`);
    if (foreignPac && foreignPac.reason) log(`[系统代理] 没有接管它的原因：${foreignPac.reason}`);
    log('[系统代理] 为避免与加速器互抢，不去动它 —— 缓存接管不会生效'
      + '（可把加速器改成静态代理模式让我们串接，或在它设置里关掉「系统代理/PAC」，'
      + '或确认它不依赖 PAC 时加载随包的 console-extension）');
  }
}

// pacMode 归一化（纯函数，便于用合成数据把分支测全）。最终只认两种：
//   system （默认）—— 占用系统「自动配置脚本」槽位，任何浏览器都走缓存
//   off            —— 完全不接管，把槽位让给加速器/VPN
// 历史值 browser（专用浏览器模式）曾是"不碰系统槽位，只给指定浏览器实例挂 PAC"，
// 但 V4.3.6 移除了「用缓存模式打开浏览器」之后它已经**没有任何生效机制**：既不占系统槽位、
// 又没有实例能被挂上 PAC，等于缓存完全不工作，而界面上还写着"请用托盘菜单打开"（菜单项已删）。
// V4.3.7 起统一按 off 处理 —— 与它先前的槽位行为一致，不会突然改动用户的系统代理设置；
// 调用方负责把这件事明确告诉用户，免得人在不知情的情况下"缓存莫名不生效"。
// 无法识别的值同样按 off 处理，与归一化前「非 system 即不接管」的行为保持一致。
// 顺带收掉一个同类隐患：配置里写成 "system "（前后带空白）时，旧写法会判定为"非 system"
// 从而**静默不接管**，症状同样是"缓存莫名不生效"，所以这里先 trim 再比较。
function normalizePacMode(raw) {
  return String(raw || 'system').trim().toLowerCase() === 'system' ? 'system' : 'off';
}

async function installPacSetting() {   // V4.12.0 起为 async：注册表读取走异步版，巡检不再阻塞事件循环
  // 「不碰系统代理」开关必须**最先**判断 —— 它在下面 off 模式那条"释放槽位"分支之前。
  //
  // 踩过的坑（V4.6.3 修）：这个开关过去写在 mode 分支之后，于是 pacMode=off 的实例照样会走到
  // "若槽位是我们的就还回去"那一步，把**正在运行的正式实例**的接管清掉。
  // 而构建自测实例正是 pacMode=off：实测跑一次 do-all，开发机上正式实例的 PAC 槽位就被清空，
  // 它随后触发"槽位反复被清掉，暂缓接管（10 分钟）"的避让保护 —— 表现是**缓存整个不生效**，
  // 而日志里只有一句避让提示，很难联想到"刚才跑了一次构建"。
  if (process.env.GBFCACHE_NO_PAC === '1') {
    foreignPac = null;
    notePacState('disabled');
    return false;
  }
  // 临时直连（V4.14.9）：必须排在 pacMode 判断之前 —— 它优先于一切接管形态。
  // 只在"槽位还在我们手里"时动手释放；让位期间加速器若写入了自己的 PAC，绝不去碰。
  // 20 秒巡检也会反复走到这里 —— 幂等（槽位不是我们的就什么都不做），不会来回抢。
  if (pacBypass) {
    const cur = await readSystemProxyAsync(true);
    if (isOurPacUrl(cur.autoConfig)) {
      try {
        const p = config.pacPrev;
        if (p && p.existed && p.value) { writeAutoConfig(p.value); log(`[系统代理] 临时直连：槽位已还原为 ${p.value}`); }
        else { writeAutoConfig(''); log('[系统代理] 临时直连：已释放系统槽位'); }
      } catch (e) { log(`[系统代理] 临时直连：释放槽位失败 ${e.message}`); }
    }
    notePacState('bypass');
    return false;
  }
  // 每轮重算：只有"确实被别人占着、且没能提取出可串接的本地代理"时才重新写上（见下面分支）
  foreignPac = null;
  const rawMode = String(config.pacMode || 'system').trim().toLowerCase();
  const mode = normalizePacMode(rawMode);
  if (rawMode === 'browser') {
    log('[系统代理] pacMode=browser 已不再支持 —— 它依赖的「用缓存模式打开浏览器」已在 V4.3.6 移除，'
      + '该模式下缓存完全不生效，本次按 off 处理（不占用系统槽位）。'
      + '要恢复缓存，请把 config.json 的 pacMode 改成 system 后重启程序');
  }
  if (mode !== 'system') {
    // 若之前是 system 模式（槽位里是我们的地址），切过来时把槽位还回去
    const cur = await readSystemProxyAsync(true);
    if (isOurPacUrl(cur.autoConfig)) {
      try {
        const p = config.pacPrev;
        if (p && p.existed && p.value) { writeAutoConfig(p.value); log(`[系统代理] pacMode=${mode}：已把槽位还原为 ${p.value}`); }
        else { writeAutoConfig(''); log(`[系统代理] pacMode=${mode}：已释放系统槽位`); }
      } catch (e) { log(`[系统代理] pacMode=${mode}：释放槽位失败 ${e.message}`); }
    }
    notePacState('mode:' + mode);
    return false;
  }
  const s = await readSystemProxyAsync(true);
  const ours = ourPacUrl();

  // 被别的程序（典型：雷神网页加速把自己的 PAC 写进槽位）占着：
  // 先试着从它的 PAC 里提取本地代理 —— 提取到就「接管并串接」（它的加速照常工作，
  // 我们缓存游戏资源，互不抢占）；提取不到才让位（不知道它怎么加速，不敢碰）。
  if (s.autoConfig && !isOurPacUrl(s.autoConfig)) {
    const ext = extractProxyFromPac(s.autoConfig);
    if (ext.proxy) {
      foreignPac = null;                     // 提取成功 -> 会接管并串接，不再算"被占着"
      if (config.accelProxy !== ext.proxy) {
        saveConfig({ accelProxy: ext.proxy, accelProxyFrom: s.autoConfig });
      }
      notePacState('foreign-chain:' + s.autoConfig + ' -> ' + ext.proxy);
      // 落到下面的安装流程
    } else {
      // 记下占用者与原因：界面、自检页、日志都靠它说明"为什么没接管、接下来怎么办"
      foreignPac = { url: s.autoConfig, reason: ext.reason || '' };
      notePacState('foreign:' + s.autoConfig);
      return false;
    }
  }

  // 已经是我们的：稳定状态，计数清零
  if (s.autoConfig === ours) {
    pacTakenThenLost = 0;
    notePacState('ours');
    return true;
  }

  // 槽位空着。刚被反复清掉的话先退让一会儿，别和加速器来回抢
  if (pacPauseUntil > Date.now()) {
    notePacState('paused');
    return false;
  }

  if (!config.pacPrev) {
    // 第一次接管：把「原本是什么」记进 config.json，退出时按它还原。
    // 若槽位里已经是我们的地址，说明接管发生在更早（比如那个已被删掉的安装脚本），
    // 原始值无从得知 —— 按「原本没有」记录，退出时清除。绝不能把「我们自己的地址」
    // 当成原值记下来，那样退出时等于还原成自己，槽位永远不还。
    saveConfig({
      pacPrev: isOurPacUrl(s.autoConfig)
        ? { existed: false, value: '' }
        : { existed: !!s.autoConfig, value: s.autoConfig || '' },
    });
  }
  try {
    writeAutoConfig(ours);
    pacTakenThenLost++;
    if (pacTakenThenLost >= 3) {
      pacPauseUntil = Date.now() + 600000;
      log('[系统代理] 槽位反复被清掉：若再被清，10 分钟内不再重装（避免与加速器互相抢）');
    }
    notePacState('installed');
    return true;
  } catch (e) {
    log(`[系统代理] 接管失败：${e.message}`);
    return false;
  }
}

// 退出时还原槽位。只在我们仍占有它时还原 —— 若中途被加速器改写，说明它在用，别碰。
function restorePacSetting() {
  if (process.env.GBFCACHE_NO_PAC === '1') return;   // 从未接管过，退出也不该动它
  let cur = '';
  try { cur = readSystemProxy(true).autoConfig; } catch { /* 忽略 */ }
  if (!cur) return;
  if (!isOurPacUrl(cur)) {
    log(`[系统代理] 已被其他程序改写（${cur}），不做还原`);
    return;
  }
  const p = config.pacPrev;
  try {
    if (p && p.existed && p.value) {
      writeAutoConfig(p.value);
      log(`[系统代理] 已还原为原值：${p.value}`);
    } else {
      writeAutoConfig('');
      log('[系统代理] 已清除本程序设置的自动配置脚本');
    }
  } catch (e) {
    log(`[系统代理] 还原失败：${e.message}`);
  }
}

// 浏览器启动用的「绕过代理」清单。两种情形相反：
//   没配上游代理（VPN/加速器）：把浏览器的后台探活/更新域名绕开 —— 它们在本机网络里
//     本来就不通，若经我们会挂住，浏览器的连通性探测会误判「没有网络」。
//   配了上游代理：只绕开本机地址，其余**全部经我们**（再由我们经上游代理出去）——
//     否则被墙的域名（登录时要用的谷歌验证 recaptcha）会直连而失败。
const BG_BYPASS = [
  '127.0.0.1', 'localhost', '<local>',
  // 浏览器自身的探活/更新服务（在本机网络里本就不通，经我们会挂住）
  '*.google.com', '*.googleapis.com', '*.gstatic.com', '*.googleusercontent.com',
  '*.microsoft.com', '*.live.com', '*.msn.com', '*.msn.cn', '*.bing.com', '*.skype.com',
  '*.office.com', '*.office.net', '*.windows.com', '*.windowsupdate.com',
  '*.msedge.net', '*.msedgeupdate.net', '*.trafficmanager.net', '*.azureedge.net',
  // 广告/统计类：游戏用不到，直连失败即可（省得在我们这里刷一堆"隧道失败"）
  '*.googleadservices.com', '*.googlesyndication.com', '*.doubleclick.net',
  '*.twitter.com', '*.t.co', '*.facebook.com', '*.facebook.net',
  '*.criteo.com', '*.scorecardresearch.com',
];

// 广告/统计类域名：游戏用不到，本机网络里也本来就通不了。
// 浏览器新版绕过清单已经把它们绕开了；但**旧窗口**（启动时注入的还是老清单）仍会把它们
// 送到我们这里，于是错误列表里全是 t.co / twitter / facebook 这类噪音。
// 所以这里再兜一道：这类域名失败不计入错误（只在 verbose 模式留一条日志）。
const NOISE_HOST_RE = /(^|\.)(t\.co|twitter\.com|facebook\.com|facebook\.net|googleadservices\.com|googlesyndication\.com|doubleclick\.net|criteo\.com|scorecardresearch\.com|datadoghq-browser-agent\.com|datadoghq\.com|analytics\.[\w.-]+)$/i;

function isNoiseHost(host) {
  return NOISE_HOST_RE.test(String(host || ''));
}

// 给界面/日志用的系统代理状态摘要
function systemProxyInfo() {
  revalidateSystemProxy();   // 数据过期就后台刷新，本次先用缓存值（V4.12.0：不再同步查注册表）
  const s = readSystemProxy();
  // V4.20.5：面板要如实 —— 探明不通的本机串接（config.json 里留下的加速器端口、accelProxy、
  // 系统静态代理残留都算）不能再报"其余流量/回源经它"。候选链与 buildPac 用**同一个表达式**，
  // 判定读缓存（TTL 2 分钟）并顺手触发刷新，保证结论不会僵死在旧值上。
  const chainCand = s.upstream || normalizeProxyServer(config.accelProxy) || normalizeProxyServer(s.server);
  const chainDead = !!(chainCand && isLoopbackAddr(chainCand) && shouldChainTo(chainCand, chainLiveness).chain === false);
  return {
    pacUrl: ourPacUrl(),
    mode: normalizePacMode(config.pacMode),
    bypass: pacBypass,
    autoConfig: s.autoConfig,
    installed: isOurPacUrl(s.autoConfig),
    upstream: s.upstream || '',
    upstreamFrom: s.upstreamFrom,
    // V4.20.8：面板只讲结果（加速器地址 / 直连、是 / 否）——这几个字段留给接口与测试用，界面不再显示。
    upstreamDead: chainDead,
    accelProxy: config.accelProxy || '',
    accelProxyFrom: config.accelProxyFrom || '',
    staticProxy: s.enable ? s.server : '',
    prevValue: (config.pacPrev && config.pacPrev.value) || '',
    error: s.error || '',
    // 槽位被别人占着、且我们没能提取出可串接的本地代理时，这里带上"谁占着 + 为什么没提取到"。
    // 界面据此给出准确说明与可选做法（没有它，用户只会看到自相矛盾的"请检查是否指向本程序"）。
    foreign: foreignPac ? { url: foreignPac.url, reason: foreignPac.reason } : null,
  };
}

// ------------------------------------------------- 方案 C：回源经加速器的本地代理
//
// 前提：加速器给「网页加速」时会在本机开一个 HTTP 代理端口。若我们的回源能经它出去，
// 就同时拿到缓存和加速。实测雷神当前**没有**这样的常驻端口（只有 leishenSdk 的 10908，
// 普通 HTTP 请求回 426、CONNECT 直接失败），所以要靠探测：它加速时开出来的端口才会被接上。
//
// 探测策略：列出本机监听端口 -> 找到属于加速器类进程的 -> 用 CONNECT 试一次，
// 能建立隧道才算代理。结果缓存，并允许在 config.json 里手填候选：
//   "upstreamProxyCandidates": ["127.0.0.1:12345"]
const ACCEL_PROC_RE = /leigod|leishen|xunyou|uu|netch|clash|verge|v2ray|v2rayN|xray|sing-box|mihomo|shadowsocks|ssr|trojan|wireguard|openvpn|astrill|exitlag|letsvpn|biubiu|qiyou|boost|accel|tunnel|proxy|加速/i;
// 已知不是 HTTP 代理的端口，别去试（实测 10908 是雷神的 SDK 通道：
// 普通 HTTP 请求回 426，CONNECT 直接失败）
const KNOWN_NON_PROXY_PORTS = new Set([10908]);
const CRLF = String.fromCharCode(13, 10);

let detectedUpstream = null;        // 探测到的代理 {host, port, proc}
let upstreamMissStreak = 0;         // 自动探测到的代理连续体检失败次数（>=2 才撤）
let probeReport = null;             // 最近一次探测的明细，给界面看
let probing = false;
let probeLogSig = '';               // 上次写进日志的探测结论，结论不变就不再刷屏
let probeTunnelSig = '';            // 同上，针对「隧道网卡/默认路由」那行
let probeBackoff = { sig: '', fails: 0, nextAt: 0 };   // 反复探不到的候选集合就退避，别每 20 秒戳人家端口

// 列出本机监听端口 + 归属进程名（V4.12.0 起为**异步**：netstat/tasklist 用 exec 跑，
// 不再把事件循环卡住 —— 这条原来每 20 秒巡检都同步执行一次，连接多的机器上两条命令
// 合计能阻塞几百毫秒，游戏请求跟着顿一下）。
// includeAll=true 时不做进程名过滤（用于「全面探测」：加速器进程名未必能猜到）
async function localListeners(includeAll) {
  const { exec } = require('child_process');
  // 注意：这里要晚于 PROXY_PORT 的声明去取，不能在模块顶层拼这个集合
  const ourPorts = new Set([PORT, PROXY_PORT]);
  const run = (cmd) => new Promise((resolve) => {
    exec(cmd, { encoding: 'latin1', timeout: 8000, maxBuffer: 1 << 24 },
      (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
  // 两条命令互不依赖，并行跑
  const [ns, tl] = await Promise.all([run('netstat -ano'), run('tasklist /FO CSV /NH')]);
  const out = [];
  const procs = {};
  for (const line of tl.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m) procs[m[2]] = m[1];
  }
  for (const line of ns.split(/\r?\n/)) {
    if (line.indexOf('LISTENING') === -1) continue;
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    const addr = p[1];
    const pid = p[p.length - 1];
    const ci = addr.lastIndexOf(':');
    if (ci === -1) continue;
    const host = addr.slice(0, ci).replace(/^\[|\]$/g, '');
    const port = parseInt(addr.slice(ci + 1), 10);
    if (!port || ourPorts.has(port) || KNOWN_NON_PROXY_PORTS.has(port)) continue;
    // 只关心本机回环/通配；默认只挑加速器类进程，全面探测时全都要
    if (host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '[::]' && host !== '::') continue;
    const proc = procs[pid] || '';
    if (!includeAll && !ACCEL_PROC_RE.test(proc)) continue;
    out.push({ host: '127.0.0.1', port, pid, proc });
  }
  // 同一端口可能在多个地址上监听，按端口去重
  return [...new Map(out.map((l) => [l.port, l])).values()];
}

// 加速器的隧道层是否在给碧蓝幻想加速，以及默认路由去哪。
//
// 这一条是「共存」的关键判断：路由模式（TUN + 分默认路由）是按目的 IP 判定的、
// 不区分进程，所以**我们的回源连接也会走它的隧道** —— 缓存与加速天然兼得。
//
// 注意不能用 wmic nic：它列不出 utun233 这类新式隧道网卡（实测报「无」，
// 而实际上 utun233 正承载着全部流量）。这里用 PowerShell 的
// Get-NetAdapter + Find-NetRoute，直接问「去 GBF 的 IP 走哪块网卡、源地址是谁」。
function tunnelStatus() {
  const { execFile } = require('child_process');
  const out = { adapters: [], gamePath: '', gameHost: '', error: '' };
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and ($_.Name + $_.InterfaceDescription) -match 'tun|tap|vpn|wireguard|wintun' } | ForEach-Object { 'TUN|' + $_.Name + '|' + $_.InterfaceDescription }",
    "foreach ($h in @('prd-game-a-granbluefantasy.akamaized.net','game.granbluefantasy.jp')) { try { $ip = (Resolve-DnsName $h -Type A -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress; $r = Find-NetRoute -RemoteIPAddress $ip | Select-Object -First 1; 'PATH|' + $h + '|' + $ip + '|' + $r.InterfaceAlias + '|' + $r.IPAddress } catch { 'PATH|' + $h + '|-|-|-' } }",
  ].join('; ');
  return new Promise((resolve) => {
    try {
      const b64 = Buffer.from(script, 'utf16le').toString('base64');
      // 用 UTF-8 解码：网卡名可能是中文（不给 OutputEncoding 会按控制台代码页输出，
      // 用 latin1 读就成了乱码）。execFile 直传参数数组、不经 shell，没有转义问题。
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
        { encoding: 'utf8', timeout: 12000, maxBuffer: 1 << 20, windowsHide: true },
        (err, stdout) => {
          if (err) out.error = err.message;
          for (const line of String(stdout || '').split(/\r?\n/)) {
            const p = line.trim().split('|');
            if (p[0] === 'TUN' && p[1]) out.adapters.push({ name: p[1], desc: p[2] || '', status: 'Up' });
            if (p[0] === 'PATH' && p[1] && p[3] && p[3] !== '-') {
              out.gameHost = p[1];
              out.gameIface = p[3];
              out.gamePath = '去 ' + p[1] + '（' + p[2] + '）走网卡 ' + p[3] + '，源地址 ' + p[4];
            }
          }
          resolve(out);
        });
    } catch (e) {
      out.error = e.message;
      resolve(out);
    }
  });
}

// 试一次「CONNECT → TLS 握手 → 真发一个 HEAD」三层都过，才算可用的 HTTP 代理。
//
// 只判 CONNECT 会严重误报：本机有些服务（实测 QQ.exe 的 4310）对任何请求都回 200，
// 但它不是代理 —— 挂上去会让每次回源先失败一次再退回直连，既慢又误导。
function probeHttpProxy(host, port, target, timeoutMs) {
  return new Promise((resolve) => {
    const net = require('net');
    const tlsMod = require('tls');
    const t = target || 'www.baidu.com:443';
    const targetHost = t.split(':')[0];
    const started = Date.now();
    const sock = net.connect(port, host);
    let settled = false;
    let stage = '连接';
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(Object.assign({ host, port, ms: Date.now() - started, stage }, r));
    };
    sock.setTimeout(timeoutMs || 1500, () => finish({ ok: false, error: '超时（' + stage + '）' }));
    sock.on('error', (e) => finish({ ok: false, error: e.message }));
    sock.on('connect', () => {
      stage = 'CONNECT';
      sock.write('CONNECT ' + t + ' HTTP/1.1' + CRLF + 'Host: ' + t + CRLF + CRLF);
    });

    let buf = '';
    const onData = (chunk) => {
      if (settled) return;
      buf += chunk.toString('latin1');
      const end = buf.indexOf(CRLF + CRLF);
      if (end === -1) {
        if (buf.length > 8192) finish({ ok: false, error: '响应异常' });
        return;
      }
      sock.removeListener('data', onData);
      const status = parseInt((buf.split(CRLF)[0].split(' ')[1] || ''), 10);
      if (status !== 200) return finish({ ok: false, status, error: 'CONNECT 被拒（HTTP ' + status + '）' });

      const rest = buf.slice(end + 4);
      sock.setTimeout(0);
      sock.pause();
      if (rest) sock.unshift(Buffer.from(rest, 'latin1'));
      stage = 'TLS 握手';
      sock.setTimeout((timeoutMs || 1500) * 2, () => finish({ ok: false, error: 'TLS 握手超时' }));
      const tlsSock = tlsMod.connect({
        socket: sock, servername: targetHost, rejectUnauthorized: false,
      }, () => {
        stage = 'HTTP 请求';
        tlsSock.write('HEAD / HTTP/1.1' + CRLF + 'Host: ' + targetHost + CRLF
          + 'Connection: close' + CRLF + CRLF);
      });
      tlsSock.once('error', (e) => finish({ ok: false, error: 'TLS 失败：' + (e.code || e.message) }));
      let head = '';
      tlsSock.on('data', (c) => {
        head += c.toString('latin1');
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
        if (m) return finish({ ok: true, status: Number(m[1]) });
        if (head.length > 4096) finish({ ok: false, error: '不是 HTTP 响应' });
      });
    };
    sock.on('data', onData);
  });
}

// 探测加速器代理。
// includeAll=true（手动点「探测加速器代理」）：先按进程名挑候选，挑不出来再把本机
// 所有监听端口扫一遍 —— 加速器的进程名未必能猜到。定期体检只用按名过滤的那一档，
// 免得每隔 20 秒就把本机一堆无关服务全敲一遍。
async function detectUpstreamProxy(force, includeAll) {
  if (probing) return detectedUpstream;
  if (!force && detectedUpstream) return detectedUpstream;
  probing = true;
  try {
    const cfgList = Array.isArray(config.upstreamProxyCandidates) ? config.upstreamProxyCandidates : [];
    const cand = [];
    for (const s of cfgList) {
      const m = /^([\w.\-]+):(\d+)$/.exec(String(s).trim());
      if (m) cand.push({ host: m[1], port: parseInt(m[2], 10), proc: '(config.json 指定)', fromConfig: true });
    }
    // 按进程名挑出来的候选「可以启用」；下面全面扫描出来的只报告、不启用
    for (const l of await localListeners(false)) {
      if (!cand.some((c) => c.port === l.port)) cand.push(Object.assign({ byName: true }, l));
    }

    const tried = [];
    // 并行探测（一批 6 个，超时 1.5 秒），避免几十个端口串行等到天荒地老。
    // 外面再套一层看门狗：probeHttpProxy 万一因为某个怪端口不返回，
    // 整批也必须按时结束 —— 探测是给界面用的，绝不能挂在这里。
    const withWatchdog = (p, ms, port) => Promise.race([
      p,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: '超时（' + ms + 'ms）', port }), ms)),
    ]);
    const probeList = async (list) => {
      for (let i = 0; i < list.length; i += 6) {
        const batch = list.slice(i, i + 6);
        const rs = await Promise.all(batch.map((c) => withWatchdog(probeHttpProxy(c.host, c.port, null, 4000), 6000, c.port)));
        for (let k = 0; k < batch.length; k++) {
          const c = batch[k];
          const r = rs[k];
          tried.push({ host: c.host, port: c.port, proc: c.proc, ok: r.ok, error: r.error || '', ms: r.ms });
          if (r.ok) return c;
        }
      }
      return null;
    };

    let picked = await probeList(cand.slice(0, 8));
    if (!picked && includeAll) {
      const all = (await localListeners(true))
        .filter((l) => !cand.some((c) => c.port === l.port))
        .map((l) => Object.assign({ byAll: true }, l));
      log(`[上游代理] 按进程名没挑出代理，改为全面扫描本机 ${all.length} 个监听端口`);
      picked = await probeList(all.slice(0, 40));
    }

    // 只有「来自 config.json」或「进程名像加速器」的才自动启用。
    // 全面扫描出来的即使验证通过也不启用：本机别的软件也可能自带 HTTP 代理，
    // 把游戏回源挂到它身上不合适（实测 QQ 的 4310 就能通过 CONNECT 判定）。
    let notAdopted = null;
    if (picked && !picked.fromConfig && !picked.byName) notAdopted = picked;

    if (picked && !notAdopted) {
      detectedUpstream = { host: picked.host, port: picked.port, proc: picked.proc };
      chainAgentCache = { key: '', agent: null };
      log(`[上游代理] 探测到可用代理：${picked.host}:${picked.port}（${picked.proc}）—— 回源将经它出去`);
    } else {
      detectedUpstream = null;
      if (notAdopted) {
        log(`[上游代理] 全端口扫描发现一个可用的 HTTP 代理 ${notAdopted.host}:${notAdopted.port}`
          + `（进程 ${notAdopted.proc || '未知'}），但它不像加速器，**未自动启用**；`
          + '若确认这是加速器的代理，把它填进 config.json 的 upstreamProxy');
      } else if (tried.length) {
        // 结论没变就不重复写日志：加速器的 SDK 端口一直开着，
        // 每 20 秒刷一条会把日志淹掉（也会让人觉得「一直在动」）
        const sig = tried.map((t) => t.port + ':' + (t.error || 'ok')).join(',');
        if (sig !== probeLogSig) {
          probeLogSig = sig;
          log(`[上游代理] 探测了 ${tried.length} 个端口，都不是 HTTP 代理：` +
            tried.map((t) => t.port + '(' + (t.proc || '?') + ': ' + (t.error || 'ok') + ')').join('、'));
        }
      }
    }
    const tun = await tunnelStatus();
    // 签名只取「网卡集合 + GBF 走哪块网卡」：CDN 节点 IP 会轮换，
    // 把它算进签名会每个小时刷好几条没意义的日志
    const tunSig = JSON.stringify(tun.adapters) + '|' + (tun.gameIface || '');
    if ((tun.adapters.length || tun.gamePath) && tunSig !== probeTunnelSig) {
      probeTunnelSig = tunSig;
      // 路由刚被接管/撤销：旧路由上的空闲连接已经不可用，复用它们只会吃到
      // ECONNRESET/超时。这里立刻清空，连同加速器隧道 agent 的池一起。
      const dropped = dropIdleSockets(https.globalAgent) + dropIdleSockets(chainAgentCache.agent);
      log('[加速器] 隧道网卡：' + (tun.adapters.map((a) => a.name).join('、') || '无') +
        '（' + (tun.gamePath || 'GBF 选路未知') + '）—— 路由模式下我们的回源也走它，缓存与加速并用' +
        (dropped ? `（已丢弃 ${dropped} 条旧路由的空闲连接）` : ''));
    }
    probeReport = {
      at: new Date().toISOString(), candidates: tried, picked: detectedUpstream, tunnel: tun,
      notAdopted: notAdopted ? { host: notAdopted.host, port: notAdopted.port, proc: notAdopted.proc || '' } : null,
    };
    return detectedUpstream;
  } finally {
    probing = false;
  }
}

// 当前生效的上游代理（加速器）：环境变量 > config.json 手填 > 系统静态代理
// > 从加速器 PAC 提取的本地代理（config.accelProxy）> 自动探测
//
// 【V4.12.2 补上 config.accelProxy 这一档】
// 过去这里**只看 s.upstream**，而 buildPac 的串接候选是
//   `s.upstream || normalizeProxyServer(config.accelProxy) || normalizeProxyServer(s.server)`
// —— 两处取的不是同一套。后果是一个「一半生效、一半不生效」的怪状态：当加速器代理是
// 靠「从它的 PAC 里提取」学来的（installPacSetting 把它写进 config.accelProxy），
// PAC 会把其余流量串接给加速器，而**回源仍在直连** —— 表现就是「缓存能用，但游戏的
// 资源回源没走加速线路」，那条加速线路带来的收益（实测级别：几十毫秒）完全拿不到。
//
// 这一档为什么要过 shouldChainTo：加速器关掉后 config.accelProxy 会残留成死地址。
// 20 秒巡检的 checkChainHealth 探的正是这个候选，结论落在 chainLiveness 上；这里复用
// 同一个判定，探明不通就跳过（自然落到自动探测或直连）—— 既不会让回源去啃死端口，
// 也不会把 checkUpstreamHealth 的自动探测路径堵死（它在 currentUpstreamProxy() 非空时
// 就不去探测了，漏掉新出现的加速器代理）。
// 注：s.server（系统里配置过但**未启用**的静态代理）这里仍不取 —— 它多半是别的软件
// 卸掉后留下的死端口（项目历史上实测过 127.0.0.1:4780 那种残留），回源不该主动往上挂。
function currentUpstreamProxy() {
  const envVal = String(process.env.GBFCACHE_UPSTREAM_PROXY || '').trim();
  const cfgVal = String(config.upstreamProxy || '').trim();
  const manual = envVal || cfgVal;
  const m = /^([\w.\-]+):(\d+)$/.exec(manual);
  if (m) {
    // V4.20.5：配置口（config.json / 环境变量）也要过存活判定 —— 上面那段注释写的正是
    // "同一个判定，探明不通就跳过"，但这条分支当初漏了它：加速器关了、端口还留在配置里时，
    // 回源每隔 60 秒白啃一次死端口（chainFailUntil 只兜 60 秒），面板还照报"经加速器"。
    // 探明不通就不返回 —— 自然落到后面的系统代理 / accelProxy / 自动探测 / 直连，
    // 且 checkUpstreamHealth 的自动探测路径随之重新启用（加速器再开起来能被重新发现）。
    if (shouldChainTo(manual, chainLiveness).chain) {
      return { host: m[1], port: parseInt(m[2], 10), from: envVal ? '环境变量' : 'config.json' };
    }
  }
  const s = systemProxyCache.value;
  if (s && s.upstream) {
    const n = /^([\w.\-]+):(\d+)$/.exec(s.upstream);
    // V4.20.5：这条分支同样要过存活判定 —— config.json 的 upstreamProxy 会被并进系统缓存
    // （upstreamFrom=config，见 systemProxyInfo 的 upstream 字段），漏了它等于漏了用户实际
    // 在用的那个字段：加速器关了仍会每隔 60 秒去啃一次死端口、面板照报"经它"。
    if (n && shouldChainTo(s.upstream, chainLiveness).chain) {
      return { host: n[1], port: parseInt(n[2], 10), from: s.upstreamFrom === 'config' ? 'config.json' : '系统代理设置' };
    }
  }
  const accel = normalizeProxyServer(config.accelProxy);
  if (accel && shouldChainTo(accel, chainLiveness).chain) {
    const n = /^([\w.\-]+):(\d+)$/.exec(accel);
    if (n) return { host: n[1], port: parseInt(n[2], 10), from: '加速器 PAC 提取' };
  }
  if (detectedUpstream) return Object.assign({}, detectedUpstream, { from: '自动探测' });
  return null;
}

let chainAgentCache = { key: '', agent: null };
let chainWarned = false;
// 链式回源失败（连不上加速器）后的旁路窗口：窗口内先直连，避免一次故障把整条链路拖死
let chainFailUntil = 0;

// 经上游代理建立到目标主机的 TLS 连接（HTTP CONNECT 隧道）
function tunnelThroughProxy(proxy, targetHost, targetPort, cb) {
  const net = require('net');
  const tlsMod = require('tls');
  const sock = net.connect(proxy.port, proxy.host);
  let settled = false;
  let established = false;   // CONNECT 是否已成功（用于区分「代理挂了」与「目标站有问题」）
  const fail = (e) => {
    if (settled) return;
    settled = true;
    if (!established) {
      chainFailUntil = Date.now() + 60000;
      log(`[上游代理] ${proxy.host}:${proxy.port} 连不上（${e.message}）—— 60 秒内先直连回源`);
    }
    try { sock.destroy(); } catch {}
    cb(e);
  };
  sock.setTimeout(12000, () => fail(new Error('连接加速器代理超时')));
  sock.on('error', fail);
  sock.on('connect', () => {
    sock.write('CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1' + CRLF
      + 'Host: ' + targetHost + ':' + targetPort + CRLF + CRLF);
  });
  let buf = '';
  const onData = (chunk) => {
    if (settled) return;
    buf += chunk.toString('latin1');
    const end = buf.indexOf(CRLF + CRLF);
    if (end === -1) {
      if (buf.length > 8192) fail(new Error('加速器代理响应异常'));
      return;
    }
    sock.removeListener('data', onData);
    const status = parseInt((buf.split(CRLF)[0].split(' ')[1] || ''), 10);
    if (status !== 200) return fail(new Error('加速器代理拒绝 CONNECT（HTTP ' + status + '）'));
    established = true;
    const rest = buf.slice(end + 4);
    sock.setTimeout(0);
    sock.pause();
    if (rest) sock.unshift(Buffer.from(rest, 'latin1'));
    const t = tlsMod.connect({
      socket: sock,
      servername: targetHost,
      // 加速器自己可能也在做中间人（雷神就装了根证书），证书链在 Node 里未必认；
      // 可用 config.json 的 upstreamProxyVerifyTLS=false 关掉校验。
      rejectUnauthorized: config.upstreamProxyVerifyTLS !== false,
    }, () => { settled = true; cb(null, t); });
    t.once('error', (e) => {
      if (!settled && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALT_NAME/i.test(e.code || e.message || '')) {
        log(`[上游代理] 经加速器回源时证书校验失败（${e.code || e.message}）——`
          + '若该加速器自己做中间人，可在 config.json 里设 "upstreamProxyVerifyTLS": false');
      }
      fail(e);
    });
  };
  sock.on('data', onData);
}

// 需要链式回源时用的 agent（不用 keep-alive，避免僵死连接）
function chainAgent() {
  if (Date.now() < chainFailUntil) return null;
  const p = currentUpstreamProxy();
  if (!p) return null;
  const key = p.host + ':' + p.port;
  if (chainAgentCache.key === key && chainAgentCache.agent) return chainAgentCache.agent;
  // V4.8.11：**改为开 keep-alive**。原来关着（当时的注释是"避免僵死连接"），代价是经隧道
  // 回源时**每个资源都要重新 CONNECT + TLS 握手**（每个省 100~300ms），而资源动辄几千个。
  // 僵死连接的风险有兜底：CHAIN_DEAD 检测 + 60 秒旁路窗口，keepAliveMsecs 也会让空闲连接自然回收。
  class ChainAgent extends https.Agent {}
  const agent = new ChainAgent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 8 });
  agent.createConnection = function (options, cb) {
    const host = options.host || options.hostname;
    const port = options.port || 443;
    tunnelThroughProxy(p, host, port, cb);
  };
  chainAgentCache = { key, agent };
  if (!chainWarned) {
    chainWarned = true;
    log(`[上游代理] 回源改经 ${key}（来源：${p.from}）`);
  }
  return agent;
}

// 主动体检：PAC 串接用的那个本机代理（accelProxy / 系统 ProxyServer）还活着吗？
// 它与自动探测那条是**两回事**：那条走 detectedUpstream，这条是 buildPac 直接写进 PAC 的。
// 原清单 P1-5 要的就是这个 —— 加速器关掉后残留的端口被 `; DIRECT` 掩盖、看不出来，
// 但每个新域名都要先吃一次连接拒绝。探明不通后 buildPac 会把它摘掉（见 shouldChainTo）。
async function checkChainHealth() {
  const s = await readSystemProxyAsync().catch(() => null);
  const chain = (s && s.upstream) || normalizeProxyServer(config.accelProxy) || normalizeProxyServer(s && s.server);
  if (chain && isLoopbackAddr(chain)) { await refreshChainLiveness(chain); return; }
  // 候选**没了**（例如用户把系统里残留的 ProxyServer 清掉了）→ 必须把存活结论也清掉，
  // 否则界面会一直挂着那句某个已失效的本机代理补注：它记的是**上一次**探过的地址，
  // 而候选消失后根本不会再去探，于是永远不更新（实测踩过：清了注册表、提示还在）。
  if (chainLiveness.key) {
    chainLiveness = { key: '', alive: null, at: 0, error: '' };
    log('[链路] 上游代理候选已消失（系统代理设置与配置里都没有了）—— 清除之前的存活结论');
  }
}

// 主动体检：自动探测来的代理一旦不可用就撤掉，恢复直连（避免加速器关掉后一直报错）
async function checkUpstreamHealth() {
  const p = currentUpstreamProxy();
  if (!p) {
    // 定期去找加速器的代理，但要有退避：候选端口集合没变又反复探不到，
    // 就把间隔拉长（最长 5 分钟）—— 免得每 20 秒去戳一遍加速器的 SDK 端口，
    // 日志也被刷满。一旦端口集合变了（加速器开关/换端口），立刻恢复探测。
    const sig = (await localListeners(false)).map((l) => l.port).join(',');
    if (sig === probeBackoff.sig && Date.now() < probeBackoff.nextAt) return;
    await detectUpstreamProxy();
    if (detectedUpstream) {
      probeBackoff = { sig: '', fails: 0, nextAt: 0 };
    } else {
      probeBackoff.fails = sig === probeBackoff.sig ? probeBackoff.fails + 1 : 0;
      probeBackoff.sig = sig;
      const wait = Math.min(20000 * Math.pow(2, Math.min(probeBackoff.fails, 4)), 300000);
      probeBackoff.nextAt = Date.now() + wait;
    }
    return;
  }
  if (p.from !== '自动探测') return;      // 手动指定的保留，尊重用户选择
  const r = await probeHttpProxy(p.host, p.port, null, 4000);
  if (!r.ok) {
    // 连续两次探不到才撤掉：VPN/加速器的本地代理偶尔会忙，一次失败就丢弃会让
    // 绕过清单跟着反复切换（表现为谷歌验证时好时坏）
    upstreamMissStreak++;
    if (upstreamMissStreak < 2) return;
    log(`[上游代理] ${p.host}:${p.port} 已不可用（${r.error}）—— 恢复直连回源`);
    detectedUpstream = null;
    chainAgentCache = { key: '', agent: null };
    chainWarned = false;
    chainFailUntil = 0;
  } else {
    upstreamMissStreak = 0;
  }
}

// 给界面/日志看的探测明细
function upstreamProbeInfo() {
  const p = currentUpstreamProxy();   // 已过存活判定（V4.20.5）：探不通的候选不会在这里"装活"
  return {
    active: !!p,
    proxy: p ? p.host + ':' + p.port : '',
    from: p ? p.from : '',
    // V4.20.5：面板"回源是否经加速器"靠它把"配置了但探不通"讲清楚（而不是笼统一句"否"）
    liveness: chainLivenessInfo(),
    lastProbe: probeReport
      ? {
        at: probeReport.at,
        picked: probeReport.picked ? probeReport.picked.host + ':' + probeReport.picked.port : '',
        candidates: probeReport.candidates.map((c) => ({
          port: c.port, proc: c.proc || '?', ok: c.ok, error: c.error,
        })),
        tunnel: probeReport.tunnel || null,
        notAdopted: probeReport.notAdopted || null,
      }
      : null,
  };
}

// ---------------------------------------------------------------- 素材路径判据（V4.14.4：双语/多语言）
//
// 游戏的素材树按**语言**分开：日语在 `/assets/`，英语在 `/assets_en/`（手机端真机实测；
// 两棵树结构一一对应、共用同一个版本戳号）。此前所有"这是不是素材"的判据都写死 `/assets/`，
// 于是切到英语后一条素材都进不了缓存 —— 现象是资源请求/命中/写入**一起停住**。
//
// 下面两条是**全项目唯一**的判据，别在别处再写字面正则（测试会盯着"只有一份"）：
const ASSET_PATH_RE = /^\/assets(?:_[a-z]{2})?\//;   // 路径判据：/assets/… 与 /assets_en/…
const ASSET_DIR_RE = /^assets(?:_[a-z]{2})?$/;       // 磁盘基目录名：assets / assets_en / …

// 只对这些扩展名做"回源后写缓存"，避免把 API 响应写进缓存盘
const CACHEABLE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.mp3', '.ogg', '.m4a', '.wav', '.aac',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.css', '.js', '.json', '.txt', '.svg', '.xml',
  '.mp4', '.webm', '.unityweb',
]);

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.unityweb': 'application/octet-stream',
};

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

// 自检探针图：这个文件在游戏源站上并不存在，只可能由本服务提供。
// 因此「能加载出来」就等价于「扩展确实在拦截并把请求送到了这里」。
const SELFTEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAHklEQVR42mPQf3CCJMQAxEJVGUSiUQ2jGgZaA0kIAM+WKURptzyTAAAAAElFTkSuQmCC', 'base64');
const SELFTEST_PATH = '/assets/__gbfcache_selftest__.png';

// 统计
// merged：同资源并发回源被合并掉的请求数；notModified：条件请求回 304 的次数；
// rejected：内容体检不过、拒绝入库的响应数（响应本身照常回给浏览器）。
const stats = {
  hit: 0, miss: 0, stored: 0, dynamic: 0, error: 0,
  merged: 0, notModified: 0, rejected: 0,
  // P0-5（V4.16.0）：迁移/跟随的计数与耗时。此前迁移耗时不在任何统计里（B-11），
  // 修完无法验收 —— 先立仪表。V4.18.0 起还带 refreshed/字节数（"真变重下"的量）。
  migrate: { tries: 0, ok: 0, failed: 0, msTotal: 0, refreshed: 0, refreshedBytes: 0 },
  follow: { tried: 0, ok: 0, skipped: 0, refreshed: 0, refreshedBytes: 0 },
};
let startedAt = Date.now();

// ---------------------------------------------------------------- 回源耗时遥测（V4.11.0）
//
// 记录「前台资源未命中后**真正出网回源**」的耗时，控制台用 P50/P95/P99 看回源快不慢
//（有没有被加速器链路或网络拖累）。刻意的边界，改之前先读这里：
//   · 打点包在回源合并（fetchOriginShared）的**队首 fetcher** 里 —— 只有真正出网的那次
//     会记，被合并的等待者不重复记（等待者没出网，记的是别人的耗时）；
//   · 预热的条件 GET（prewarmFetch）不算 —— 那是后台流量，混进来会把分布拖歪；
//   · **失败的回源也记**：p99 里冒出 8s 的大样本，正是超时/重试在起作用的直接证据，
//     这是最有诊断价值的样本，不要"只记成功"。
// 样本只留最近 ORIGIN_LATENCY_MAX 条（环形语义：满了丢最旧的），分位数在 /api/stats
// 里现算 —— 500 个数排序是微秒级，不值得为它维护第二份有序结构。
const ORIGIN_LATENCY_MAX = 500;
const originLatencySamples = [];

function noteOriginLatency(ms) {
  originLatencySamples.push(ms);
  if (originLatencySamples.length > ORIGIN_LATENCY_MAX) originLatencySamples.shift();
}

// 分位取样：floor(n*q) 越界时取最大（与常见的 nearest-rank 口径一致）。
// 没有样本时回 null 而不是 0 —— 0 是"测到了且很快"，null 才是"还没测过"，两者含义不同。
function originLatencyPercentiles() {
  const n = originLatencySamples.length;
  if (!n) return { count: 0, p50: null, p95: null, p99: null };
  const sorted = originLatencySamples.slice().sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(n - 1, Math.floor(n * q))];
  return { count: n, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) };
}

// 保留最近若干条错误原因，便于通过 /health 直接排查（不用去翻控制台窗口）
const recentErrors = [];
function noteError(msg) {
  const line = new Date().toTimeString().slice(0, 8) + '  ' + msg;
  recentErrors.push(line);
  if (recentErrors.length > 15) recentErrors.shift();
  scheduleStatsBroadcast();
}

// ---------------------------------------------------------------- 观测：命中来源 & X-VERSION
//
// 这一节是 V4.6.5 新增的「先看清再动手」基础设施，本身不改变任何缓存行为。
// 两件事需要先有实测数据才敢改：
//   ① 命中来源分布 —— 决定"要不要把命中响应头从 immutable 改成 no-store"；
//   ② X-VERSION 到底出现在哪类请求上 —— 决定"能不能拿它当资源版本做淘汰"。

// 命中来源分布：按**实际回给浏览器的** X-GBFCache-Source 取值计数。
//
// ⚠️ 这里有一处测量盲区，读数字时必须一起看：被 Edge 自身磁盘缓存命中的请求
// 根本不会到达本代理，所以本表只统计「到了代理的请求」。正确的读法是
// 「命中率高 且 资源请求总量低」= 浏览器缓存在前面挡了大部分（正常现象），
// 不能当成"代理没用"。
//
// 打点约定：必须与响应头写在同一个对象字面量里（'X-GBFCache-Source': noteSource('...')），
// 这样日后新增分支时不会漏统计 —— test-observe.js 的 B 段会钉住这条约定。
const sourceStats = Object.create(null);
function noteSource(kind) {
  sourceStats[kind] = (sourceStats[kind] || 0) + 1;
  return kind;
}

function sourceCounts() {
  const hit = sourceStats['local-cache'] || 0;
  const upstream = sourceStats.upstream || 0;
  let other = 0;
  for (const k of Object.keys(sourceStats)) {
    if (k !== 'local-cache' && k !== 'upstream') other += sourceStats[k];
  }
  const total = hit + upstream;
  return {
    counts: Object.assign({}, sourceStats),
    hit, upstream, other, total,
    // 只对"到达代理的请求"算命中率。total 为 0 时给 null，
    // 免得界面把 0/0 显示成"命中率 0%"而看起来像故障。
    hitRate: total ? Math.round(hit / total * 1000) / 10 : null,
  };
}

// X-VERSION 观测
//
// 游戏给请求带的「客户端资源版本」。后续的版本戳目录淘汰想拿它当"当前版本"，
// 但它究竟出现在哪类请求上、**是否也出现在 /assets/ 请求上**，此前没有实测依据
// （翻遍历史日志只见到它出现在 POST /rest/ 上，而 /rest/ 走的正是 handleIntercepted
// 里那条 isAssetReq 早退分支）。所以先把观测摆出来，等能看到真实分布再决定怎么用 ——
// 不凭假设开删。
const XVERSION_RECENT_MAX = 8;

const xVersionObs = {
  seen: 0,            // 带 X-VERSION 的请求数
  onAsset: 0,         // 其中路径以 /assets/ 开头的
  onOther: 0,
  assetRequests: 0,   // 同期见过的 /assets/ 请求总数（算占比用）
  last: null,
  lastAt: null,
  lastPath: '',
  recent: [],         // 最近几条，便于人工核对
};

// 两处入口都必须调用它，且必须在各自的 isAssetReq / 静态路径判断**之前** ——
// 见上面那条说明：X-VERSION 目前只在 /rest/ 这类非资源请求上被观测到，
// 若把调用点放进资源分支里，就会永远读不到。
function noteXVersion(req, restPath) {
  const p = String(restPath || '');
  const isAsset = ASSET_PATH_RE.test(p);
  if (isAsset) xVersionObs.assetRequests++;

  const v = (req.headers || {})['x-version'];
  if (!v) return;
  xVersionObs.seen++;
  if (isAsset) xVersionObs.onAsset++; else xVersionObs.onOther++;
  xVersionObs.last = String(v);
  xVersionObs.lastAt = Date.now();
  xVersionObs.lastPath = p;
  xVersionObs.recent.push({
    t: new Date().toTimeString().slice(0, 8), v: String(v), path: p, asset: isAsset,
  });
  if (xVersionObs.recent.length > XVERSION_RECENT_MAX) xVersionObs.recent.shift();
}

// ---------------------------------------------------------------- 实时日志 & 推送

const MAX_LOG = 400;
const requestLog = [];          // 最近的请求记录（环形缓冲）
let logSeq = 0;

const sseClients = new Set();   // 已连接的界面客户端

function broadcast(event, data) {
  const NL = '\u000a';
  const payload = 'event: ' + event + NL + 'data: ' + JSON.stringify(data) + NL + NL;
  for (const c of sseClients) {
    try { c.write(payload); } catch { /* 客户端断开，稍后清理 */ }
  }
}

function pushLog(entry) {
  entry.id = ++logSeq;
  entry.t = new Date().toTimeString().slice(0, 8);
  requestLog.push(entry);
  if (requestLog.length > MAX_LOG) requestLog.shift();
  broadcast('log', entry);
  scheduleStatsBroadcast();
}

function broadcastStats() {
  broadcast('stats', {
    stats,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    recentErrors: recentErrors.slice(-6),
    // 观测数据跟着实时推送，控制台那两个面板才能自己刷新（v4.6.5）
    sources: sourceCounts(),
    xVersion: xVersionObs,
    // P1-A（V4.18.0）：实时卡片要的迁移/跟随实况与档位（与 /api/stats 同字段）
    followLive: { queued: followState.queue.length, active: followState.active },
    modes: { prewarmEnabled: config.prewarmEnabled === true, followEnabled: followEnabled() },
    stamps: stampStatusFromCacheInfo(),
    // 回源耗时分布（V4.11.0）与 /api/stats 同口径，实时面板才能跟着请求刷新
    originLatency: originLatencyPercentiles(),
  });
}

// 请求密集时节流，避免每来一个请求就推一次
let statsTimer = null;
function scheduleStatsBroadcast() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => { statsTimer = null; broadcastStats(); }, 250);
}

// ---------------------------------------------------------------- 悬浮监控窗（V4.13.2）
//
// 关掉控制台窗口之后，托盘把一个小长条浮在屏幕右上角，持续显示
// 「命中 / 回源 / 新写入 / 异常拦截 / 错误 / 命中率」，便于一边玩游戏一边瞄一眼。
//
// 【职责划分】本文件只做**判定**（该不该显示），显示由托盘做（tray.ps1）——
// 那个小条是托盘进程里的**一个 WinForms 窗口**：不是浏览器窗口、也不是独立进程。
// 这么分有两个好处：
//   ① 判定是纯函数式的（看时间与集合），能被自测单独覆盖；
//   ② **"窗口的显隐"由拥有那个窗口的进程直接 Show()/Hide()** —— 不经过窗口标题匹配、
//      也不发 WM_CLOSE。V4.13.0 那版正是栽在跨进程管可见性上：用户点窗口关闭，
//      托盘下一次"对齐"又把它开回来，表现为"永远关不掉"。
//
// 【怎么知道控制台在不在】两条信号，缺一不可：
//   ① **页面自己在 pagehide 时打的 beacon**（`/api/console-closing`）—— 首选信号，立刻开始计时；
//   ② **SSE 连接断开**（`/events`）—— 兜底（页面崩了、beacon 没发出去时用）。
//
// ⚠️ **不能只靠 ②**：浏览器/系统可能把连接留成"半死"状态（窗口没了、socket 还挂着），
// 服务端要等下一次 20 秒心跳写失败才发现 —— 用户实测报过"关掉控制台后**很久**悬浮窗才出来"，
// 就是撞上了这个。有 ① 之后，宽限期从"页面说要走"那一刻就计时，不再受僵尸连接拖累。
//
// 宽限期仍然必要：刷新页面也会触发 pagehide，得留时间让新页面连回来。
//
// ⚠️ **两条路用不同的宽限期，别合并**（V4.13.4 拆开）：
//   · **页面主动说要走**（beacon）→ 用下面这个**短**的（1.5 秒）。这条路很确定，
//     唯一要盖住的就是"刷新后新页面连回来"（**实测 0.6 秒**），1.5 秒是 2.5 倍余量，
//     用户感觉就是"关掉控制台后立刻出现"。
//   · **只看到 socket 断开**（页面可能崩了，没来得及打 beacon）→ 用 5 秒的保守值 ——
//     此时完全不知道它是关了还是正在重载，宁可慢一点也别闪。
const CONSOLE_GRACE_MS = 5000;
const CONSOLE_CLOSING_GRACE_MS = 1500;

const consoleClients = new Set();   // 控制台页面的 SSE 连接（悬浮条自己不用 SSE，它轮询 /api/float-state）
let consoleEverOpened = false;      // 本进程内控制台开过没有 —— 没开过就别自动显示（"关掉它"才有意义）
let lastConsoleDropAt = 0;          // 最后一次"最后一条控制台连接断开"的时刻
let consoleAnnouncedClosingAt = 0;  // 页面主动告知"要走了"（beacon）的时刻；非 0 时以它为准
let floatManualWant = null;         // 手动切换：null = 跟随自动判定，true/false = 用户钦定
let lastFloatShowLogged = null;     // 上次记过日志的 show 值（只在翻转时记一行，避免刷屏）

function consoleEffectiveOpen(now) {
  const t = (typeof now === 'number') ? now : Date.now();
  // ① 页面已经宣布要走：**短宽限期**内仍算"在场"（刷新会在 0.6 秒内连回来，实测），
  //    一过就直接判定为已关闭 —— 这里故意不再看 consoleClients：
  //    半死连接会一直挂在集合里，那正是"很久才出来"甚至"永远不出来"的成因。
  if (consoleAnnouncedClosingAt) {
    return (t - consoleAnnouncedClosingAt) < CONSOLE_CLOSING_GRACE_MS;
  }
  // ② 只观察到 socket 断开（页面可能是崩了，没来得及打 beacon）
  if (consoleClients.size > 0) return true;
  if (lastConsoleDropAt && (t - lastConsoleDropAt) < CONSOLE_GRACE_MS) return true;
  return false;
}

// 悬浮窗的应然状态。now 可注入 —— 测试要能"把时间拨到宽限期之后"。
function floatWinState(now) {
  const t = (typeof now === 'number') ? now : Date.now();
  const enabled = config.floatOnConsoleClose !== false;   // 缺省开：这是用户主动要的能力
  const effOpen = consoleEffectiveOpen(t);
  const auto = consoleEverOpened && !effOpen && enabled;
  return {
    enabled,
    consoleOpen: consoleClients.size > 0,
    consoleEffectiveOpen: effOpen,
    everOpened: consoleEverOpened,
    manual: floatManualWant,
    auto,
    // 用户手动点过就以手动为准；没点过则跟随自动判定
    show: (floatManualWant === null) ? auto : floatManualWant,
  };
}

// 悬浮条要的数字：只有它需要的几项，**故意不直接给它 /api/stats** ——
// 那个接口每问一次都要查证书存储（certStoreInfo 会跑 certutil），一两秒轮询一次并不划算。
function floatMetrics() {
  const s = sourceCounts();
  return {
    hit: stats.hit,
    miss: stats.miss,
    stored: stats.stored,
    dynamic: stats.dynamic,
    error: stats.error,
    total: s.total,
    hitRate: s.hitRate,
    originRate: originRatePerSec(),
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  };
}

// ---------------------------------------------------------------- 缓存目录统计

// 扩展健康检查探针的状态（不进入请求日志与统计）
let lastProbeAt = null;
// 最近一次「有请求经过代理」的时间与路径。
// 探针图片是在控制台自己那个窗口里跑的，而该窗口未必经过代理（注册表接管对"已经启动的
// 浏览器"不生效），探针失败说明不了"没在接管"；界面因此还要看这个字段。
let lastProxyRequestAt = 0;
let lastProxyRequestPath = '';
let probeCount = 0;

const cacheInfo = {
  scanAt: null, scanning: false, files: 0, bytes: 0, byExt: {},
  byGroup: {}, groupTruncated: false,
  root: CACHE_ROOT, writable: null, freeBytes: null,
};

// 缓存目录的「构成分组」规则（V4.6.5 新增）
//
// 目的：让控制台能按版本戳看体积。GBF 的资源路径是 /assets/<纯数字戳>/…，
// 戳一变旧目录就永不再被请求 —— 于是只涨不删。要决定"保留几个戳"，得先看得见。
//
// 规则（刻意做得简单可解释）：
//   · 根目录下的 assets/            -> 分组 'assets'
//   · assets/ 下的一级子目录        -> 分组 'assets/<子目录名>'（版本戳目录就是这一层）
//   · 更深的层级继承上一层分组      -> 否则上万个文件会散成上万个分组，没法看
//   · 根目录下的其他条目            -> 各自一组
// 于是 assets/1789531866/img/sp/a.png 落在 'assets/1789531866'，
// 而 assets/img/sp/a.png 落在 'assets/img' —— 与游戏的 URL 结构一一对应。
// 注意 _other/ 是 CACHE_ROOT 的**兄弟目录**（见 cacheRootFor），不在扫描范围内。
const GROUP_ROOT = '(缓存根目录)';
const GROUP_OTHER = '(其他)';
const GROUP_MAX = 200;   // 分组数上限，防止缓存目录被指到异常大的树时内存失控

function groupForChild(parentGroup, name) {
  // 根目录这一层直接取条目名（assets/ 于是自成一组建 'assets'）
  if (parentGroup === GROUP_ROOT) return name;
  // 素材树基目录下的一级子目录带上前缀；版本戳目录（assets/<纯数字>）就在这一层被分开。
  // V4.14.4：基目录是**语言变体**（assets / assets_en / …）—— 原来是 parentGroup === 'assets'
  // 写死一个，结果英语树的所有文件被并成 'assets_en' 一个组，英语戳永远分不出来
  //（界面看不到、按分组清理也切不开）。这条是自测（test-cacheheaders C11）抓出来的。
  if (ASSET_DIR_RE.test(parentGroup)) return parentGroup + '/' + name;
  // 更深的层级继承父分组，避免上万个文件散成上万个分组
  return parentGroup;
}

// 纯数字版本戳分组（形如 'assets/1789531866'，或英语树的 'assets_en/1789531866'）。
// 刻意抽成一个函数：界面的"版本戳"标注与淘汰逻辑共用同一个判据，避免两处写法漂移。
// V4.14.4：语言变体一起认 —— 不认的话磁盘分组不给英文戳贴标签，界面会把**正在用的英文树**
// 当成普通目录（用户按分组清理时可能把在用的树清掉）。
function isStampGroup(group) {
  return /^(?:mbga\/)?assets(?:_[a-z]{2})?\/\d+$/.test(String(group || ''));
}

// URL 路径上的版本戳判据（V4.11.0）：/assets/<纯数字>/…（V4.14.4 起含语言变体 /assets_en/…）。
// 与下面 noteStampFromPath（被动学习用的正则）和 isStampGroup（磁盘分组用的判据）讲的是同一件事
// —— 刻意只保留这一份正则，三处共用，避免"路径判据"和"学习判据"两处写法漂移。
// ⚠️ 语言变体那段用**非捕获组** `(?:…)`：捕获组 1 必须仍然是版本戳号本身（下游按 m[1] 取值）。
const STAMP_PATH_RE = /^\/assets(?:_[a-z]{2})?\/(\d+)(\/|$)/;

// 素材树的语言变体目录名（assets / assets_en / …）。版本戳的"全名"要带上它 ——
// 两棵语言树共用同一个戳号，不区分的话学习/淘汰/预热会互相串味（预热尤其致命：
// 跨语言过户会把日语的旧文件当成英语新戳的内容复用）。只取路径最前面那一段。
function stampVariantOf(restPath) {
  const m = /^\/(assets(?:_[a-z]{2})?)\//.exec(String(restPath || ''));
  return m ? m[1] : 'assets';
}
function stampKeyOf(restPath, stamp) { return stampVariantOf(restPath) + '/' + stamp; }

// ---------------------------------------------------------------- 命中响应的 Cache-Control（V4.11.0，原优化清单 P0-2）
//
// 两条命中路径（handle / handleIntercepted 的 200 命中与 304 快分支）此前一律回 immutable。
// 那对**带版本戳**的路径是对的：戳一变 URL 就变，浏览器缓存自然失效，immutable 放心给。
// 但对**不带版本戳**的路径（assets/img/、assets/sound/ 等内容会原地更新的资源），
// immutable 等于让浏览器把自己那份缓存顶一年 —— 本地做了清理或换新，浏览器层完全看不见，
// 现象就是"点了清理，页面还是旧的"（原优化清单 P0-2 记录的问题）。
//
// 分流规则：带戳 immutable；不带戳压到 1 小时。过期后浏览器会带 If-None-Match 回来做
// 条件验证，由 V4.9.0 的 304 快路径低成本接住（只读 .ext 元数据、不读正文），不会把
// 性能倒贴回去。回源（未命中）路径的 Cache-Control 仍然原样透传源站的头 —— 那是
// 上游的语义，本程序不替它做主。
const CC_STAMPED = 'public, max-age=31536000, immutable';
const CC_UNVERSIONED = 'public, max-age=3600';

function cacheControlForHit(restPath) {
  return STAMP_PATH_RE.test(String(restPath || '')) ? CC_STAMPED : CC_UNVERSIONED;
}

function scanCache() {
  if (cacheInfo.scanning) return;
  cacheInfo.scanning = true;
  broadcast('scan', { scanning: true });

  const byExt = Object.create(null);
  const byExtBytes = Object.create(null);   // 每类占多少字节（按类型清理时给界面看）
  const byGroup = Object.create(null);      // 每个目录/版本戳占多少字节（决定"保留几个戳"时看）
  let groupKeys = 0, groupTruncated = false;
  let files = 0, bytes = 0;
  const started = Date.now();

  // 异步逐目录遍历，避免一次性阻塞事件循环。
  // 栈里带上下文的 group：分组在**目录**上算一次即可，不必对每个文件重算路径，
  // 否则上万个文件要多做上万次 path.relative + split。
  const stack = [{ dir: CACHE_ROOT, group: GROUP_ROOT }];
  (function step() {
    const t0 = Date.now();
    while (stack.length && Date.now() - t0 < 25) {
      const item = stack.pop();
      const dir = item.dir, group = item.group;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          stack.push({ dir: full, group: groupForChild(group, e.name) });
          continue;
        }
        if (e.name.endsWith('.ext')) continue;     // 元数据不算资源
        files++;
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        bytes += st.size;
        const ext = path.extname(e.name).toLowerCase() || '(无扩展名)';
        byExt[ext] = (byExt[ext] || 0) + 1;
        byExtBytes[ext] = (byExtBytes[ext] || 0) + st.size;

        // 分组累计。超出上限的并入 '(其他)'，避免异常目录树把内存撑爆。
        let g = byGroup[group];
        if (!g) {
          if (groupKeys >= GROUP_MAX) {
            groupTruncated = true;
            g = byGroup[GROUP_OTHER];
            if (!g) { g = byGroup[GROUP_OTHER] = { files: 0, bytes: 0, isStamp: false }; groupKeys++; }
          } else {
            g = byGroup[group] = { files: 0, bytes: 0, isStamp: isStampGroup(group) };
            groupKeys++;
          }
        }
        g.files++;
        g.bytes += st.size;
      }
    }
    if (stack.length) return setImmediate(step);

    cacheInfo.scanAt = Date.now();
    cacheInfo.scanning = false;
    cacheInfo.files = files;
    cacheInfo.bytes = bytes;
    cacheInfo.byExt = byExt;
    cacheInfo.byExtBytes = byExtBytes;
    cacheInfo.byGroup = byGroup;
    cacheInfo.groupTruncated = groupTruncated;

    // 扫描完成时顺带做一次可写性检测（扫描本身不频繁，不会造成额外负担）
    const w = testCacheWrite();
    cacheInfo.writable = w.writable;
    cacheInfo.freeBytes = w.freeBytes;
    if (!w.writable && w.errors.length) {
      log(`[警告] 缓存目录不可写：${w.errors.join('；')}`);
    }

    log(`缓存扫描完成: ${files} 个文件, ${(bytes / 1073741824).toFixed(2)} GB, 耗时 ${Date.now() - started}ms`);
    broadcast('scan', { scanning: false, info: cacheInfo });
    broadcastStats();
  })();
}

// ---------------------------------------------------------------- 按类型清理缓存
//
// 用途：缓存里图片/音频这类大文件很占地方，但不是每种资源都同样重要。
// 给一个「按扩展名清掉某一类」的入口（例如清 png、清 jpg），游戏下次需要时会重新回源。
//
// 安全边界（这几条是刻意加的，别图省事去掉）：
//   · 只在 CACHE_ROOT 之内动文件；每个路径解析后必须仍在根目录下（防目录穿越）
//   · 只删文件、不删目录（空目录留着，避免误删别的东西）
//   · 扩展名来自请求参数，按白名单清洗（只允许 1~10 位的字母数字），拒绝空值与通配
//   · 连带删掉同名 .ext 元数据，否则会留下一堆孤儿元数据
//   · 支持 dryRun 预览：界面先告诉用户"将删除多少个、多少字节"，确认后才真删
//   · 不碰 .ext 类型本身（避免只删元数据、把资源留成孤儿）
function cleanCacheByExt(rawExts, dryRun) {
  const exts = [];
  for (const raw of String(rawExts || '').split(',')) {
    let e = raw.trim().toLowerCase();
    if (!e) continue;
    if (e.charAt(0) !== '.') e = '.' + e;
    if (!/^\.[a-z0-9]{1,10}$/.test(e)) continue;   // 白名单式清洗
    if (e === '.ext') continue;                    // 元数据不单独清
    if (exts.indexOf(e) === -1) exts.push(e);
  }

  const out = { ok: false, dryRun: !!dryRun, exts, deleted: 0, bytes: 0, byExt: {}, errors: [] };
  if (!exts.length) { out.error = '没有可用的扩展名（例：png 或 .png,.jpg）'; return out; }

  let root;
  try { root = path.resolve(CACHE_ROOT); } catch (e) { out.error = '缓存目录无法解析：' + e.message; return out; }
  if (!fs.existsSync(root)) { out.error = '缓存目录不存在：' + CACHE_ROOT; return out; }

  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (full.indexOf(root + path.sep) !== 0) { out.errors.push('跳过越界路径: ' + full); continue; }
      if (e.name.toLowerCase().slice(-4) === '.ext') continue;   // 元数据跟随主文件处理
      if (exts.indexOf(path.extname(e.name).toLowerCase()) === -1) continue;

      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* 取不到大小也要删 */ }
      if (!dryRun) {
        try {
          fs.unlinkSync(full);
        } catch (err) {
          out.errors.push(e.name + ': ' + err.message);
          continue;
        }
        try { fs.unlinkSync(full + '.ext'); } catch { /* 没有元数据就算了 */ }
      }
      out.deleted++;
      out.bytes += size;
      const ext = path.extname(e.name).toLowerCase();
      out.byExt[ext] = (out.byExt[ext] || 0) + 1;
    }
  }
  out.ok = true;
  if (!dryRun && out.deleted > 0) scanCache();   // 删完刷新统计，界面上的数字立刻对上
  return out;
}

// ---------------------------------------------------------------- 版本戳目录淘汰（V4.7.0）
//
// 背景：GBF 的资源路径是 /assets/<纯数字戳>/…，游戏更新资源版本就换一个新戳，
// 旧戳的 URL **再也不会被请求**，但文件一直躺在磁盘上 —— 缓存因此只涨不删
// （原版 ACG Power 的缓存就是这么涨到 6.5 GB / 134,405 个文件的）。
//
// 版本判据优先用**观测到的 X-VERSION**（游戏给请求带的"客户端资源版本"；本机实测
// 与 /assets/ 下的戳目录名完全一致，见 交接-已完成记录.md 的 T02 节）。没有观测值时
// 退化为"按戳的数值大小取最新" —— 戳是单调递增的数字，所以两者通常一致。
//
// 【为什么不做成自动清理】删文件不可逆，而且用户完全看不见就会发生。本程序的既有风格是
// "先给预览、由用户点确认"（见「按类型清理缓存」）。所以这里只提供预览与显式执行两个入口，
// **不在任何请求路径上自动删** —— test-evict.js 的 C 段会钉住"没有别的调用点"这条。
const STAMP_KEEP = 2;   // 保留最新的 N 个戳。保底规则，不是唯一规则 —— 见下面的"在用戳"。
// 为什么不是 1 个：游戏的 server-props 里 jsUri / cssUri / imgUri 可能指向**不同的戳**，
// 只留最新一个会把仍在被引用的那个删掉（删了不致命，但要重新回源）。

// ---- 被动学习"哪些戳还在被用"（V4.7.3）----
//
// 【为什么要有这个】原设计拿 `X-VERSION` 请求头当"当前戳"。实机验证（2026-09-18）发现：
// 该头在**当前 PAC 部署下根本到不了代理** —— 我们自己的 PAC 把游戏本域的 `/rest/` 路由成
// DIRECT（刻意的，接口过代理会触发「新しいバージョンがあります」重载循环），而历史上唯一
// 见过该头的地方就是 `/rest/`。于是"当前戳必留"这层保护**从未触发**，
// 判据退化成"按数值取最新 N 个" —— 若某个 `*Uri` 指向较旧的戳就会被误淘汰。
//
// 改成从**必然流经代理的东西**学：每个 `/assets/<纯数字>/…` 请求本身就在告诉我们
// "这个戳还在被用"。零额外请求，也不依赖任何我们控制不了的信号。
// （`X-VERSION` 仍作为一路输入保留 —— 换成扩展模式或直连代理时全部流量都过代理，
//   那时它是有效的；两条判据各自覆盖一种部署模式，不冲突。）
const STAMP_USE_WINDOW_MS = 24 * 3600 * 1000;   // 超过这个时长没被请求，就不再算"在用"
const stampLastSeen = new Map();                // 戳 -> 最后一次被请求的时刻

// 只在**确实当作资源处理**的请求上调用（见 handle / handleIntercepted 的资源分支）。
function noteStampFromPath(restPath) {
  const m = STAMP_PATH_RE.exec(String(restPath || ''));
  if (!m) return;
  // 记的是"全名"（资产树/戳号）—— 两棵语言树共用同一个戳号，必须分开记（见 stampVariantOf）
  stampLastSeen.set(stampKeyOf(restPath, m[1]), Date.now());
  // V4.10.0：观测到版本戳切换时，后台把上一任戳"过户"过来（条件请求确认后免下载），
  // 让更新日的重下量从「全部文件」降到「真正变了的文件」。触发本身极轻（Set 查询），
  // 重复触发由预热器自己的 doneFor 集合挡掉，详见预热器一节。
  maybePrewarmStamps(stampVariantOf(restPath), m[1]);
}

// 纯函数：挑出窗口内仍被请求过的戳。
// 抽出来是为了能喂合成时间戳把边界（刚好超窗 / 刚好在窗内）都测到。
function stampsSeenWithin(seen, now, windowMs) {
  const out = [];
  seen.forEach((t, name) => { if (now - t <= windowMs) out.push(name); });
  return out.sort();
}

// "应当保留"的戳集合 = 最近仍被请求的 ∪ 观测到的当前版本（后者在 PAC 模式下通常为空）
function inUseStamps(now) {
  const s = new Set(stampsSeenWithin(stampLastSeen, now || Date.now(), STAMP_USE_WINDOW_MS));
  if (xVersionObs.last) s.add(String(xVersionObs.last));
  return s;
}

// 纯函数：给定戳名列表、"在用戳"集合与保底个数，算出保留哪些、淘汰哪些。
// 抽出来是为了能直接喂合成数据把边界都测到（真实目录树不好造那么多花样）。
function planStampKeep(names, inUse, keepN) {
  // 数值大的在前。名字可能是"全名"（assets_en/1789531866，V4.14.4 起）——
  // 只比最后那段数字，否则 Number('assets_en/…') 是 NaN，排序会变成随机。
  const numOf = (s) => Number(String(s).split('/').pop());
  const sorted = names.slice().sort((a, b) => numOf(b) - numOf(a));
  const keep = new Set(sorted.slice(0, Math.max(1, keepN)));
  // 在用的戳一律保留 —— 即使它不在最新的 N 个里（版本回退、或某个 *Uri 指向旧戳）。
  for (const n of (inUse || [])) keep.add(String(n));
  return { keep: Array.from(keep), evict: names.filter((n) => !keep.has(n)) };
}

// 从已扫好的 cacheInfo.byGroup 直接推导戳状态：**零额外开销**，
// 所以可以安全地放进被控制台定期轮询的 /api/stats 里。
// 注意统计口径：byGroup 只算资源文件、不含 .ext 元数据，所以这里的体积比实际回收的略小。
function stampStatusFromCacheInfo() {
  const g = cacheInfo.byGroup || {};
  const stamps = Object.keys(g)
    .filter((k) => isStampGroup(k))          // V4.14.4：语言变体（assets_en/…）一起认
    .map((k) => ({ name: k, files: g[k].files || 0, bytes: g[k].bytes || 0 }))
    .sort((a, b) => Number(String(b.name).split('/').pop()) - Number(String(a.name).split('/').pop()));
  const now = Date.now();
  const inUseSet = inUseStamps(now);
  const names = stamps.map((s) => s.name);
  // 只用"确实存在于磁盘上的戳"来展示"在用"（观测到但没落盘的戳对用户没意义）
  const inUse = names.filter((n) => inUseSet.has(n));
  const plan = planStampKeep(names, inUseSet, STAMP_KEEP);
  const evictSet = new Set(plan.evict);
  const ev = stamps.filter((s) => evictSet.has(s.name));
  return {
    total: stamps.length,
    // current 保留旧名字：仅在 X-VERSION 真被观测到时才有值（PAC 模式下通常为空），
    // 界面与文档现在应以 inUse 为准 —— 那才是"最近仍在被请求"的戳。
    current: (xVersionObs.last && names.indexOf(String(xVersionObs.last)) >= 0) ? String(xVersionObs.last) : null,
    inUse,
    keep: plan.keep,
    evictable: ev.length,
    evictNames: ev.map((s) => s.name),
    files: ev.reduce((a, s) => a + s.files, 0),
    bytes: ev.reduce((a, s) => a + s.bytes, 0),
  };
}

// 实地清点磁盘上的戳目录（只在用户显式执行淘汰时调用 —— 它会走一遍目录树）。
// V4.14.4：语言树的基目录（assets / assets_en / …）**逐个都扫** —— 原来写死一个 assets，
// 结果英语树的戳目录完全不在覆盖范围内（淘汰看不见它、只涨不删）。
// 返回项：name = 全名（assets_en/1789531866，与 /api/stats 里的一致）、dir = 绝对路径。
function listStampDirs() {
  const out = [];
  let bases = [];
  try {
    bases = fs.readdirSync(CACHE_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && ASSET_DIR_RE.test(e.name))
      .map((e) => e.name);
  } catch { return out; }
  for (const variant of bases) {
    const base = path.join(CACHE_ROOT, variant);
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!/^\d+$/.test(e.name)) continue;        // 只认纯数字戳：assets/img 这类目录绝不碰
      const full = path.join(base, e.name);
      if (!isInsideRoot(CACHE_ROOT, full)) continue;   // 双保险：绝不越过缓存根
      let files = 0, bytes = 0;
      const stack = [full];
      while (stack.length) {
        const d = stack.pop();
        let es;
        try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const x of es) {
          const f = path.join(d, x.name);
          if (x.isDirectory()) { stack.push(f); continue; }
          files++;                                  // .ext 元数据也算 —— 它确实会被一起删掉
          try { bytes += fs.statSync(f).size; } catch { /* 取不到大小也要删 */ }
        }
      }
      out.push({ name: variant + '/' + e.name, dir: full, files, bytes });
    }
  }
  out.sort((a, b) => Number(String(b.name).split('/').pop()) - Number(String(a.name).split('/').pop()));
  return out;
}

// ---------------------------------------------------------------- 版本切换预热（V4.10.0）
//
// 解决的问题：版本变动（戳更新）后，游戏的资源 URL 全部指向新戳 /assets/<新戳>/...，
// 本地按路径做键必然 miss —— 更新日那 ~500 个 JS/JSON 要逐个重下。而实测数据
//（tools\cross-stamp-analysis.js，2026-09-19）：**相邻两次版本变动之间，同名文件的
// 内容一致率 99.9%**（839/840）——绝大部分重下是浪费。
//
// 做法：观测到当前戳切换后，后台对上一任戳的每个同名文件向源站发**条件请求**
//（If-None-Match，带旧文件记录的 ETag），按响应确认内容是否一致：
//   · 一致 → 把旧文件过户到新戳路径（免下载）。确认有两种来源：
//       - 304：源站权威确认「新地址的内容与你手里的这份一致」。这是 HTTP 标准语义，
//         但对 GBF 源站**结构性到不了**（见 etagMd5 一节：源站 ETag 前缀是部署代次号，
//         跨戳必然不同，If-None-Match 永远匹配不上）。分支保留，等源站哪天改回内容
//         ETag 时自动生效。
//       - md5 比对（V4.15.9，实际生效路径）：200 响应头里源站自报的 ETag，其 md5 后缀
//         与旧文件一致 = 源站自己背书「这份内容就是那个内容」。头部一到就比对并掐断
//         正文下载，正文不落网；过户与 304 同路。
//   · 200 且 md5 不同 = 真的变了 → 落库新内容，等于把那次下载提前做掉（浏览器稍后
//     到达即命中）；migrate-only 开启时不落库，且正文在头部阶段就被掐断（旧实现是
//     下完再扔 —— 2026-10-06 实测 3998 个全量正文全部白下，与游戏首载抢隧道）。
//   · 其余一律跳过：旧文件没有 ETag（V4.9.0 前写入的存量，会随时间自然覆盖）、
//     新地址已有缓存、404 等 —— 浏览器按需回源天然兜底，预热失败没有任何行为损失。
//
// 落库统一走 writeCacheEntry（内容体检 + 原子写 + ETag/CORS 元数据全套复用）。
// 竞态无忧：预热与并发回源若同写一路径，原子写保证不损坏；且 304 确认过内容一致、
// 200 拿到的就是新内容，两边字节必然相同。
//
// 统计：stats.prewarm（attempts/reused/refreshed/skipped/failed/runs），随 /health 与
// /api/stats 自动带出；单次预热结束在服务日志里有一条汇总。
const PREWARM_CONCURRENCY = 8;      // 条件请求极轻（响应头级别），8 个并发足够快又不显眼
const PREWARM_MAX_FILES = 5000;     // 防御上限：**积极性**单次预热最多核对多少个文件

// 闲置缓扫（V4.20.0；V4.20.7 起默认阈值 5 分钟 → 1 分钟）：平衡档（跟随开、全库预热关）
// 专属的第二条预热路径。语义：完全不游玩（"游玩"的口径 = 有游戏流量经过代理，见
// lastProxyRequestAt 的写入点）满 IDLE_SWEEP_MS 后自动开扫/续扫；恒 2 并发 + 每文件随机间隔
// （避免匀速的机器味）；**一律只过户**（正文不要，连"真变重下"也留到游玩时按需取）；
// 有游戏流量或关键路径（按需确认/回退下载）在途时整条让路（见 backgroundShouldYield），
// 剩余进度存进 resume，下个闲置窗口接着扫 —— 不重来、不丢进度。
// 与积极性档全库预热的差别只有三处：触发要闲置、并发更低且有抖动、只过户。
const IDLE_SWEEP_MS = Math.max(1000, parseInt(process.env.GBFCACHE_IDLE_SWEEP_MS || '60000', 10) || 60000);
const IDLE_SWEEP_CONCURRENCY = 2;
const IDLE_SWEEP_STOP_MS = 2000;    // 有游戏流量（<2 秒）立即暂停 —— 与许可闸的"活跃"口径相同
const IDLE_SWEEP_JITTER_MIN = 120;  // 每文件随机间隔区间（毫秒）
const IDLE_SWEEP_JITTER_MAX = (function () {
  const v = process.env.GBFCACHE_IDLE_SWEEP_JITTER_MS;             // 测试可置 0 关掉抖动
  if (v === undefined) return 800;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 800;
})();
const IDLE_SWEEP_CHECK_MS = Math.max(500, parseInt(process.env.GBFCACHE_IDLE_SWEEP_CHECK_MS || '5000', 10) || 5000);

// 关键路径在途计数（V4.20.7）：按需确认（on-miss）与未命中回退下载 —— 后台让路判定的第二根支柱。
// 只按"流量"会让路漏掉一段：确认说内容变了、或超时回退之后，**下载还在跑、浏览器已不再发新请求**，
// 那几秒里后台若恢复，就会与这个下载抢 8 槽隧道连接池（ChainAgent 与游戏共用）。
let criticalUpstreamInFlight = 0;

// 后台让路判定（V4.20.7）：跟随与闲置缓扫共用。两条任一成立就整条暂停（不是降并发）：
//   ① 有游戏流量（IDLE_SWEEP_STOP_MS 内）—— 保护加载间隙；这个 2 秒窗口本身就是恢复前的尾窗；
//   ② 有按需确认/回退下载在途 —— 大文件下载期间也不放后台进来。
// 两者都消失即自动续（跟随泵自带重试；缓扫由下个闲置窗口续）。
function backgroundShouldYield() {
  if (Date.now() - lastProxyRequestAt < IDLE_SWEEP_STOP_MS) return true;
  return criticalUpstreamInFlight > 0;
}

// P0-5（V4.16.0）③：许可闸 —— 活跃期限 2 个在途、空闲期全速 8 个。
// 旧版在游戏活跃时"整批真停"（2026-10-14 事故复盘：那让预热在更新日首载 —— 最需要它的
// 时段 —— 完全停工）。改成只降并发不停止：每个在途只是几百字节的头部级确认，不会跟游戏
// 抢隧道。工厂式（零外部依赖），test-migrate-budget.js 直接切出去单测并发上限。
const PREWARM_ACTIVE_CONCURRENCY = 2;
function createGate(limitFn) {
  let inFlight = 0;
  const waiters = [];
  const pump = () => {
    while (waiters.length && inFlight < Math.max(1, limitFn())) {
      inFlight++;
      waiters.shift()();
    }
  };
  return {
    acquire: () => new Promise((resolve) => { waiters.push(resolve); pump(); }),
    release: () => { inFlight--; pump(); },
    _state: () => ({ inFlight, waiting: waiters.length }),   // 测试用
  };
}
// 当前在跑的是哪条预热路（V4.20.0）：'full' = 积极性全库（按活跃度 2/8）；
// 'idle' = 平衡档闲置缓扫（恒 2 并发 —— 它本身就是"有活动就暂停"，不必再调）。
// 单值即可：running 闸保证同一时刻只有一条预热在跑。
let prewarmPolicy = 'full';
const prewarmGate = createGate(() => (prewarmPolicy === 'idle'
  ? IDLE_SWEEP_CONCURRENCY
  : (Date.now() - lastProxyRequestAt < 2000 ? PREWARM_ACTIVE_CONCURRENCY : PREWARM_CONCURRENCY)));

// 闲置判定（V4.20.0）：两条主动预热路径共用的一份口径。
// **时钟为 0（进程启动后还没有任何游戏流量）不算闲置** —— 这不是"玩完走了"，而是"还没开始"：
// 此刻连"当前戳"都还不知道（stampLastSeen 空），而 noteStampFromPath 在分流块**之前**执行，
// 第一个请求经过它时时钟仍是 0 —— 若无此条，平衡档下开机的第一个请求就会把全库扫推起来。
// 之后的判定 = 距最后一次游戏流量满 IDLE_SWEEP_MS。
function idleSweepEligible() {
  return lastProxyRequestAt > 0 && Date.now() - lastProxyRequestAt >= IDLE_SWEEP_MS;
}

const prewarmState = {
  // 同一新戳只预热一次。进程重启后集合清空会再跑一次 —— 幂等（新地址已有缓存的
  // 全部跳过），代价只是重发一批 304 请求，可接受。
  // 积极性：观测到切换时即记（现状不变）。闲置缓扫：**跑完才记** —— 被游玩打断后
  // 要能再触发续扫，见 runPrewarm 末尾。
  doneFor: new Set(),
  running: false,
  // 闲置缓扫的续扫进度（V4.20.0）：被游戏流量打断时留下 {variant, oldStamp, newStamp,
  // rels 剩余, stack 待走目录, cnt 累计计数, total 总数}，下个闲置窗口原样接着扫。
  resume: null,
  stats: {
    attempts: 0, reused: 0, refreshed: 0, skipped: 0, failed: 0, runs: 0,
    lastAt: null, lastFrom: null, lastTo: null,
  },
};
// 挂进 stats：/api/stats 与 /health 都整体序列化 stats，预热仪表随之自动带出
stats.prewarm = prewarmState.stats;

// 预热实况（V4.14.11）：更新日通知与进度条的单一数据源。
// key = "旧戳全名->新戳全名"；一轮结束后 running=false 但对象保留 ——
// 托盘要靠"从真翻假"弹完成气泡，控制台要显示最终汇总。下一轮开始时整个换新。
let prewarmLive = null;

// 触发入口：noteStampFromPath 学习到戳号时调用。必须同步、极快地返回 ——
// 它在请求热路径上。真正的工作全部在 runPrewarm 的异步任务里。
function maybePrewarmStamps(variant, newStamp) {
  // 两条主动预热路径（V4.20.0 起两档分工）：
  //   · 积极档（prewarmEnabled=true）：观测到版本切换就跑全库核对（许可闸按活跃度 2/8 并发）
  //     —— 与 V4.16.0 以来的行为完全一致；
  //   · 平衡档（跟随开、全库预热关）：**完全不游玩**满 IDLE_SWEEP_MS 后才跑"闲置缓扫"
  //     （恒 2 并发 + 抖动 + 只过户；有游戏流量立即暂停、留到下次闲置续扫）。
  // 安静档（跟随也关）：两条都不跑，纯按需。
  const aggressive = config.prewarmEnabled === true;
  const idleMode = !aggressive && followEnabled();
  if (!aggressive && !idleMode) return;
  if (idleMode && !idleSweepEligible()) return;              // 平衡档：只在"完全不游玩"满阈值后才扫
  const key = variant + '/' + newStamp;                      // 全名：两棵语言树共用戳号，必须分开
  if (!/^\d+$/.test(newStamp) || prewarmState.doneFor.has(key)) return;
  // 已有一轮在跑就不叠第二轮（V4.14.11）：两轮并发会把 prewarmLive 实况互相覆盖，
  // 界面上的进度会跳来跳去。这轮跳过后 doneFor 不会记 —— 它跑完后下一个带新戳的请求会再触发。
  if (prewarmState.running) return;
  // 上一任 = **同一棵语言树里**最近仍被请求过的其他戳。
  // （跨语言过户是错的：两棵树的同名文件内容不同，把日语的旧文件"复用"成英语新戳就是错内容。）
  let prev = null, prevT = 0;
  stampLastSeen.forEach((t, name) => {
    const p = String(name).split('/');
    if (p.length < 2 || p[0] !== variant) return;            // 只看同一棵树
    const num = p[p.length - 1];
    if (num !== newStamp && t > prevT) { prev = num; prevT = t; }
  });
  // 兜底（V4.10.1）：进程刚启动时内存里没有任何学习记录 —— 而更新日的真实场景
  // 恰恰是「维护后重启，第一次进游戏就直接是新戳」。此时改用**同一棵树的**磁盘目录里、
  // 数值比新戳小的最大那个当上一任。清理功能保留最新 2 个戳（STAMP_KEEP=2），
  // 上一任必在其中；这里只列目录名，不走 listStampDirs 的全量体积清点。
  if (!prev) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(CACHE_ROOT, variant), { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name) && e.name !== newStamp)
        .map((e) => e.name);
    } catch { /* 该语言树的目录不在 —— 没有可过户的原料，跳过 */ }
    if (names.length) prev = names.sort((a, b) => Number(b) - Number(a))[0];
  }
  if (!prev) return;
  // 积极性：触发即记（现状不变）。平衡档：不在此记 —— 闲置缓扫跑完才记，被游玩打断后
  // 要能再触发续扫（见 runPrewarm）。
  if (aggressive) prewarmState.doneFor.add(key);
  prewarmState.running = true;
  const isResume = idleMode && prewarmState.resume
    && prewarmState.resume.variant === variant && prewarmState.resume.newStamp === newStamp;
  log(idleMode
    ? (isResume
      ? `[闲置缓扫] 继续慢扫 ${variant}/${prev} -> ${newStamp}（剩 ${prewarmState.resume.rels.length} 个）`
      : `[闲置缓扫] 已闲置 ${Math.max(1, Math.round(IDLE_SWEEP_MS / 60000))} 分钟以上，开始慢扫 ${variant}/${prev} -> ${newStamp}（2 并发 + 抖动，只过户；游玩或过户在途即让路）`)
    : `[预热] 检测到版本切换 ${variant}/${prev} -> ${newStamp}，后台核对旧文件中…`);
  runPrewarm(variant, prev, newStamp, idleMode)
    .catch((e) => log(`[预热] 异常结束（浏览器按需回源兜底，不影响服务）: ${e.message}`))
    .finally(() => { prewarmState.running = false; });
}

// 闲置缓扫的定时触发（V4.20.0）：平衡档下，"完全不游玩"满 IDLE_SWEEP_MS 后自动开扫/续扫。
// 为什么必须有时钟：观测触发（noteStampFromPath → maybePrewarmStamps）只在**有请求**时发生 ——
// 而"闲置"的定义正是没有请求了，得有个定时器把扫推起来。
// 候选 = 每棵语言树里"最近仍被请求过"的那个戳；前置检查（档位/闲置/去重/在跑）全走
// maybePrewarmStamps 那一份，不复制。开销：几次时间比较 + 扫一遍 stampLastSeen。
setInterval(() => {
  if (config.prewarmEnabled === true) return;      // 积极档走观测触发（保持不变）
  if (!followEnabled()) return;                    // 安静档不扫
  if (prewarmState.running) return;
  if (!idleSweepEligible()) return;
  const latest = new Map();                        // variant -> { stamp, t }
  stampLastSeen.forEach((t, k) => {
    const p = String(k).split('/');
    if (p.length < 2) return;
    const cur = latest.get(p[0]);
    if (!cur || t > cur.t) latest.set(p[0], { stamp: p[p.length - 1], t });
  });
  latest.forEach((v, variant) => {
    if (!/^\d+$/.test(v.stamp)) return;
    if (prewarmState.doneFor.has(variant + '/' + v.stamp)) return;
    maybePrewarmStamps(variant, v.stamp);
  });
}, IDLE_SWEEP_CHECK_MS);

// 304 过户时写给新缓存元数据的验证器：304 响应自带的优先（它是对新地址的权威回答），
// 缺了就用旧文件的兜底 —— 两者在 304 语义下应当一致。注意返回键用小写，
// 与 writeCacheEntry 读 up.headers 的取法对齐。
function mergePrewarmHeaders(oldMeta, upHeaders) {
  return {
    etag: (upHeaders && upHeaders.etag) || (oldMeta && oldMeta.ETag) || null,
    'last-modified': (upHeaders && upHeaders['last-modified']) || (oldMeta && oldMeta.LastModified) || null,
  };
}

// ETag 的内容指纹（V4.15.9）：GBF 源站的 ETag 形如 "1791266894-f8e52b43…"。
// 前缀是**部署代次号**（源站重新部署就换，与内容无关），'-' 后的 md5 才随内容走。
// 实测（2026-10-07，本机缓存新旧两戳都有的 474 个同名文件）：md5 后缀全部相同、
// 前缀全部不同。两个推论：
//   · 带旧 ETag 的 If-None-Match 打到新 URL 永远等不来 304（前缀必然不同）——
//     V4.10.0 设想的「304 过户」在这家源站结构性不成立（2026-10-06 那轮预热
//     3998 个条件请求 0 个 304 就是它）；
//   · 跨戳比对内容只能比 md5 后缀：源站对新 URL 自报的 md5 与旧文件一致，即源站
//     自己背书内容一致（等价 304 的确认语义，红线「绝不返回版本不匹配的文件」不破）。
// 信息不足（ETag 缺 '-' 后的指纹段等）一律返回 null，调用方走保守分支，绝不瞎比。
function etagMd5(etag) {
  const s = String(etag || '').replace(/"/g, '').trim();
  const i = s.lastIndexOf('-');
  return i >= 0 && s.length - i - 1 >= 8 ? s.slice(i + 1).toLowerCase() : null;
}

// 正文剥离判定（V4.15.9）：传给 requestUpstream，让「这具正文不需要」在**头部阶段**
// 就生效，而不是下完再扔。两种情形都只依赖响应头里看得到的东西，不引入新的源站行为假设：
//   · migrate-only：200 的正文一律不要 —— 设置的本意就是「不预下载」，旧实现却整包
//     下完才丢弃（2026-10-06：3998 个全量正文白白挤占与游戏共用的隧道 5 分钟）；
//   · 未开 migrate-only 也一样：源站自报 ETag 的 md5 与旧文件一致 = 内容没变，
//     直接过户即可，整包正文同样不必下载。
function prewarmDropBody(migrateOnly, oldMd5) {
  return (status, headers) => status === 200
    && (migrateOnly || (!!oldMd5 && etagMd5(headers && headers.etag) === oldMd5));
}

// 预热取源：按候选主机依次尝试，拿到明确回答（含 304/404）即返回。
// 404 直接认 —— 新戳目录文件集与旧戳本就不完全相同（实测 528 vs 535），跳过即可。
// GBFCACHE_ORIGIN_BASE 测试钩子与 fetchFromAnyOrigin 同款：设置后整体替换回源地址。
// md5Only（V4.15.10，按需过户专用）：正文剥离只认「指纹一致」这一条，**不受 migrate-only
// 开关影响** —— 请求路径讨正文是为了当次响应，指纹不一致时必须把它留下；
// 若按后台预下载的口径（migrate-only 一律丢正文）处理，就会「丢掉再重取」，白跑一趟。
async function prewarmFetch(rest, extraHeaders, oldMd5, md5Only, idleMode) {
  // 正文剥离判定（V4.20.0：idleMode 显式传参）。**不读模块态** —— 那会让"扫描进行中"被
  // 并发的其它调用读到，把不该丢正文的请求也当成只过户。闲置缓扫一律"只过户"；其余按老口径：
  // 按需过户（md5Only）保留正文，后台预下载看 migrate-only 开关。
  const dropBody = prewarmDropBody(
    idleMode === true ? true : (md5Only ? false : config.prewarmMigrateOnly === true), oldMd5);
  for (const h of PREWARM_HOSTS) {
    const base = process.env.GBFCACHE_ORIGIN_BASE || ('https://' + h);
    try {
      const up = await fetchUpstream(`${base}${rest}`, extraHeaders, true, { dropBody });
      if (up) return up;
    } catch { /* 该主机瞬时失败，换下一个候选 */ }
  }
  return null;
}

// 硬链接过户时只补写新路径的 .ext 元数据（正文与旧文件共享同一份数据，fs.link 零拷贝）。
// 字段形状与 writeCacheEntry 对齐：ETag / Last-Modified 用 mergePrewarmHeaders 的结果，
// ct 由调用方解析好传入（旧 .ext 缺 ct 时调用方已经按扩展名兜过底了）。
async function writePrewarmExt(filePath, oldMeta, eff, ct) {
  const meta = {
    LastModified: eff['last-modified'], ETag: eff.etag,
    at: Math.floor(Date.now() / 1000), ce: '', ct: ct || '', v: 1,
  };
  if (oldMeta.cors && oldMeta.cors['access-control-allow-origin']) meta.cors = oldMeta.cors;
  await writeFileAtomically(filePath + '.ext', Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
}

// 核对单个文件：新地址没缓存、旧文件有 ETag 时发条件请求，按「内容一致 → 过户 /
// 内容变了 → 预下载」分流。内容一致的凭据：304，或源站自报 ETag 的 md5 与旧文件
// 一致（实际路径，见 etagMd5）。cnt 是本次预热的局部计数器（结束时并入 stats.prewarm）。
//
// V4.15.1 性能改造（用户实测：版本戳涨到 4000+ 文件后预热越来越慢，且预热期间游戏读资源卡顿）：
//   ① 全程异步 —— 旧实现 stat / .ext 读 / 正文读与解压全是同步调用，单个就是几十毫秒的
//      事件循环占用，几千个文件下来游戏请求被卡得七零八落。全部换成现成的异步版。
//   ② 304 过户优先走**硬链接**（同卷 fs.link，零拷贝）—— 旧实现把旧文件整个读出再整个
//      写进新戳，等于每个文件两遍全量盘 IO；硬链接后新旧两路共享同一份数据，链接计数保证
//      日后清理旧戳时新戳不受影响。失败（跨卷等意外）再回退 writeCacheEntry 全套。
//   ③ 搬运让路 —— 见下面"游戏活跃时整批暂停"。
// V4.15.9（用户实测：预热仍让游戏卡顿）：200 正文头部一到就比对并掐断（不再下完再扔）；
//   让路从"每文件歇 400ms"改成"游戏活跃时整批暂停"。
async function prewarmOne(variant, oldStamp, newStamp, rel, cnt, idleMode) {
  const newRest = `/${variant}/${newStamp}/${rel}`;
  const newPath = cachePathFor(CACHE_ROOT, newRest);
  if (!newPath) { cnt.skipped++; return; }
  let stNew = null;
  try { stNew = await fsp.stat(newPath); } catch { /* 还没缓存，继续核对 */ }
  if (stNew && stNew.isFile()) { cnt.skipped++; return; }

  const oldPath = path.join(CACHE_ROOT, variant, oldStamp, path.normalize(rel));
  if (!isInsideRoot(CACHE_ROOT, oldPath)) { cnt.skipped++; return; }
  const meta = await readExtMetaAsync(oldPath);
  if (!meta || !meta.ETag) { cnt.skipped++; return; }   // 没有验证器就没法问源站 —— 宁可回源

  // 搬运让路（③，V4.15.9 改成真停；**P0-5/V4.16.0 改为许可闸**）：游戏活跃（2 秒内有流量
  // 经过代理）时最多放行 PREWARM_ACTIVE_CONCURRENCY 个在途请求，空闲期恢复全速。旧版"整批
  // 真停"的教训：2026-10-14 事故复盘确认，那样预热在更新日首载期间完全停工 —— 而那是它最
  // 该干活的时候。纯跳过的文件（已缓存 / 无 ETag）到不了这里，重启后的重跑几乎全是跳过。
  // （V4.20.0：闲置缓扫走同一条闸门，策略在闸门里 —— 它在跑时恒 2 并发；"有游戏流量就整条
  //   暂停"由 runPrewarm 的取件前检查负责，比闸门更硬一档。）
  await prewarmGate.acquire();
  cnt.attempts++;
  let up = null;
  try {
    up = await prewarmFetch(newRest, { 'if-none-match': meta.ETag }, etagMd5(meta.ETag), false, idleMode);
  } finally {
    prewarmGate.release();
  }
  if (!up) { cnt.failed++; return; }

  // 内容一致的凭据（见 etagMd5）：304；或 200 但正文已按判定掐断、且源站自报 ETag
  // 的 md5 与旧文件一致 —— 两者的过户路径完全相同（硬链接优先，回退时正文用旧文件，
  // 内容都经源站确认）。过户文件的 .ext 用 mergePrewarmHeaders 的结果：200 场景下
  // 会记下源站的新代次 ETag，下一轮预热就能接着比对。
  const md5Match = up.status === 200 && up.bodyDropped === true
    && etagMd5(up.headers && up.headers.etag) !== null
    && etagMd5(up.headers && up.headers.etag) === etagMd5(meta.ETag);
  if (up.status === 304 || md5Match) {
    const eff = mergePrewarmHeaders(meta, up.headers);
    let linked = false;
    // 新戳目录树的第一批文件：父目录还不存在，fs.link 会直接 ENOENT ——
    // 先补目录（幂等），让零拷贝快路径对每个文件都成立，而不是每目录第一个
    // 文件都落到全量读写的回退里。
    try { await fsp.mkdir(path.dirname(newPath), { recursive: true }); } catch { /* 已存在等，链接自会再证 */ }
    try { await fsp.link(oldPath, newPath); linked = true; } catch { /* 走回退 */ }
    if (linked) { await writePrewarmExt(newPath, meta, eff, meta.ct || mimeFor(oldPath, meta)); cnt.reused++; return; }
    const { body } = await readCacheEntryAsync(oldPath);
    await writeCacheEntry(newPath, body, meta.ct || mimeFor(oldPath, meta), meta.cors || null, null, eff);
    if (fs.existsSync(newPath)) cnt.reused++; else cnt.skipped++;   // 体检拒收时不计复用
  } else if (up.status === 200 && up.body.length > 0) {
    // 内容真变了（md5 不同）且整包正文拿到了 —— 只会发生在未开 migrate-only 时
    //（开启时正文在头部阶段就被 prewarmDropBody 掐断，走不到这里）：新内容提前落库。
    const ct = up.headers['content-type'] || mimeFor(oldPath, meta);
    await writeCacheEntry(newPath, up.body, ct, corsHeaders(up.headers, null), null, up.headers);
    if (fs.existsSync(newPath)) cnt.refreshed++; else cnt.skipped++;
  } else {
    cnt.skipped++;   // 404 / 空响应 / migrate-only 且指纹不一致：新地址本来就没有或暂不落库，交给按需回源
  }
}

async function runPrewarm(variant, oldStamp, newStamp, idleMode) {
  // variant = 语言树的基目录名（assets / assets_en）。过户只在**同一棵树内**做。
  // idleMode（V4.20.0）= 平衡档的闲置缓扫：恒 2 并发 + 抖动、只过户、可暂停可续扫。
  const oldDir = path.join(CACHE_ROOT, variant, oldStamp);
  if (!isInsideRoot(CACHE_ROOT, oldDir) || !fs.existsSync(oldDir)) return;
  prewarmState.stats.runs++;
  prewarmState.stats.lastAt = Date.now();
  prewarmState.stats.lastFrom = variant + '/' + oldStamp;
  prewarmState.stats.lastTo = variant + '/' + newStamp;
  const startedAt = Date.now();

  // 续扫（V4.20.0）：上一轮被游玩打断留下的进度，同一 语言树/旧戳/新戳 才接着用
  //（版本又切了就作废重来 —— 旧列表不再对应新的 prev）。
  const resume = idleMode && prewarmState.resume
    && prewarmState.resume.variant === variant && prewarmState.resume.oldStamp === oldStamp
    && prewarmState.resume.newStamp === newStamp ? prewarmState.resume : null;
  prewarmState.resume = null;

  let rels, stack, cnt, total;
  if (resume) {
    rels = resume.rels; stack = resume.stack; cnt = resume.cnt; total = resume.total;
  } else {
    cnt = { attempts: 0, reused: 0, refreshed: 0, skipped: 0, failed: 0 };
    // 枚举旧戳目录的资源文件（.ext 元数据不算）。积极性档沿用 PREWARM_MAX_FILES 上限（防御）；
    // 闲置缓扫不设上限 —— 它的目标就是"覆盖整棵树"，而且枚举纯本地、不发任何请求。
    const walkCap = idleMode ? Infinity : PREWARM_MAX_FILES;
    rels = [];
    stack = [oldDir];
    while (stack.length && rels.length < walkCap) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (!e.name.endsWith('.ext')) rels.push(path.relative(oldDir, p).split(path.sep).join('/'));
      }
    }
    total = rels.length;
  }

  // 预热实况（V4.14.11）：开工即建 live 对象并广播 start，之后每 500ms 广播一次进度 ——
  // 控制台的更新日提示条与托盘的开始气泡都吃这份数据。续扫不重建对象（数字接着涨、不倒退）。
  prewarmPolicy = idleMode ? 'idle' : 'full';
  if (resume && prewarmLive) { prewarmLive.running = true; prewarmLive.total = total; }
  else prewarmLive = { key: variant + '/' + oldStamp + '->' + newStamp, running: true, total, done: 0, reused: 0, refreshed: 0, failed: 0 };
  broadcast('prewarm', Object.assign({ phase: resume ? 'progress' : 'start' }, prewarmLive));
  const progressTimer = setInterval(() => {
    prewarmLive.done = cnt.skipped + cnt.reused + cnt.refreshed + cnt.failed;
    prewarmLive.reused = cnt.reused;
    prewarmLive.refreshed = cnt.refreshed;
    prewarmLive.failed = cnt.failed;
    broadcast('prewarm', Object.assign({ phase: 'progress' }, prewarmLive));
  }, 500);

  // 简单并发池：从游标取件，异常逐文件吞掉（单文件失败绝不影响整批）。
  // 闲置缓扫在每次取件前多过两道（V4.20.0）：
  //   ① 有任何游戏流量（<IDLE_SWEEP_STOP_MS）→ 整条暂停（不是降并发）—— 游玩优先；
  //   ② 随机间隔（抖动）—— 避免几秒一个的匀速节奏透出机器味。
  let cursor = 0;
  let paused = false;
  const idleJitterMs = () => (IDLE_SWEEP_JITTER_MAX <= IDLE_SWEEP_JITTER_MIN ? 0
    : IDLE_SWEEP_JITTER_MIN + Math.floor(Math.random() * (IDLE_SWEEP_JITTER_MAX - IDLE_SWEEP_JITTER_MIN + 1)));
  async function worker() {
    while (true) {
      if (idleMode) {
        if (backgroundShouldYield()) { paused = true; return; }   // V4.20.7：流量或关键路径在途都让路
        const j = idleJitterMs();
        if (j > 0) await new Promise((r) => setTimeout(r, j));
      }
      const i = cursor++;
      if (i >= rels.length) return;
      try { await prewarmOne(variant, oldStamp, newStamp, rels[i], cnt, idleMode); }
      catch { cnt.failed++; }
    }
  }
  const workers = idleMode ? Math.min(IDLE_SWEEP_CONCURRENCY, rels.length) : Math.min(PREWARM_CONCURRENCY, rels.length);
  try {
    await Promise.all(Array.from({ length: workers || 1 }, worker));
  } finally {
    // 闸门策略只该在扫描期间是 idle：正常/异常都复位（异常时若留着，下一轮扫描前
    // 任何经闸门的调用都会吃 2 并发上限）。正文剥离已改显式传参，不再依赖它。
    prewarmPolicy = 'full';
    clearInterval(progressTimer);
  }

  const remain = Math.max(0, rels.length - Math.min(cursor, rels.length));

  if (idleMode && paused && remain > 0) {
    // 暂停：不 fold 统计、不记 doneFor、不广播 done（托盘"预热中"保持、不误报完成）；
    // 剩余与累计计数存进 resume，下个闲置窗口接着扫。
    prewarmLive.done = cnt.skipped + cnt.reused + cnt.refreshed + cnt.failed;
    prewarmLive.reused = cnt.reused;
    prewarmLive.refreshed = cnt.refreshed;
    prewarmLive.failed = cnt.failed;
    prewarmLive.running = true;              // 跨闲置窗口的"进行中"：扫完才翻假
    prewarmState.resume = { variant, oldStamp, newStamp, rels: rels.slice(Math.min(cursor, rels.length)), stack, cnt, total };
    broadcast('prewarm', Object.assign({ phase: 'paused', remain }, prewarmLive));
    log(`[闲置缓扫] 检测到游戏流量，暂停：已完成 ${prewarmLive.done}/${total}（剩 ${remain}），下次闲置继续`);
    return;
  }

  prewarmLive.done = total;
  prewarmLive.reused = cnt.reused;
  prewarmLive.refreshed = cnt.refreshed;
  prewarmLive.failed = cnt.failed;
  prewarmLive.running = false;
  broadcast('prewarm', Object.assign({ phase: 'done' }, prewarmLive));
  // 闲置缓扫：跑完才记 doneFor（暂停后要能再触发续扫）。积极性仍由触发入口记（现状不变）。
  if (idleMode) prewarmState.doneFor.add(variant + '/' + newStamp);

  const s = prewarmState.stats;
  s.attempts += cnt.attempts; s.reused += cnt.reused; s.refreshed += cnt.refreshed;
  s.skipped += cnt.skipped; s.failed += cnt.failed;
  const took = Date.now() - startedAt;
  log(idleMode
    ? `[闲置缓扫] 完成 ${variant}/${oldStamp} -> ${newStamp}：核对 ${cnt.attempts}（复用 ${cnt.reused}）跳过 ${cnt.skipped} 失败 ${cnt.failed}，耗时 ${took}ms`
    : `[预热] 完成 ${variant}/${oldStamp} -> ${newStamp}：核对 ${cnt.attempts}（复用 ${cnt.reused} / 预下载 ${cnt.refreshed}）跳过 ${cnt.skipped} 失败 ${cnt.failed}，耗时 ${took}ms`);
  pushLog({ tag: 'STORE', path: `${variant}/${oldStamp} -> ${newStamp}`, source: 'prewarm',
    detail: `复用${cnt.reused} 预下${cnt.refreshed} 跳过${cnt.skipped} 失败${cnt.failed}` });
}

// ---------------------------------------------------------------- 按需过户（V4.15.10；P0-5 加固 V4.16.0）
//
// 解决的问题（2026-10-07 三次版本更新实测）：版本切换后的首批请求赶在后台预热前面 ——
// "更新后首屏"那批热点文件在预热轮到之前以 miss 身份整包下载；逐字节比对其中 99.7%
// 与旧戳内容完全一致（每次白下 10~22MB），且每次更新都重演。
//
// 做法：新戳请求 miss 的那一刻，先查**同一棵语言树**的其他戳目录里有没有同名旧副本
//（必须带 ETag）。有就发一次条件请求（If-None-Match + 头部指纹比对，指纹一致时正文
// 在头部阶段就被掐断）：
//   · 304，或 200 且源站自报 ETag 的 md5 段与旧副本一致 → 源站已背书内容一致 →
//     硬链接过户（零拷贝、零正文下载），调用方随后重走命中回放路径；
//   · 200 且指纹不一致（内容真变了）→ 这次讨来的正文直接落库（writeCacheEntry 全套），
//     调用方随后命中 —— 与普通回源等价，但省掉一次重复请求；
//   · 其余（没有旧副本 / 取源失败 / 404 等）→ 返回 false，调用方走原本的回源路径
//     一字不差（409/410 状态现场、回源合并、统计都不受影响）。
//
// 【P0-5（V4.16.0）加固 ①：迁移预算】2026-10-14 实机事故：关预热后按需迁移把"确认往返"
// 压在游戏的关键路径上 —— 会话内只迁 379 个文件（真实戳树 11,059 个）就把游戏卡到无法
// 加载。根因之一是取源太"顽强"：旧实现经 prewarmFetch 依次试 3 个候选主机、每个主机在
// fetchUpstream 里最多 2 次尝试 × 8 秒超时 —— 单文件最坏 ≈ 49 秒全让游戏干等。
// 现在按需迁移独走 migrateFetch：只用"游戏刚才真实用的那个主机"（HTTPS 代理模式下已知）、
// 单次尝试、2 秒超时；超时/失败立即放弃迁移、退回普通回源（那条路径自带重试与直连兜底）。
//
// 【P0-5 加固 ②：跟随式小预热】一次按需过户成功后，对**同一目录**里尚未过户的兄弟文件
// 在后台做同样的确认（见"跟随式小预热"一节）—— 让游戏"下一个要的文件"通常是本地命中。
//
// 红线不变：只有「源站明确确认内容一致」（304，或指纹相等）才会拿旧副本出字节；
// 其余情况一律服务源站本次返回的正文。指纹信息不足（旧 ETag 没有指纹段）按不一致
// 处理 —— 保守分支，宁可走回源。
//
// 与预热的分工：预热（全库扫）是"提前把整棵树过户好"（积极档，默认关）；跟随式是
// "跟着游戏触碰的目录走"（平衡档，默认开）；按需过户是请求路径上的兜底 —— 三者共用
// 同一套确认与落盘机制（etagMd5 / mergePrewarmHeaders / writePrewarmExt），改一处
// 必须两边一起想。
//
// 不受「版本更新自动预热」开关约束：那是后台任务的开关；这里是请求路径的效率优化
//（少一次整包下载），语义上和普通命中/回源同属核心缓存行为。**迁移预算（2 秒）对所有
// 档位生效** —— 它是安全修复，不是档位的一部分。
//
// 并发：同一路径的并发 miss 共用 migrateInFlight 里的在途 Promise，只出一次网；
// 落盘竞速（与预热/跟随/另一个请求同写一路径）由 fs.link 的 EEXIST 兜底。
const migrateInFlight = new Map();

// 按需迁移专用取源（P0-5 ①）：单主机、单次尝试、2 秒预算。失败/超时返回 null，
// 调用方立即退回普通回源。**不要**改回"依次试候选主机"：那是 49 秒卡死的来源。
const MIGRATE_TIMEOUT_MS = 2000;
async function migrateFetch(host, rest, extraHeaders, oldMd5) {
  const base = process.env.GBFCACHE_ORIGIN_BASE || ('https://' + host);
  const dropBody = prewarmDropBody(false, oldMd5);   // 与 md5Only 语义一致：指纹一致才掐断正文
  try {
    return await requestUpstream(`${base}${rest}`, extraHeaders, true, { dropBody, timeoutMs: MIGRATE_TIMEOUT_MS });
  } catch {
    return null;   // 超时/网络失败：交给普通回源，不在这里重试
  }
}

// 在**同一棵语言树**的其他戳目录里找这个相对路径的旧副本（要求 .ext 里有 ETag）。
// 从新到旧找第一个 —— 内容正确性由随后的指纹确认保证，选哪一任不影响结果。
async function findPrevCopy(variant, newStamp, rel) {
  const base = path.join(CACHE_ROOT, variant);
  let names;
  try {
    names = (await fsp.readdir(base, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name) && e.name !== newStamp)
      .map((e) => e.name)
      .sort((a, b) => Number(b) - Number(a));
  } catch { return null; }
  for (const name of names) {
    const oldPath = path.join(base, name, path.normalize(rel));
    if (!isInsideRoot(CACHE_ROOT, oldPath)) continue;
    try {
      const st = await fsp.stat(oldPath);
      if (!st.isFile()) continue;
    } catch { continue; }
    const meta = await readExtMetaAsync(oldPath);
    if (meta && meta.ETag) return { oldPath, meta, stamp: name };   // stamp：跟随式小预热要用它列旧目录
  }
  return null;
}

// 对外入口：同一路径并发去重。返回 true = 目标路径已就位（调用方重新 lookupCache
// 并按命中回放）；false = 没接管，按原本的回源路径继续。
// P0-5：入参带 host —— 迁移只向"游戏刚才真实用的那个主机"确认（不再试候选列表）。
function migrateOnMiss(host, rest, newPath, req) {
  return migrateOnce(host, rest, newPath, req, 'on-miss');
}

// 共用去重入口（P0-5）：按需与跟随共用同一张在途表 —— 游戏请求与跟随撞到同一文件时
// 只出一次网。（实测来源：test-prewarm 的 N 用例——跟随先发的条件请求与随后的游戏请求
// 各发了一次，同 URL 两次出网。共用后谁先到谁出网，另一方加入等结果。）
function migrateOnce(host, rest, newPath, req, source) {
  const key = host + String(rest);
  const existing = migrateInFlight.get(key);
  if (existing) return existing;
  // V4.20.7：按需（on-miss）确认计入"关键路径在途"—— 后台（跟随/闲置缓扫）在此期间让路；
  // 跟随自己的确认不计（它就是后台，自己跟自己让路没有意义）。
  const critical = source !== 'follow';
  if (critical) criticalUpstreamInFlight++;
  const job = migrateOne(host, rest, newPath, req, source)
    .catch(() => false)
    .finally(() => {
      if (critical) criticalUpstreamInFlight--;
      migrateInFlight.delete(key);
    });
  migrateInFlight.set(key, job);
  return job;
}

// 一次完整的「确认 + 复用/落库」（按需过户与跟随式小预热共用）。返回 true = 目标路径已就位。
async function migrateOne(host, rest, newPath, req, source) {
  if (!newPath) return false;
  const t0 = Date.now();
  const m = STAMP_PATH_RE.exec(rest);
  if (!m) return false;                    // 非版本戳路径（assets/img 等）不做 —— 那些资源本来就就地更新
  const newStamp = m[1];
  const variant = stampVariantOf(rest);
  const rel = rest.slice(('/' + variant + '/' + newStamp + '/').length);
  if (!rel) return false;

  const prev = await findPrevCopy(variant, newStamp, rel);
  if (!prev) return false;

  const oldMd5 = etagMd5(prev.meta.ETag);
  const up = await migrateFetch(host, rest, { 'if-none-match': prev.meta.ETag }, oldMd5);
  if (!up) { noteMigrate(source, false, Date.now() - t0, 0); return false; }

  const md5Match = up.status === 200 && up.bodyDropped === true
    && oldMd5 !== null && etagMd5(up.headers && up.headers.etag) === oldMd5;
  let ok = false;
  let detail = '';
  let refreshedBytes = 0;
  if (up.status === 304 || md5Match) {
    // 源站确认内容一致：硬链接过户。先补父目录（新戳目录树里第一个被取到的文件
    // 会缺父目录，fs.link 直接 ENOENT —— 与预热同一处理）。
    const eff = mergePrewarmHeaders(prev.meta, up.headers);
    const ct = prev.meta.ct || mimeFor(prev.oldPath, prev.meta);
    try { await fsp.mkdir(path.dirname(newPath), { recursive: true }); } catch { /* 已存在 */ }
    try {
      await fsp.link(prev.oldPath, newPath);
      await writePrewarmExt(newPath, prev.meta, eff, ct);
      ok = true; detail = 'link';
    } catch (e) {
      if (e && e.code === 'EEXIST') { ok = true; detail = 'link-exists'; }   // 并发方先放好了 —— 用现成的
      else {
        // 跨卷等意外：回退整份读旧副本再落盘（字节已经过确认，与预热回退同路）
        try {
          const { body } = await readCacheEntryAsync(prev.oldPath);
          await writeCacheEntry(newPath, body, ct, prev.meta.cors || null, '', eff);
          ok = fs.existsSync(newPath); detail = 'copy-fallback';
        } catch { ok = false; }
      }
    }
  } else if (up.status === 200 && up.body && up.body.length > 0) {
    // 指纹不一致（内容真变了）：这次讨来的就是新内容 —— 直接落库，省掉一次重复请求。
    // 不受「预热只过户」开关约束：那份正文是本次响应必需的，不是预下载。
    const ct = up.headers['content-type'] || mimeFor(prev.oldPath, prev.meta);
    try {
      await writeCacheEntry(newPath, up.body, ct, corsHeaders(up.headers, req), '', up.headers);
      ok = fs.existsSync(newPath); detail = 'refreshed';
      if (ok) refreshedBytes = up.body.length;   // "真变重下"的字节（复用的不算）
    } catch { ok = false; }
  }

  const ms = Date.now() - t0;
  noteMigrate(source, ok, ms, refreshedBytes);
  if (ok) {
    pushLog({ tag: 'MIGRATE', path: rest, source, detail: detail + ' ' + ms + 'ms' });
    // P0-5 ②：只在"按需"成功后触发跟随（跟随自己的成果不再递归触发）。
    if (source === 'on-miss') followSchedule(host, variant, newStamp, prev.stamp, rel);
  }
  return ok;
}

// 迁移计数与耗时（P0-5 ⑤；P1-A 补 refreshed 字节）：source = 'on-miss' | 'follow'
function noteMigrate(source, ok, ms, refreshedBytes) {
  const s = source === 'follow' ? stats.follow : stats.migrate;
  if (source === 'follow') { s.tried++; if (ok) s.ok++; else s.skipped++; }
  else { s.tries++; if (ok) s.ok++; else s.failed++; s.msTotal += ms; }
  if (refreshedBytes > 0) { s.refreshed++; s.refreshedBytes += refreshedBytes; }
}

// ---------------------------------------------------------------- 跟随式小预热（P0-5，V4.16.0）
//
// 动机（2026-10-14 实机事故）：关掉全库预热后，按需过户把"向源站确认"的往返压在游戏的
// 关键路径上 —— 会话内只迁 379 个文件（真实戳树 11,059 个）就把游戏卡到无法加载。
// 跟随式：一次按需过户**成功**后，对该文件**所在目录**里尚未过户的兄弟文件在**后台**做
// 同样的「确认 + 复用」—— 游戏随后请求它们时直接本地命中，关键路径上不再有往返。
//
// 边界（与开发纪律一致）：
//   · 集合 ⊂ "游戏已经触碰过的目录"（比全库问候窄得多），每目录一次最多 FOLLOW_PER_DIR 个；
//   · 后台 FOLLOW_CONCURRENCY 个并发，不进任何请求的关键路径；
//   · 同目录 FOLLOW_DIR_COOLDOWN_MS 冷却 + 进程内去重（seen）+ 幂等（目标已存在即跳过）；
//   · 刻意**不做**"活跃期暂停"：它的用途正是在游戏加载时抢跑到前面；量级由上面三条钉死，
//     且每个在途只是几百字节的头部级确认。
// seen 随会话增长（上界 ≈ 缓存文件数），进程重启即清空 —— 幂等，重来一遍只是跳过。
//
// 参数调优（V4.18.1；依据 2026-10-14 两份真实战报，见 改进计划书-第二轮 P2-C/F5）：
//   · 跟随占比随会话推进 24% → 74%（探索期按需扛、浏览期跟随扛），确认成功率 89%；
//   · 每次被跟随替掉的是 0.6～1.9 秒的关键路径等待（链路劣化时更高）——覆盖率的边际价值高；
//   · 12/60s → 24/30s 后的暴露量：每目录每分钟 ≤24～48 个头部级请求，仍严格 ⊂ 触碰目录，
//     离全库扫（约 5,300 次/更新日）差两个数量级。
//   · 并发刻意保持 3 不动（一次只调一个变量）；效果用 /api/stats 的 stats.follow 复核（ok / skipped）。
const FOLLOW_PER_DIR = 24;
const FOLLOW_CONCURRENCY = 3;
const FOLLOW_DIR_COOLDOWN_MS = 30 * 1000;
const FOLLOW_MAX_QUEUE = 200;
const followState = { queue: [], active: 0, seen: new Set(), dirAt: new Map() };
let followRetryPending = false;    // V4.20.7：让路期间"稍后回来继续"的定时重试是否已挂

function followEnabled() { return config.followEnabled !== false; }

// 由一次成功的按需过户触发：把同目录兄弟入队（同步、有界：读盘 ≤ FOLLOW_PER_DIR 次 stat/.ext）
function followSchedule(host, variant, stamp, prevStamp, rel) {
  if (!followEnabled()) return;
  const relDir = rel.split('/').slice(0, -1).join('/');
  const dirKey = variant + '/' + stamp + '/' + relDir;
  const now = Date.now();
  if (now - (followState.dirAt.get(dirKey) || 0) < FOLLOW_DIR_COOLDOWN_MS) return;
  followState.dirAt.set(dirKey, now);
  const oldDir = path.join(CACHE_ROOT, variant, prevStamp, path.normalize(relDir));
  if (!isInsideRoot(CACHE_ROOT, oldDir)) return;
  let entries;
  try { entries = fs.readdirSync(oldDir, { withFileTypes: true }); } catch { return; }
  let queued = 0;
  for (const e of entries) {
    if (queued >= FOLLOW_PER_DIR || followState.queue.length >= FOLLOW_MAX_QUEUE) break;
    if (!e.isFile() || e.name.endsWith('.ext')) continue;
    const relSib = relDir ? relDir + '/' + e.name : e.name;
    const rest = '/' + variant + '/' + stamp + '/' + relSib;
    if (followState.seen.has(rest)) continue;
    followState.seen.add(rest);
    const newPath = cachePathFor(CACHE_ROOT, rest);
    if (!newPath) continue;
    const meta = readExtMeta(path.join(oldDir, e.name));
    if (!meta || !meta.ETag) continue;        // 没有可用的比对原料，交给按需回源
    try { if (fs.existsSync(newPath)) continue; } catch { continue; }
    followState.queue.push({ host, rest, newPath });
    queued++;
  }
  followPump();
}

function followPump() {
  // V4.20.7：让路 —— 有游戏流量或关键路径在途时整条暂停；队列还在就定时回来看一眼
  //（不然这个队列要等到下一次"按需过户成功"才会被重新踢一脚，白等一整个目录的收益）。
  if (followState.queue.length && backgroundShouldYield()) {
    if (!followRetryPending) {
      followRetryPending = true;
      setTimeout(() => { followRetryPending = false; followPump(); }, 700);
    }
    return;
  }
  while (followState.active < FOLLOW_CONCURRENCY && followState.queue.length) {
    const item = followState.queue.shift();
    followState.active++;
    migrateOnce(item.host, item.rest, item.newPath, null, 'follow')
      .catch(() => false)
      .then(() => { followState.active--; followPump(); });
  }
}

// 清掉过期的版本戳目录。
// dryRun 缺省为 **true** —— 调用方必须显式传 false 才会真删（安全默认，防止手滑）。
function evictStamps(dryRun) {
  const dirs = listStampDirs();
  const names = dirs.map((d) => d.name);
  const inUseSet = inUseStamps(Date.now());
  const plan = planStampKeep(names, inUseSet, STAMP_KEEP);
  const evictSet = new Set(plan.evict);
  const targets = dirs.filter((d) => evictSet.has(d.name));

  const out = {
    ok: true, dryRun: !!dryRun, cacheRoot: CACHE_ROOT,
    current: (xVersionObs.last && names.indexOf(String(xVersionObs.last)) >= 0) ? String(xVersionObs.last) : null,
    inUse: names.filter((n) => inUseSet.has(n)),
    keep: plan.keep, evicted: [], files: 0, bytes: 0, errors: [],
  };
  if (!targets.length) {
    out.reason = '没有可清理的过期版本戳目录（共 ' + names.length + ' 个戳，保留 ' + plan.keep.length + ' 个）';
    return out;
  }
  // 红线：缓存目录若指向原版 ACG Power 的目录（旧资源的唯一存活副本），一律不动。
  if (/acgpower/i.test(CACHE_ROOT)) {
    out.ok = false;
    out.errors.push('缓存目录看着像原版 ACG Power 的目录（' + CACHE_ROOT +
      '）—— 那是旧资源的唯一存活副本，出于安全绝不清理，确需清理请手动处理');
    return out;
  }
  for (const d of targets) {
    const full = d.dir || path.join(CACHE_ROOT, d.name);   // 全名（assets_en/123）→ 用 listStampDirs 给的绝对路径
    if (!isInsideRoot(CACHE_ROOT, full)) { out.errors.push('跳过越界路径：' + full); continue; }
    if (!dryRun) {
      // 整目录删掉 —— 同名 .ext 元数据自然跟着走，不会留下孤儿元数据。
      // （与 cleanCacheByExt 的差异：那个只删文件、保留目录结构；这里是成片淘汰，
      //   目录本身就是"过期戳"，留着没有意义。）
      try { fs.rmSync(full, { recursive: true, force: true }); }
      catch (e) { out.errors.push(d.name + ': ' + e.message); continue; }
    }
    out.evicted.push(d.name);
    out.files += d.files;
    out.bytes += d.bytes;
  }
  if (!dryRun && out.evicted.length) scanCache();   // 删完刷新统计，界面数字立刻对上
  return out;
}

// 自动清理过期版本戳（V4.15.2 设置面板，默认关）：开启后定期点名，
// 发现超出保留策略（最新 2 个 + 24 小时内在用）的旧戳就自动清理。
// 这里只做**轻量点名**（读两层目录名，不做全量体积清点），确有可清的才交给
// evictStamps 执行 —— 它自带全部安全红线（根目录检查 / acgpower 保护 / 真删需显式）。
async function autoEvictCheck() {
  const names = [];
  try {
    for (const e of fs.readdirSync(CACHE_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory() || !ASSET_DIR_RE.test(e.name)) continue;
      for (const s of fs.readdirSync(path.join(CACHE_ROOT, e.name), { withFileTypes: true })) {
        if (s.isDirectory() && /^\d+$/.test(s.name)) names.push(e.name + '/' + s.name);
      }
    }
  } catch { return; }
  if (!names.length) return;
  const plan = planStampKeep(names, inUseStamps(Date.now()), STAMP_KEEP);
  if (!plan.evict.length) return;
  log('[自动清理] 发现超出保留策略的旧版本戳：' + plan.evict.join('、') + ' —— 开始清理');
  const r = evictStamps(false);
  log('[自动清理] 已清理 ' + r.evicted.length + ' 个目录 / ' + (r.bytes / 1048576).toFixed(1) + ' MB'
      + (r.errors.length ? '；失败 ' + r.errors.length + ' 项' : ''));
}

// ---------------------------------------------------------------- hosts + 本地 443 兜底模式（V4.8.0，原清单 P1-8）
//
// 定位：**PAC 槽被别的程序抢占、且无法串接时的最后手段** —— 完全不依赖 PAC 槽。
// 原理：把 CDN 主机名写进系统 hosts 指向 127.0.0.1，并让本程序在 **443** 上终结 TLS，
// 于是浏览器把资源请求直接发给我们。证书覆盖 `*.akamaized.net`（见 certs\server.crt 的 SAN）；
// 2026-09-18 已核实：证书与私钥配对、CA 有效至 2036、**443 在 Windows 上无需管理员即可监听**。
//
// 【为什么只指 CDN、绝不指游戏本域】游戏本域的 `/rest/` 接口一旦过我们会触发
// 「新しいバージョンがあります」重载循环（项目红线）。**只指 CDN 就从结构上排除了这种可能** ——
// CDN 上全是静态资源，没有任何需要登录态的接口。代价：从游戏本域取的 /assets/ 不再走缓存。
// 作为"最后手段"这个取舍是划算的：至少 CDN 那部分仍然缓存。
//
// 【环路规避】hosts 一旦把域名指到 127.0.0.1，**我们自己的回源也会被指回来**，形成死循环。
// 所以本模式下回源要绕开 hosts：用 `dns.resolve4()`（走 c-ares 直接查 DNS，不经系统 hosts）
// 拿真实 IP 再连。**解析失败时直接让本次回源失败，绝不回退到 dns.lookup** ——
// 那会拿回 127.0.0.1 打到自己身上；一次回源失败远比死循环可控。
//
// 【安全约定】
//   · 默认关闭，**从不自动启用**；启用必须显式调用接口并带 dryRun=0。
//   · hosts 里只动**我们自己标记之间**的那几行（启用=替换、恢复=删除），
//     绝不碰文件里其它程序的条目 —— 所以不需要"整文件回滚"那种粗暴做法。
//   · **443 监听没起来就拒绝写 hosts**：否则会把 CDN 指向没人监听的端口，资源全挂。
//   · 启动时若发现 hosts 里还留着我们的块，**自动把 443 监听拉起来并告警** ——
//     "上次启用过、这次重启了程序"不能变成黑洞（宁可继续缓存，也不要断网）。
const HOSTS_MARK_BEGIN = '# >>> GBFCache BEGIN（本程序添加；程序会自动清理，请勿手工编辑）';
const HOSTS_MARK_END = '# <<< GBFCache END';
// 默认只指这两个 CDN 主机（日语树 + 英语树，V4.14.4；证书 SAN 已覆盖 *.akamaized.net）。
// 可用 config.json 的 hostsModeHosts 数组覆盖（例如游戏换了新的 CDN 前缀时）。
const HOSTS_REDIRECT_DEFAULT = [
  'prd-game-a-granbluefantasy.akamaized.net',
  'prd-game-a-gbf.akamaized.net',
];

// 监听端口固定 443（浏览器直连本机 443 才会被我们接到）。允许环境变量覆盖**仅为测试** ——
// 测试不该去抢真实的 443（可能和本机别的软件冲突）。
function hostsModePort() {
  const p = parseInt(process.env.GBFCACHE_HOSTS_PORT, 10);
  return (Number.isFinite(p) && p > 0 && p < 65536) ? p : 443;
}

const hostsMode = { active: false, listener: null, appliedAt: 0, listenError: '' };

function hostsFilePath() {
  // 允许用环境变量替换（测试用：拿临时文件当 hosts，绝不碰系统那份）
  return process.env.GBFCACHE_HOSTS_FILE
    || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
}

function hostsRedirectList() {
  const c = Array.isArray(config.hostsModeHosts) ? config.hostsModeHosts : null;
  const list = (c && c.length ? c : HOSTS_REDIRECT_DEFAULT)
    .map((h) => String(h || '').trim().toLowerCase())
    .filter((h) => /^[a-z0-9.\-]+$/.test(h));   // 白名单式清洗：域名里不该有别的东西
  return Array.from(new Set(list));
}

// 本主机是否被我们重定向到了本机（回源时要绕开它）
function isRedirectedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return hostsRedirectList().indexOf(h) >= 0;
}

// ---- 纯函数（好测：喂合成文本即可覆盖各种排版）----

// 生成我们的块。eol 由调用方按原文件的行尾风格给 —— 见下面 detectEol 的说明。
function buildHostsBlock(hosts, eol) {
  return [HOSTS_MARK_BEGIN]
    .concat((hosts || []).map((h) => '127.0.0.1 ' + h))
    .concat([HOSTS_MARK_END])
    .join(eol || '\r\n');
}

// 沿用原文件的行尾风格。
// 【为什么要管这个】早先的实现把整文件按 /\r?\n/ 拆开、再用 \r\n 拼回去 —— 内容对，
// 但**行尾被统一改掉了**，于是"恢复"之后与原文件不是逐字节一致。对系统 hosts 来说，
// "只删自己加的行"就该是字面意义上的只删那几行：别人的行、连同行尾，一个字节都不动。
function detectEol(text) {
  return /\r\n/.test(String(text || '')) ? '\r\n' : '\n';
}

// 解析：我们的块在不在？块里有哪些主机？
function parseHostsBlock(text) {
  const lines = String(text || '').split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim() === HOSTS_MARK_BEGIN);
  const j = lines.findIndex((l) => l.trim() === HOSTS_MARK_END);
  if (i < 0 || j < 0 || j < i) return { present: false, hosts: [], malformed: (i >= 0 || j >= 0) };
  const hosts = [];
  for (let k = i + 1; k < j; k++) {
    const m = /^\s*127\.0\.0\.1\s+([a-z0-9.\-]+)\s*$/i.exec(lines[k]);
    if (m) hosts.push(m[1].toLowerCase());
  }
  return { present: true, hosts, malformed: false };
}

// 去掉我们的块（**只删标记之间的行**，其余连行尾一起原样保留）。返回 { text, removed }
function stripHostsBlock(text) {
  const s = String(text || '');
  const eol = detectEol(s);
  const lines = s.split(/\r?\n/);
  const i = lines.findIndex((l) => l.trim() === HOSTS_MARK_BEGIN);
  const j = lines.findIndex((l) => l.trim() === HOSTS_MARK_END);
  if (i < 0 || j < 0 || j < i) return { text: s, removed: 0 };
  return { text: lines.slice(0, i).concat(lines.slice(j + 1)).join(eol), removed: j - i + 1 };
}

// 写入/替换我们的块：已有就替换，没有就追加。返回 { text }
function upsertHostsBlock(text, hosts) {
  const s = String(text || '');
  const eol = detectEol(s);
  const stripped = stripHostsBlock(s);
  const block = buildHostsBlock(hosts, eol);
  let base = stripped.text.replace(/(\r?\n)+$/, '');   // 去尾部空行，避免反复 upsert 越攒越多
  if (base) base += eol;
  return { text: base + block + eol };
}

// ---- 文件与监听（下面这些会碰系统）----

function hostsStatus() {
  const p = hostsFilePath();
  let text = null, err = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { err = e.message; }
  const st = text === null ? { present: false, hosts: [], malformed: false } : parseHostsBlock(text);
  let writable = false, writableErr = '';
  // 【为什么用 r+ 打开来探可写性，而不用 fs.accessSync(W_OK)】
  // 2026-09-18 实测（本机、非管理员）：
  //   · `accessSync(p, W_OK)` → **通过**。它在 Windows 上只看"只读属性"，不看 ACL，
  //     于是非管理员也报"可写"，是个会误导人的信号 —— 别拿它代替真正的探测。
  //   · `openSync(p, 'r+')` → **EPERM**（正确反映"改不了"）。
  // 而且要澄清一点：这个探测**不会改动文件**（实测 mtime 前后未变），
  // 也绝不会有内容变更 —— 真正写盘只发生在 setHostsMode 里，且必须先过 443 监听那道闸。
  try { const fd = fs.openSync(p, 'r+'); fs.closeSync(fd); writable = true; }
  catch (e) { writableErr = e.code || e.message; }
  return {
    path: p, exists: text !== null, readError: err,
    blockPresent: st.present, malformed: !!st.malformed, hosts: st.hosts,
    redirectList: hostsRedirectList(),
    writable, writableError: writableErr, needsAdmin: !writable,
    modeActive: hostsMode.active, listenPort: hostsModePort(),
    listenerUp: !!(hostsMode.listener && hostsMode.listener.listening),
    listenError: hostsMode.listenError, appliedAt: hostsMode.appliedAt || null,
  };
}

// 起 443 监听：把直连到本机 443 的请求按"原始主机"交给同一套拦截逻辑
function startHostsModeListener(cb) {
  if (hostsMode.listener && hostsMode.listener.listening) return cb(true, '');
  let key, cert;
  try {
    key = fs.readFileSync(path.join(CERT_DIR, 'server.key'));
    cert = fs.readFileSync(path.join(CERT_DIR, 'server.crt'));
  } catch (e) { return cb(false, '读证书失败：' + e.message); }
  const srv = https.createServer({ key, cert }, (req, res) => {
    const host = String(req.headers.host || '').split(':')[0] || 'game.granbluefantasy.jp';
    handleIntercepted(host, req, res).catch(() => { try { res.writeHead(500); res.end('err'); } catch { /* 忽略 */ } });
  });
  srv.on('error', (e) => {
    hostsMode.listenError = e.code || e.message;
    hostsMode.listener = null;
    log('[hosts 模式] 443 监听失败：' + hostsMode.listenError);
    cb(false, hostsMode.listenError);
  });
  srv.listen(hostsModePort(), '127.0.0.1', () => {
    hostsMode.listener = srv;
    hostsMode.listenError = '';
    log('[hosts 模式] 已在 127.0.0.1:' + hostsModePort() + ' 起监听（浏览器直连本机 443 的资源请求会走缓存）');
    cb(true, '');
  });
  return undefined;
}

function writeHosts(p, text) {
  try {
    // 备份一份到 logs\（**不是用来回滚的** —— 回滚靠标记删除；这份只是留证）
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.copyFileSync(p, path.join(LOG_DIR, 'hosts-backup-' + Date.now() + '.txt'));
    } catch { /* 备份失败不拦主流程 */ }
    // 注意：UTF-8 **不带 BOM** —— 带 BOM 会让 hosts 首行解析失败
    fs.writeFileSync(p, text, 'utf8');
    return true;
  } catch { return false; }
}

// 写入/移除 hosts。dryRun 缺省为 true（与版本戳淘汰同一约定：改系统文件的事宁可多问一次）
function setHostsMode(action, dryRun, cb) {
  const want = String(action || '').toLowerCase();
  const p = hostsFilePath();
  const hosts = hostsRedirectList();
  let text;
  try { text = fs.readFileSync(p, 'utf8'); }
  catch (e) { return cb({ ok: false, error: '读不到 hosts 文件：' + e.message + '（路径 ' + p + '）' }); }

  if (want === 'restore') {
    const s = stripHostsBlock(text);
    const out = { ok: true, action: 'restore', dryRun: !!dryRun, path: p, removed: s.removed };
    if (s.removed === 0) { out.note = 'hosts 里没有本程序添加的条目，无需清理'; return cb(out); }
    if (dryRun) { out.note = '将删除本程序添加的 ' + s.removed + ' 行'; return cb(out); }
    if (!writeHosts(p, s.text)) return cb({ ok: false, error: '写 hosts 失败（多半需要管理员权限）', path: p });
    if (hostsMode.listener) { try { hostsMode.listener.close(); } catch { /* 忽略 */ } }
    hostsMode.listener = null;
    hostsMode.active = false;
    log('[hosts 模式] 已移除 hosts 条目并停止 443 监听');
    return cb(out);
  }

  const pre = hostsStatus();
  const s = upsertHostsBlock(text, hosts);
  const out = {
    ok: true, action: 'apply', dryRun: !!dryRun, path: p, hosts,
    alreadyPresent: pre.blockPresent, needsAdmin: pre.needsAdmin,
    note: pre.blockPresent ? 'hosts 里已有本程序的块，将就地更新' : '将在 hosts 末尾追加本程序的条目块',
  };
  if (dryRun) return cb(out);

  // ⚠️ 顺序很重要：**先把 443 监听拉起来，再写 hosts**。
  // 反过来的话，万一监听起不来，CDN 已经被指向一个没人听的端口 —— 游戏资源会全挂。
  if (!hostsMode.listener || !hostsMode.listener.listening) {
    return cb({ ok: false, error: '443 监听没起来，拒绝写 hosts（否则 CDN 会被指向没人监听的端口，资源全挂）' });
  }
  if (!writeHosts(p, s.text)) {
    return cb({ ok: false, error: '写 hosts 失败（多半需要管理员权限：请以管理员身份重启程序）', path: p });
  }
  hostsMode.active = true;
  hostsMode.appliedAt = Date.now();
  log('[hosts 模式] 已写入 hosts 条目：' + hosts.join('、') + ' -> 127.0.0.1:' + hostsModePort());
  return cb(out);
}

// hosts 模式下的回源解析：绕开系统 hosts，直接问 DNS
function hostsModeLookup(hostname, options, callback) {
  const dns = require('dns');
  if (!hostsMode.active || !isRedirectedHost(hostname)) return dns.lookup(hostname, options, callback);
  dns.resolve4(hostname, (err, addrs) => {
    if (err || !addrs || !addrs.length) {
      // 绝不用 dns.lookup 兜底：那会把 127.0.0.1 解析回来打到自己身上，形成死循环。
      log('[hosts 模式] 绕开 hosts 解析 ' + hostname + ' 失败（' + (err && err.message) +
        '）—— 本次回源放弃，不做 hosts 兜底');
      return callback(new Error('hosts 模式下无法解析真实 IP：' + (err && err.message)));
    }
    if (options && options.all) return callback(null, addrs.map((a) => ({ address: a, family: 4 })));
    return callback(null, addrs[0], 4);
  });
  return undefined;
}

// ---------------------------------------------------------------- 工具

// 日志同时写控制台和文件。
// 必须落盘的原因：托盘模式下服务没有控制台窗口，输出会被直接丢弃，出问题将无从排查。
// 文件放在 logs/ 下，超过上限自动轮转一次。
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
const LOG_MAX_BYTES = 2 * 1024 * 1024;

// V4.12.0：改为**异步流写**。过去的 appendFileSync 每条日志都要 mkdirSync + statSync +
// appendFileSync 三次同步系统调用，而 log() 在每次回源 MISS 都会触发 —— 版本更新日一秒
// 几百个 MISS 时，这些同步调用把整个事件循环卡住，整页加载高峰期所有请求跟着排队。
// 现在目录检查与轮转只在开流时做，之后每条日志只是一次 stream.write（先在内存排队，
// 由 Node 落盘），请求路径不再被日志拖住。
let logStream = null;
let logBytesWritten = 0;
let logRotating = false;

function openLogStream() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // 趁还没有流占着文件时做轮转检查（文件被占用时 rename 会失败）
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
        fs.renameSync(LOG_FILE, LOG_FILE + '.1');
      }
    } catch { /* 首次运行还没有文件 */ }
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    logBytesWritten = 0;
    logStream.on('error', () => {
      // 磁盘异常时静默：坏流丢掉，下次写日志时再重建（与旧实现的"静默"一致）
      try { logStream.destroy(); } catch { }
      logStream = null;
    });
  } catch { logStream = null; }
}

// 轮转：先 end() 旧流（等缓冲落盘）再改名。期间来的几条日志丢弃 —— 每 2 MB 才发生一次，
// 旧实现同样是"到量才检查一次"，语义相当。
function rotateLogFile() {
  const old = logStream;
  logStream = null;
  if (!old) return;
  logRotating = true;
  old.end(() => {
    try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch { /* 被占用就等下轮 */ }
    logRotating = false;
  });
}

function logToFile(line) {
  try {
    if (!logStream && !logRotating) openLogStream();
    if (!logStream) return;
    const buf = Buffer.from(line + '\n', 'utf8');
    logBytesWritten += buf.length;
    logStream.write(buf);
    if (logBytesWritten > LOG_MAX_BYTES) rotateLogFile();
  } catch { /* 磁盘异常时静默，不影响主流程 */ }
}

function log(...a) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}]`, ...a);
  const text = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  logToFile(`[${new Date().toISOString()}] ${text}`);
}

// 把 URL 路径映射为缓存文件路径（复刻原程序：仅替换分隔符）
// 原程序只按路径做键、不区分主机；这里对非 GBF 主机额外分目录，避免不同域同名文件互相覆盖。
// 碧蓝幻想的资源实际来自两个域：
//   - game.granbluefantasy.jp  —— 页面外壳
//   - prd-game-*-granbluefantasy.akamaized.net —— 真正的资源 CDN（Akamai）
// 既有缓存的磁盘布局只按 URL 路径做键、不区分主机，所以这两处必须共用同一个
// 缓存根目录，否则已有的 8 万个缓存文件会因为「主机对不上」而全部无法命中。
const GBF_HOST_RE = /granbluefantasy\.(jp|akamaized\.net)$/i;

function cacheRootFor(host) {
  if (GBF_HOST_RE.test(host)) return CACHE_ROOT;
  // 其他主机放到同级 _other/<host> 下，保持 GBF 缓存目录原样不被污染
  const other = path.join(path.dirname(CACHE_ROOT), '_other', host.replace(/[^a-z0-9._-]/gi, '_'));
  return other;
}

// 判断 full 是否**严格位于** base 之内。
// 抽成单函数，好让读、写、删三处共用同一判据，避免各写一份、日后漂移
// （版本戳淘汰要拿它去删文件，那里判错的代价是删掉不该删的东西）。
//
// 【两道检查缺一不可】
//   · 先把两侧都 path.resolve：真正把 '..' 解掉再比。只比字符串的话，
//     '<base>\assets\..\..\secret.txt' 会以 '<base>' 开头而被放行 —— 实际却指向 base 之外。
//   · 比较时带上 path.sep：base='G:\GBF' 时 'G:\GBF_evil\x' 也以 'G:\GBF' 开头，
//     不带分隔符就会把同前缀的兄弟目录判成界内。
function isInsideRoot(base, full) {
  if (!base || !full) return false;
  const b = path.resolve(base);
  const f = path.resolve(full);
  // 注意：带上 path.sep 比较**同时也排除了"根目录本身"**（b 不可能以 b+分隔符 开头），
  // 所以不需要再单独写一个 `f === b` 分支 —— 写了也是死代码，任何 mutation 都杀不掉它，
  // 反而会让人误以为"根目录"这个情形是那一行在管。判据的每一次收紧都该能被测试区分出来。
  return f.startsWith(b + path.sep);
}

function cachePathFor(root, urlPath) {
  const rel = urlPath.replace(/^\/+/, '');
  if (!rel) return null;
  // 防目录穿越：先规范化、剥掉开头的 ../
  const base = path.resolve(root);
  const full = path.join(base, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  return isInsideRoot(base, full) ? full : null;
}

function mimeFor(filePath, extMeta) {
  if (extMeta && extMeta.ct) return extMeta.ct;
  const e = path.extname(filePath).toLowerCase();
  return MIME[e] || 'application/octet-stream';
}

function readExtMeta(filePath) {
  try {
    const raw = fs.readFileSync(filePath + '.ext', 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

// 异步版（V4.14.6）：请求热路径（命中查找 / 304 快路径）不再做同步盘读 ——
// 与 readCacheEntryAsync 的异步化同一条思路。语义与同步版一致：
// 读不到 / 解析不了返回 null，绝不抛出。同步版仍留给预热过户、缓存自测等非热路径。
async function readExtMetaAsync(filePath) {
  try {
    const raw = await fsp.readFile(filePath + '.ext', 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

// 缓存文件可能带 8 字节魔数前缀（原程序 acgpower 的磁盘格式），有就先剥掉。
// 抽成小函数：同步/异步两个读法共用，避免两处写法漂移。
const CACHE_PREFIX = Buffer.from('acgpower', 'ascii');

function stripCachePrefix(buf) {
  if (buf.length >= CACHE_PREFIX.length && buf.subarray(0, CACHE_PREFIX.length).equals(CACHE_PREFIX)) {
    return buf.subarray(CACHE_PREFIX.length);
  }
  return buf;
}

// 读缓存文件并返回可直接发给浏览器的字节
// 原程序存盘时：文本资源存 gzip，二进制资源存原始字节。
// 这里统一解压，浏览器永远拿到未压缩数据 —— 不会出现编码不匹配。
// 同步版仅供**缓存自测**等非请求场景使用（V4.15.1 起预热过户也改走异步版了）；
// 请求命中一律走 readCacheEntryAsync。
function readCacheEntry(filePath) {
  const buf = stripCachePrefix(fs.readFileSync(filePath));
  const meta = readExtMeta(filePath);
  if (buf.length >= 2 && buf.subarray(0, 2).equals(GZIP_MAGIC)) {
    try {
      return { body: zlib.gunzipSync(buf), meta };
    } catch {
      // 解压失败则原样返回（极少见）
    }
  }
  return { body: buf, meta };
}

// 异步版（V4.12.0）：读盘与解压都不占事件循环。更新日整页加载时几十个命中同时到达，
// 同步版的 readFileSync/gunzipSync 会在事件循环上排队 —— 表现为"进新地图/更新日
// 第一批资源一个个蹦出来"。解压走 zlib 的异步接口，大文件解压的几毫秒也不再挡路。
async function readCacheEntryAsync(filePath) {
  // V4.14.6：正文与 .ext 元数据**并行**读，且元数据读也异步化 —— 命中风暴时这两次盘读
  // 全部离开事件循环，单次命中的读盘从「串行两读」变成「并行一拍」。
  const [raw, meta] = await Promise.all([fsp.readFile(filePath), readExtMetaAsync(filePath)]);
  let buf = stripCachePrefix(raw);
  if (buf.length >= 2 && buf.subarray(0, 2).equals(GZIP_MAGIC)) {
    try { buf = await zlib.gunzip(buf); } catch { /* 解压失败则原样返回（极少见） */ }
  }
  return { body: buf, meta };
}

// ---------------------------------------------------------------- 缓存写入（V4.9.0 改造）
//
// 旧写法三处隐患，一次修掉：
//   ① 收到的内容不问来路一律入库 —— 源站或链路上某个环节返回 HTML 错误页/劫持页时，
//      错误页会被存成 .png/.js，之后**每次命中都回错误页**，且因为缓存永不自行过期，
//      坏内容会一直驻留。备用上网路线（V4.8.x 新增）恰好放大了这种暴露面。
//   ② 同步写盘发生在响应路径上 —— 回源拿到一个大文件时，两次 writeFileSync 会把
//      整个事件循环卡住，同时进来的其他请求全部排队。
//   ③ 直接写目标文件名 —— 写到一半进程被杀/断电，会留下半截正文顶着正式文件名，
//      下次命中会被当成好缓存回给浏览器。
// 现在拆成三层：内容体检（纯内存、同步、便宜）→ 写盘闸门（限同时在飞的写数）→
// 原子落盘（临时文件 + 改名）。写入整体异步化，调用方不等待，响应不再被磁盘拖住。

// ---- 1) 内容体检：body 得长得像它声称的那种资源 ----
// 只挡「明显不对」的：HTML 文档冒充任何资源、二进制类型的文件头对不上。
// 判不出的一律放行（宁可少挡，不可错杀真实资源导致反复回源）。
// 注意 body 是回源时已解压的内容（requestUpstream 里统一 gunzip 过），直接看字节即可。
function isPlausibleAssetBody(body, contentType, ext) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/html')) return { ok: false, why: '响应是 HTML 文档' };

  // HTML 冒充检测（对所有类型都做）：真实资源不会以文档头开头 —— 会这么开头的是
  // 错误页、验证页、劫持页。JS/CSS 里即使出现这些字样也在文件后部，不会顶着开头。
  const head = body.subarray(0, 64).toString('latin1').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    return { ok: false, why: '内容开头是 HTML 文档' };
  }

  // 二进制类型的文件头（hex 魔数 + 偏移）。只列魔数足够强（>=3 字节或有容器结构）的
  // 类型；.bmp/.ico/.aac/.eot/.unityweb 与文本类（.js/.css/.json/.txt/.svg/.xml）不校验 ——
  // 前者魔数太短容易误杀，后者内容本来就是任意的。
  const MAGIC = [
    ['.png', '89504e470d0a1a0a', 0],
    ['.jpg', 'ffd8ff', 0], ['.jpeg', 'ffd8ff', 0],
    ['.gif', '47494638', 0],                              // "GIF8"
    ['.webp', '57454250', 8],                             // "WEBP"（前面是 RIFF 容器头）
    ['.ogg', '4f676753', 0],                              // "OggS"
    ['.wav', '57415645', 8],                              // "WAVE"（前面是 RIFF 头）
    ['.mp3', '494433', 0, true],                          // "ID3"；第四位=true 表示接受 MPEG 帧同步
    ['.mp4', '66747970', 4], ['.m4a', '66747970', 4],     // "ftyp"
    ['.webm', '1a45dfa3', 0],
    ['.woff', '774f4646', 0], ['.woff2', '774f4632', 0],  // "wOFF"/"wOF2"
    ['.ttf', '00010000', 0], ['.otf', '4f54544f', 0],     // "OTTO"
  ];
  const rule = MAGIC.find((r) => r[0] === ext);
  if (!rule) return { ok: true };

  const [, hex, off, mpegSync] = rule;
  const need = off + hex.length / 2;
  if (body.length < need) return { ok: false, why: `内容比 ${ext} 的文件头还短` };
  if (body.subarray(off, need).toString('hex') === hex) return { ok: true };
  // MP3 无 ID3 标签时直接以 MPEG 帧开头：首字节 0xFF、次字节高三位为同步位
  if (mpegSync && body[0] === 0xff && (body[1] & 0xe0) === 0xe0) return { ok: true };
  return { ok: false, why: `文件头不是 ${ext} 的魔数` };
}

// ---- 2) 写盘闸门：限制同时在飞的磁盘写数 ----
// 回源高峰（版本更新日）一瞬间可能积压几十上百个待写文件，全部并发写会把磁盘队列
// 打满、拖慢同时正在读缓存的请求。上限取小值即可 —— 本地盘的写入带宽有限，8 个
// 已经足够排满，多出来的只在内存里排队。
const STORE_CONCURRENCY = 8;
let storeActive = 0;
const storeWaiters = [];
function acquireStoreSlot() {
  if (storeActive < STORE_CONCURRENCY) { storeActive++; return Promise.resolve(); }
  return new Promise((resolve) => storeWaiters.push(resolve));
}
function releaseStoreSlot() {
  const next = storeWaiters.shift();
  if (next) next();   // 名额直接转交，active 计数不变
  else storeActive--;
}

// ---- 3) 原子落盘：先写临时文件、再改名 ----
// 同一卷上的改名是原子操作：写一半被杀/断电时最多留下一个 .tmp 残片，绝不会有
// 半截正文顶着正式文件名被当成好缓存命中。临时名以 .tmp 结尾（中间插进程号与毫秒
// 防并发互踩）—— 所有按扩展名扫描缓存的逻辑（统计、清理）都只认白名单扩展名，
// .tmp 残片天然被无视，不会污染缓存体积统计。
async function writeFileAtomically(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, filePath);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* 删不掉就留着，不碍事 */ }
    throw e;
  }
}

function writeCacheEntry(filePath, body, contentType, cors, urlQuery, upHeaders) {
  // 体检不过就不入库：响应照常回给浏览器（那是上游真实返回的东西），只是不把
  // 可疑内容写进缓存去污染之后的每一次命中。
  const verdict = isPlausibleAssetBody(body, contentType, path.extname(filePath).toLowerCase());
  if (!verdict.ok) {
    stats.rejected++;
    log(`[内容体检] 不入库 ${path.basename(filePath)}：${verdict.why}（响应照常返回浏览器）`);
    pushLog({ tag: 'SKIP', path: path.basename(filePath), source: 'content-guard', detail: verdict.why });
    return Promise.resolve();
  }

  const meta = {
    // ETag / Last-Modified：源站给了就记下来。命中时回放给浏览器（条件请求用）；
    // 源站没给就保持 null，老缓存文件不受影响。
    LastModified: (upHeaders && upHeaders['last-modified']) || null,
    ETag: (upHeaders && upHeaders.etag) || null,
    at: Math.floor(Date.now() / 1000),
    ce: '',
    ct: contentType || '',
    v: 1,
  };
  // CORS 头必须跟着文件一起存：命中缓存时也要原样回给浏览器，
  // 否则浏览器会以「缺 Access-Control-Allow-Origin」为由拒绝执行该脚本。
  if (cors && cors['access-control-allow-origin']) meta.cors = cors;
  // q：这份缓存是从哪个「带版本号的 URL」写下来的（游戏用 ?1729002592 这类参数标记资源版本）。
  // 命中时靠它比对：请求带查询串、且与这里存的不一致时，绝不能拿旧文件顶
  //（游戏会判定资源版本不符 → 「新しいバージョンがあります」→ 反复整页重载）。
  // 注意与上面的 v 区分：v 是 .ext 格式版本，q 是 URL 的查询串。
  if (urlQuery) meta.q = urlQuery;

  return acquireStoreSlot().then(async () => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      await writeFileAtomically(filePath, body);
      await writeFileAtomically(filePath + '.ext', Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
      stats.stored++;
      pushLog({ tag: 'STORE', path: path.basename(filePath), size: body.length, source: 'new' });
    } catch (e) {
      log(`写缓存失败 ${filePath}: ${e.message}`);
    } finally {
      releaseStoreSlot();
    }
  });
}

// 这份缓存能不能满足当前请求 —— 只管「版本号」这一件事：
//   · 请求不带查询串：可以。这类 URL 在游戏里等价于内容稳定的资源（老版本就是这么缓存的）。
//   · 请求带查询串：必须与写缓存时记下的完全一致。没记过 q 的（老缓存文件）一律不认 ——
//     宁可回源重下一次，也不拿可能过期的文件去顶。
function cacheEntryMatchesQuery(meta, query) {
  if (!query) return true;
  return !!(meta && meta.q) && meta.q === query;
}

// If-None-Match 请求头是否命中本地存的 ETag（V4.9.0，条件请求回 304 用）。
// 按规范：值可以是逗号分隔的列表，也可以是 `*`（资源存在即命中）；带 W/ 前缀的是
// 弱验证器，与强验证器不等值 —— 这里只做精确比对，弱比较一律不认（宁可多回 200，
// 不冒「内容其实变了却回 304」的险）。
function ifNoneMatchHits(inmHeader, etag) {
  if (!inmHeader || !etag) return false;
  const v = String(inmHeader).trim();
  if (v === '*') return true;
  for (const part of v.split(',')) {
    if (part.trim() === etag) return true;
  }
  return false;
}

function send(res, status, headers, body) {
  // 回显请求方 Origin，并允许携带凭据 —— 这样游戏页面的跨源 fetch/XHR 才能通过。
  // 注意：带凭据的请求里 `Access-Control-Allow-Headers: *` 按规范会被当成字面量 `*`，
  // 浏览器会判定预检失败，所以这里必须回显浏览器实际请求的头（没有就退化为 *）。
  const origin = res._acgpOrigin || '*';
  const reqHeaders = res._acgpReqHeaders || '';
  const h = Object.assign({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': reqHeaders || '*',
    'Access-Control-Expose-Headers': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  }, headers || {});
  if (origin !== '*') h['Access-Control-Allow-Credentials'] = 'true';
  if (res._acgpVary) h['Vary'] = res._acgpVary;
  res.writeHead(status, h);
  res.end(body);
}

// ------------------------------------------------------- CORS 头（不能丢）

// 源站对 CDN 资源会回显 CORS 头，实测：
//   GET prd-game-a-granbluefantasy.akamaized.net/assets/<ver>/js/main.js
//   带 Origin: https://game.granbluefantasy.jp
//   -> Access-Control-Allow-Origin: https://game.granbluefantasy.jp
//
// 而游戏的模块脚本一律带 crossorigin="anonymous"（requirejs.createNode 会给
// 每个 script 节点补上），页面在 game.granbluefantasy.jp、脚本在 CDN 上，
// 属于跨源 CORS 请求。这些头一旦在中间人这一层丢掉，脚本会被浏览器直接
// 拒绝执行；游戏又拿不到模块，就会按「资源版本不对」处理，弹出
// 「新しいバージョンがあります。更新します。」并整页重载 —— 表现为重载循环。
//
// 所以命中缓存和回源两条路径都必须把 CORS 头带回给浏览器。
const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-expose-headers',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'cross-origin-resource-policy',
  'timing-allow-origin',
];

// 组装本次响应的 CORS 头：
//   1) 源站给了就原样用（它本来就是按请求 Origin 回显的）；
//   2) 源站没给、但请求确实带 Origin（即跨源请求）时，按请求 Origin 回显，
//      与源站行为一致；这样修复前写入的老缓存不必重下也能恢复正常。
function corsHeaders(upHeaders, req) {
  const out = {};
  for (const k of CORS_HEADERS) {
    if (upHeaders && upHeaders[k]) out[k] = upHeaders[k];
  }
  if (!out['access-control-allow-origin']) {
    const origin = req && req.headers ? req.headers['origin'] : '';
    if (!origin) return out;
    out['access-control-allow-origin'] = origin;
    out['vary'] = 'Origin';
  }
  return out;
}

// 命中缓存时取 CORS 头：优先用写缓存时记下的，没有（老缓存）就现算
function corsHeadersForHit(meta, req) {
  if (meta && meta.cors && meta.cors['access-control-allow-origin']) {
    return Object.assign({}, meta.cors);
  }
  return corsHeaders(null, req);
}

// ---------------------------------------------------------------- 回源

// ---------------------------------------------------------------- 回源合并（V4.9.0）
//
// 同一资源同一版本的并发请求只放一个出网。背景：版本更新日整页加载时，游戏会几乎
// 同时请求同一批资源，冷缓存下每个重复请求都会真去源站排一次队 —— 上游连接池就那么
// 几个槽，重复请求是在白白挤占带宽和槽位。这里用一张「进行中」表把同一键的请求并成
// 一个：第一个出网（队首），其余等它的结果直接回放。等待者不写缓存（写入是队首那
// 一次的事），响应字节与队首完全一致。
//
// 键 = 主机 + 路径 + 查询串：查询串是资源版本，版本不同绝不能合并（拿别的版本顶会
// 触发「新しいバージョンがあります」重载循环，见 cacheEntryMatchesQuery 的说明）。
// 已知取舍：队首的请求头代表全体（静态资源的回放与请求头无关，实际风险可忽略）；
// 队首失败时等待者一并收到失败 —— 上游真挂了的话，各自重试也一样挂，还多排队。
const pendingOriginFetches = new Map();

async function fetchOriginShared(key, run) {
  const existing = pendingOriginFetches.get(key);
  if (existing) {
    stats.merged++;
    return Object.assign({}, await existing, { leader: false });
  }
  const job = (async () => {
    // V4.20.7：未命中回退下载同样算"关键路径在途"—— 后台（跟随/闲置缓扫）在此期间让路，
    // 连"确认已返回、正文还在下"的那几秒也不与它抢隧道连接池。
    criticalUpstreamInFlight++;
    try {
      const r = await run();
      return Object.assign({}, r, { leader: true });
    } finally {
      criticalUpstreamInFlight--;
    }
  })();
  pendingOriginFetches.set(key, job);
  try {
    return await job;
  } finally {
    pendingOriginFetches.delete(key);
  }
}

// 同一个资源可能只在其中某个主机上存在（页面外壳在 game.granbluefantasy.jp，
// 而绝大多数资源在 Akamai CDN 上）。扩展重定向时不会把原始主机告诉服务端，
// 所以回源时依次尝试，用第一个成功返回的。
const ORIGIN_HOSTS = [
  'game.granbluefantasy.jp',
  'prd-game-a-granbluefantasy.akamaized.net',
  'prd-game-a-gbf.akamaized.net',      // V4.14.4：英语树的 CDN（域名里没有 granbluefantasy）
];
// 预热用的候选主机：待核对的 JS/JSON 几乎都在 CDN 上，CDN 优先（V4.10.0）。
// V4.14.4 起**显式列出顺序**（原来是 reverse(ORIGIN_HOSTS)）—— 日语 CDN 仍是绝大多数场景，
// 放第一位；英语 CDN 第二；游戏本域兜底。别改回 reverse，否则英语主机被排到最前面，
// 每个日语文件都要先白试一次。
const PREWARM_HOSTS = [
  'prd-game-a-granbluefantasy.akamaized.net',
  'prd-game-a-gbf.akamaized.net',
  'game.granbluefantasy.jp',
];

async function fetchFromAnyOrigin(rest, query, reqHeaders) {
  const tried = [];
  let last = null;
  for (const h of ORIGIN_HOSTS) {
    // GBFCACHE_ORIGIN_BASE：仅供测试/排障的回源地址整体替换钩子（比如指向本地起的
    // 假源站）。日常运行不设置，行为一字不变 —— 它绝不该出现在生产环境里。
    const url = `${process.env.GBFCACHE_ORIGIN_BASE || 'https://' + h}${rest}${query}`;
    try {
      const up = await fetchUpstream(url, reqHeaders);
      tried.push(`${h} -> ${up.status}`);
      last = up;
      if (up.status === 200 && up.body.length > 0) return { up, url, tried };
    } catch (e) {
      tried.push(`${h} -> ${e.message}`);
    }
  }
  // 所有主机都没成功：把最后一个响应原样返回，让浏览器看到真实的错误码
  return { up: last, url: `https://${ORIGIN_HOSTS[0]}${rest}${query}`, tried };
}

// 按 HTTP 规范，逐跳头（hop-by-hop）不能被代理转发；
// 另外 Host 一律交给 Node 依据实际目标 URL 重算，避免把上游主机写错。
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

// ---------------------------------------------------------------- 回源速率（V4.14.12）
//
// 悬浮窗第 7 格要显示"现在正从源站拉多快"。口径：**线上的压缩字节**（requestUpstream
// 在解压前统计），滚动 10 秒窗口取每秒平均 —— 与真实网络流量对得上，而不是解压后的大小。
// 每条响应记一个样本，10 秒窗口内撑死几百条，无需上限防御。
// ⚠️ 位置纪律：这套函数**必须落在 test-retry.js 的切片范围内**
//（起点 = `const HOP_BY_HOP` 这一行，终点 = "缓存目录维护"分节注释）——
// requestUpstream 引用 noteOriginBytes，定义落到切片之外测试就 ReferenceError
//（V4.14.12 首版连摆错两次，都是闸门抓的：切片从 HOP_BY_HOP 那一行**开始**，
//  放在它上面=切片外，放在注释和它之间也=切片外）。
const ORIGIN_RATE_WINDOW_MS = 10000;
const originRateSamples = [];   // { t, bytes }

function noteOriginBytes(n) {
  if (!n) return;
  const now = Date.now();
  originRateSamples.push({ t: now, bytes: n });
  while (originRateSamples.length && now - originRateSamples[0].t > ORIGIN_RATE_WINDOW_MS) {
    originRateSamples.shift();
  }
}

function originRatePerSec() {
  const now = Date.now();
  while (originRateSamples.length && now - originRateSamples[0].t > ORIGIN_RATE_WINDOW_MS) {
    originRateSamples.shift();
  }
  let bytes = 0;
  for (const s of originRateSamples) bytes += s.bytes;
  return Math.round(bytes / (ORIGIN_RATE_WINDOW_MS / 1000));
}

// 组装发给源站的请求头：客户端的头**照搬**，只去掉逐跳头和 Host。
// 「原样转发」是这套代理能成立的前提（方法、请求头、请求体都不能改）——
// 之前这里只挑了 user-agent/accept/referer/origin/cookie 六个，
// 把 X-VERSION 这类游戏自定义头丢掉了，源站看到的就不是浏览器原本发的请求。
function upstreamHeaders(reqHeaders, override) {
  const out = {};
  for (const k of Object.keys(reqHeaders || {})) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === 'host') continue;
    out[lk] = reqHeaders[k];
  }
  return Object.assign(out, override || {});
}

// 单次回源的超时；重试预算要用到它，所以放在函数外
const UPSTREAM_TIMEOUT_MS = 8000;
// 「瞬时故障」名单 —— 只有这些才值得重试，逻辑类失败（4xx/5xx）是拿到了响应，不走这里。
// 注意 'upstream timeout' 是本模块**自己造**的超时错误串（见下面 r.on('timeout')）：
// 它曾经不在名单里（名单里写的是 socket 层的 ETIMEDOUT，实际很少出现），
// 结果就是「回源超时一次都不重试」。
const UPSTREAM_RETRYABLE = /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|upstream timeout|加速器代理/i;
// 「加速器这条链路本身坏了」：要立刻改直连，而不是在同一链路上一遍遍重试
const CHAIN_DEAD = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|加速器代理/i;
const UPSTREAM_MAX_ATTEMPTS = 2;        // 1 次原始 + 最多 1 次重试（V4.8.11 收紧）
const UPSTREAM_RETRY_DELAY_MS = 300;    // 瞬时故障的退避，避开对端刚重置完的窗口
const UPSTREAM_RETRY_BUDGET_MS = 20000; // 总耗时上限（V4.8.11）
// ---- V4.8.11：上面这几条是按「感知速度」重新定的，改之前先读这段 ----
// 背景：浏览器对每个源只开 6 条 HTTP/1.1 连接，**一个卡住的资源就占住一个槽**。
// 原来单次超时 20s、最多 3 次、总预算 45s —— 一个坏资源能占槽 40s 以上，只要有两三个
// 走到重试路径，整页加载就明显变慢（实测日志里出现过一行「已耗时 30622ms，放弃重试」）。
// 而真实资源 p50 只有 11KB、p99 不到 600KB，正常几百毫秒就该到 —— 20s 判超时太宽松。
// 注意：**预算必须 >= 2x 单次超时**，否则「超时后重试」会被静默取消（判据是
//   spent + 单次超时 > 预算 就放弃重试）。20s = 8s x 2 + 余量，正好留住这条行为 ——
//   它有 test-retry.js 的用例 3 专门钉着，别只改一个数就把它弄没了。

// 路由切换（加速器连上/断开、VPN 重连）会让**已建立的连接**失效：旧路由上建立的
// 空闲 socket 还躺在 agent 池里，下一次请求复用它就会 ECONNRESET / 一直等不到响应。
// 若重试又抓到另一条同样的死连接，就会连吃两次失败 —— 实测 2026-10-19 加速器接管
// 路由的十几分钟里，每条未命中资源都要 16 秒才回 502，而同一时刻新开连接直连是 200。
// 所以重试前先把空闲连接清空，让下一次尝试一定走新连接。
function dropIdleSockets(agent) {
  if (!agent || !agent.freeSockets) return 0;
  let n = 0;
  for (const key of Object.keys(agent.freeSockets)) {
    const list = agent.freeSockets[key];
    if (Array.isArray(list)) {
      for (const sock of list.slice()) {
        try { sock.destroy(); n++; } catch { /* 忽略 */ }
      }
    }
    delete agent.freeSockets[key];
  }
  return n;
}

// 下一次尝试会用哪个 agent：经加速器时是 chainAgent，否则是 Node 的全局 agent
function agentForRetry(isHttps, useChain) {
  if (isHttps && useChain) {
    const a = chainAgent();
    if (a) return a;
  }
  return isHttps ? https.globalAgent : http.globalAgent;
}

// 回源请求本体（是否经加速器由 useChain 决定）
function requestUpstream(targetUrl, reqHeaders, useChain, opts) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(targetUrl);
    } catch (e) {
      return reject(e);
    }

    // 只声明本模块解得了的编码。若把浏览器的 accept-encoding 原样带上去
    // （gzip, deflate, br, zstd），源站可能回 zstd，而这里解不开，
    // 结果是「压缩体 + 没有 Content-Encoding 头」直接发给浏览器。
    // ⚠️ 不要加 br（V4.14.6 试过、V4.14.7 撤回）：对真实源站实测
    // （prd-game-a-granbluefantasy.akamaized.net，2026-09-27）——
    //   · 单独发 br：源站不支持，回退成**不压缩的 identity**（同一 CSS 724KB vs gzip 71KB）；
    //   · 发 "gzip, deflate, br" 组合头：源站按规范回 gzip（无损失），但收益 = 0%。
    // 即 br 在这个源站上没有任何好处，只会留下一个"依赖对方永远礼貌协商"的变量。
    // 源站哪天真支持了 br，再实测再加。
    const headers = upstreamHeaders(reqHeaders, {
      'accept-encoding': 'gzip, deflate',
    });
    if (!headers['user-agent']) headers['user-agent'] = 'Mozilla/5.0';
    if (!headers['accept']) headers['accept'] = '*/*';

    const mod = u.protocol === 'http:' ? http : https;
    // 方案 C：配好上游代理（加速器）时，HTTPS 回源经它的 CONNECT 隧道出去
    const chain = useChain && u.protocol === 'https:' ? chainAgent() : null;
    const r = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'GET',
      headers,
      // hosts 模式下的回源必须绕开系统 hosts（否则被指回 127.0.0.1 形成死循环，见那一节说明）。
      // 不在该模式下时它只是个透传的 dns.lookup。用 chainAgent 时本项会被 agent 的
      // createConnection 覆盖（走隧道），那时不需要它 —— 两者不会同时是"必须绕开"的场景。
      lookup: hostsModeLookup,
      // agent 为 undefined（未配加速器时的直连）= Node 默认全局 agent：Node 19+ 自带
      // keep-alive 连接复用（实测 3 个请求 1 条连接，见 b2-agent-reuse-probe.js）——
      // 直连回源的握手开销已经由它省掉，不要再「补」一个自建 agent。
      // forwardTransparent 那条路显式 agent:false 是另一回事（它转发的是页面/接口，
      // 曾被源站单方面关闭的池化连接坑出 90 秒挂死），别把两条路的取舍混为一谈。
      agent: chain || undefined,
      // P0-5：迁移等短预算路径可覆盖单次超时（migrateFetch 传 timeoutMs: 2000）；
      // 缺省仍是 8 秒 —— 前台回源的取舍见上面 V4.8.11 那段，别只改一个数。
      timeout: (opts && opts.timeoutMs) || UPSTREAM_TIMEOUT_MS,
    }, (up) => {
      // 正文剥离（V4.15.9，预热省流）：判定函数认定「这具正文不会被人用」时，
      // 头部一到手就 resolve 并掐断连接 —— 200 的整包正文不再下完才扔。
      // 注意判定只看状态码与响应头；被剥的响应走不到 'end'，noteOriginBytes 少记的
      // 字节近似为 0（掐断前只收到头部），对回源速率统计的影响可忽略。
      if (opts && typeof opts.dropBody === 'function' && opts.dropBody(up.statusCode, up.headers)) {
        resolve({ status: up.statusCode, headers: up.headers, body: Buffer.alloc(0), bodyDropped: true });
        up.on('error', () => {});   // 主动掐断会让这条连接报错，不能炸成未捕获异常
        up.destroy();
        return;
      }
      const chunks = [];
      let rawBytes = 0;
      up.on('data', (c) => { chunks.push(c); rawBytes += c.length; });
      up.on('end', () => {
        noteOriginBytes(rawBytes);   // 回源速率（V4.14.12）：记线上压缩字节，口径见 noteOriginBytes
        let body = Buffer.concat(chunks);
        const enc = String(up.headers['content-encoding'] || '').toLowerCase();
        if (enc.includes('gzip')) {
          try { body = zlib.gunzipSync(body); } catch {}
        } else if (enc.includes('deflate')) {
          try { body = zlib.inflateSync(body); } catch {}
        } else if (enc.includes('br')) {
          try { body = zlib.brotliDecompressSync(body); } catch {}
        }
        resolve({
          status: up.statusCode,
          headers: up.headers,
          body,
        });
      });
    });

    r.on('timeout', () => { r.destroy(new Error('upstream timeout')); });
    r.on('error', reject);
    r.end();
  });
}

// 回源：默认可能经加速器；失败按「瞬时故障」重试（回源都是 GET，可安全重放）。
//   · 连不上加速器代理 -> 立刻改直连重试（这一跳本身就是在缩短链路，不必等退避）
//   · 其余瞬时故障（源站重置、超时）-> 同链路重试，退避 300ms
// 两道上限是为了「网络真断了」时不把用户晾太久：次数上限 + 45 秒总预算
// （单次超时 20s，所以若下一次尝试可能把总耗时顶过预算，就直接放弃）。
function fetchUpstream(targetUrl, reqHeaders, allowChain, opts) {
  const useChain = allowChain !== false;
  const startedAt = Date.now();
  let attemptNo = 0;

  const attempt = (allowChainNow) => {
    attemptNo++;
    // 本次是否**真的**会经加速器：没配上游代理、或刚失败进了 60 秒旁路窗口时，
    // chainAgent() 返回 null —— 那这次其实就是直连，日志不能再说「改直连」。
    const chained = allowChainNow && /^https:/i.test(targetUrl) && !!chainAgent();
    return requestUpstream(targetUrl, reqHeaders, allowChainNow, opts).catch((e) => {
      const msg = String((e && e.message) || e);
      if (!UPSTREAM_RETRYABLE.test(msg)) throw e;
      if (attemptNo >= UPSTREAM_MAX_ATTEMPTS) {
        log(`[回源] 连续 ${attemptNo} 次失败（${msg}），不再重试`);
        throw e;
      }
      if (chained && CHAIN_DEAD.test(msg)) {
        const dropped = dropIdleSockets(agentForRetry(/^https:/i.test(targetUrl), false));
        if (dropped) log(`[回源] 已丢弃 ${dropped} 条空闲连接 —— 改直连重试（${msg}）`);
        log(`[上游代理] 回源失败（${msg}），改直连重试`);
        return attempt(false);
      }
      const spent = Date.now() - startedAt;
      if (spent + UPSTREAM_TIMEOUT_MS > UPSTREAM_RETRY_BUDGET_MS) {
        log(`[回源] 已耗时 ${spent}ms（${msg}），再试可能超出预算，放弃重试`);
        throw e;
      }
      // 只在「连接级」故障上清池：逻辑类失败（拿到响应后出错）与连接是否还有效无关
      if (/ECONNRESET|EPIPE|socket hang up|upstream timeout/i.test(msg)) {
        const dropped = dropIdleSockets(agentForRetry(/^https:/i.test(targetUrl), allowChainNow));
        if (dropped) log(`[回源] 已丢弃 ${dropped} 条空闲连接，重试走新连接（${msg}）`);
      }
      log(`[回源] ${msg} —— ${UPSTREAM_RETRY_DELAY_MS}ms 后重试（第 ${attemptNo + 1}/${UPSTREAM_MAX_ATTEMPTS} 次）`);
      return new Promise((r) => setTimeout(r, UPSTREAM_RETRY_DELAY_MS)).then(() => attempt(allowChainNow));
    });
  };

  return attempt(useChain);
}

// ---------------------------------------------------------------- 缓存目录维护

// 测试目录可写性 + 报告可用空间
function testCacheWrite() {
  const out = { root: CACHE_ROOT, exists: false, created: false, writable: false, freeBytes: null, errors: [] };

  try {
    if (fs.existsSync(CACHE_ROOT)) {
      out.exists = true;
    } else {
      fs.mkdirSync(CACHE_ROOT, { recursive: true });
      out.exists = true;
      out.created = true;
    }
  } catch (e) {
    out.errors.push(`无法创建目录：${e.message}`);
    return out;
  }

  const tmp = path.join(CACHE_ROOT, `__write_test_${Date.now()}.tmp`);
  out.testFile = tmp;
  try {
    fs.writeFileSync(tmp, 'gbftest');
    out.writable = fs.readFileSync(tmp, 'utf8') === 'gbftest';
    fs.unlinkSync(tmp);
  } catch (e) {
    out.errors.push(`写入测试失败：${e.message}`);
  }

  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(CACHE_ROOT);
      out.freeBytes = st.bavail * st.bsize;
    }
  } catch { /* 部分平台/文件系统不支持，忽略 */ }

  return out;
}

// 给候选样本打分：分越低越优先。
// 依据是对源站的实测 —— 未带版本号的稳定目录（img / font / sound/bgm）现在仍能取到，
// 而带版本号的目录（assets/1234567890/…）和 sound/voice 下的文件多已被下架。
// 拿已被下架的文件做测试会得到 404，从而误判成「缓存功能坏了」。
function sampleScore(rel) {
  // 依据对源站的实测：字体与 BGM 这类长期资源现在仍能取到；
  // 带版本号的目录和 sound/voice 下的文件多已被官方下架；
  // img 目录则好坏参半，所以排在字体/BGM 之后。
  if (/^assets\/\d+\//.test(rel)) return 5;              // 版本化目录，基本已下架
  if (rel.startsWith('assets/sound/voice/')) return 4;   // 语音文件经常被清理
  if (rel.startsWith('assets/font/')) return 0;          // 最稳定
  if (rel.startsWith('assets/sound/bgm/')) return 1;     // 很稳定
  if (/^assets\/(img|img_low|img_mid)\//.test(rel)) return 2;
  if (rel.startsWith('assets/')) return 3;
  return 6;                                              // 根目录下的杂项
}

// 挑几个体积较小的资源文件作为测试候选，优先选源站仍在提供的稳定路径
function findSmallCachedFiles(maxBytes, limit) {
  const byBucket = new Map();
  const stack = [CACHE_ROOT];
  let guard = 0;

  while (stack.length && guard++ < 100000) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.name.endsWith('.ext')) continue;
      if (!CACHEABLE_EXT.has(path.extname(e.name).toLowerCase())) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.size || st.size > maxBytes) continue;

      const rel = path.relative(CACHE_ROOT, full).split(path.sep).join('/');
      // 按所在目录分桶，每桶只留体积最小的一个。
      // 否则「取遍历中最早遇到的若干个」很容易整批落在同一子目录
      //（比如全是 sound/voice 下的语音，而它们多已被官方下架）。
      const parts = rel.split('/');
      const bucket = parts.slice(0, Math.max(1, parts.length - 1)).join('/');
      const prev = byBucket.get(bucket);
      if (!prev || st.size < prev.size) {
        byBucket.set(bucket, { full, rel, size: st.size, score: sampleScore(rel) });
      }
    }
  }

  // 按打分排序，然后跨目录轮流取，保证候选分散在不同类型资源上；
  // 同一目录里如果第一个样本恰好在源站已下架，还有别的目录可以顶上。
  const buckets = Array.from(byBucket.values());
  buckets.sort((a, b) => (a.score - b.score) || (a.size - b.size));

  const out = [];
  const seen = new Set();
  for (const b of buckets) {
    const key = b.rel.split('/').slice(0, 3).join('/');
    if (seen.has(key) && out.length >= Math.ceil(limit / 2)) continue;
    seen.add(key);
    out.push(b);
    if (out.length >= limit) break;
  }
  return out;
}

// 走一次真实的「删除 -> 回源 -> 重新写入」闭环，验证缓存能不能正常增长。
// 测试对象会被备份，万一失败会还原，不会毁掉原有缓存。
// 对单个样本做一次「删除 -> 回源 -> 重新写入」闭环验证。
// 样本会先备份，任何一步失败都会还原，不会毁掉原有缓存。
function testOneSample(cand) {
  return new Promise((resolve) => {
    const target = cand.full;
    const out = { ok: false, sample: '/' + cand.rel, bytes: cand.size, steps: [], error: null, gotResponse: false };
    const step = (s) => out.steps.push(s);

    let bodyBackup, extBackup, extExisted;
    try {
      bodyBackup = fs.readFileSync(target);
      extExisted = fs.existsSync(target + '.ext');
      extBackup = extExisted ? fs.readFileSync(target + '.ext') : null;
    } catch (e) {
      out.error = `备份失败：${e.message}`;
      return resolve(out);
    }

    const restore = () => {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bodyBackup);
        if (extExisted && extBackup) fs.writeFileSync(target + '.ext', extBackup);
        step('已从备份还原原文件');
      } catch (e) { out.error = `还原失败：${e.message}`; }
    };

    try {
      fs.unlinkSync(target);
      if (extExisted) { try { fs.unlinkSync(target + '.ext'); } catch { /* 忽略 */ } }
      step('已删除样本文件，制造缓存未命中');
    } catch (e) {
      out.error = `删除失败：${e.message}`;
      return resolve(out);
    }

    const finish = (status) => {
      out.gotResponse = true;
      step(`通过本服务请求，返回 HTTP ${status}`);
      if (status !== 200) {
        out.error = `回源未成功（HTTP ${status}）`;
        restore();
        return resolve(out);
      }
      if (!fs.existsSync(target)) {
        out.error = '回源成功但没有写入缓存文件 —— 目录可能不可写';
        return resolve(out);
      }
      const now = fs.readFileSync(target);
      out.rewrittenBytes = now.length;
      out.writtenPath = target;                       // 完整落地路径，便于用户确认写到了哪
      out.extWritten = fs.existsSync(target + '.ext');
      step(`已重新写入缓存（${now.length} 字节，元数据文件${out.extWritten ? '已生成' : '缺失'}）`);

      try {
        const { body } = readCacheEntry(target);
        if (body.length > 0) {
          out.ok = true;
          step('内容校验通过 —— 回源与写盘链路都正常');
        } else {
          out.error = '写入的文件读不出有效内容';
        }
      } catch (e) {
        out.error = `读取校验失败：${e.message}`;
      }
      if (!out.ok) restore();
      resolve(out);
    };

    // 同样注意：cand.rel 已含 assets/ 前缀
    const url = `http://${HOST}:${PORT}/${cand.rel}`;
    const req = http.get(url, (resp) => {
      resp.resume();
      resp.on('end', () => finish(resp.statusCode));
    });
    req.on('error', (e) => { out.error = `请求失败：${e.message}`; restore(); resolve(out); });
    req.setTimeout(30000, () => { req.destroy(new Error('请求超时')); });
  });
}

// 完整流程测试：挑几个样本逐个试，任一成功即说明「缓存能正常增长」。
// 之所以要多个样本：缓存里可能混着源站已下架的杂项文件，单一样本失败不代表功能有问题。
async function testCacheCycle() {
  const out = { ok: false, steps: [], errors: [], tried: [], sawHttpResponse: false };
  const step = (s) => { out.steps.push(s); log(`[缓存测试] ${s}`); };

  const cands = findSmallCachedFiles(512 * 1024, 30);
  if (!cands.length) {
    out.errors.push('缓存目录里找不到体积较小的资源文件，无法测试（目录是空的？）');
    return out;
  }
  step(`候选样本 ${cands.length} 个，开始逐个向源站确认哪些仍在提供…`);

  // 关键：先确认样本在源站上确实还能取到，再拿它做删除/回源测试。
  // 缓存里混着大量早已被官方下架的老资源（版本化的 js/css、旧语音等），
  // 直接拿去测会得到 404，从而把「功能正常」误报成「功能坏了」。
  let live = null;
  for (const c of cands) {
    out.tried.push('/' + c.rel);
    try {
      // 注意：c.rel 形如 "assets/font/x.woff"，本身就带 assets/ 前缀，不要再拼一次
      const up = await fetchUpstream('https://game.granbluefantasy.jp/' + c.rel, {});
      out.sawHttpResponse = true;
      if (up.status === 200 && up.body.length > 0) {
        live = c;
        step(`选定样本 ${c.rel}（${c.size} 字节）—— 源站返回 200，仍可下载`);
        break;
      }
    } catch (e) {
      step(`样本 ${c.rel} 探测失败（${e.message}）`);
    }
  }

  if (!live) {
    if (out.sawHttpResponse) {
      out.errors.push('源站可以连上，但试过的这些老缓存文件都已被官方下架（HTTP 404）。' +
        '这不影响你已缓存资源的使用 —— 想验证下载能力，可以在游戏里打开一张没进过的关卡。');
    } else {
      out.errors.push('连不上游戏源站 —— 请检查你的网络 / 加速器是否正常。');
    }
    return out;
  }

  const r = await testOneSample(live);
  r.steps.forEach(step);
  out.ok = r.ok;
  out.sample = r.sample;
  out.sampleBytes = r.bytes;
  out.rewrittenBytes = r.rewrittenBytes;
  out.extWritten = r.extWritten;
  out.writtenPath = r.writtenPath;
  if (!r.ok && r.error) out.errors.push(r.error);
  return out;
}

// ---------------------------------------------------------------- 诊断一键导出（V4.14.10）
//
// 排障时最缺的是"现场"。这个入口把散在各处的证据打成一个 zip 交给用户：
//   meta.txt          时间 / 版本 / 运行时长 / 缓存目录（人能一眼读懂的摘要）
//   health.json       /health 同款快照（含内存读数与最近错误）
//   stats.json        /api/stats 同款快照（含证书状态、系统代理、探测明细）
//   request-log.json  最近请求环形缓冲全量（最多 400 条）
//   server-tail.log   服务日志尾部（最后 256KB）
//   tray-tail.log     托盘日志尾部（最后 64KB，存在才带）
//   config.json       活配置（只有路径与开关，没有凭据）
// 打包用系统自带 tar.exe（-a 按扩展名出 zip），零依赖；包内文件名全 ASCII，避免编码坑。
// 输出目录：默认用户桌面（PowerShell GetFolderPath 解析，能正确处理 OneDrive 重定向）；
// GBFCACHE_EXPORT_DIR 可覆盖 —— 自测用，绝不把测试产物写进真实桌面。
let diagDesktop = '';

async function exportDiagnostics() {
  const out = { ok: false, files: [] };
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = String(d.getFullYear()) + p2(d.getMonth() + 1) + p2(d.getDate())
    + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  const tmpDir = path.join(LOG_DIR, 'diag-' + stamp + '-' + process.pid);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const w = (name, data) => { fs.writeFileSync(path.join(tmpDir, name), data); out.files.push(name); };

    w('meta.txt', [
      '导出时间 : ' + d.toISOString(),
      '程序版本 : ' + VERSION,
      '运行时长 : ' + Math.floor((Date.now() - startedAt) / 1000) + ' 秒',
      '缓存目录 : ' + CACHE_ROOT,
      '运行环境 : Node ' + process.version + ' / ' + process.platform,
    ].join('\r\n') + '\r\n');

    w('health.json', JSON.stringify({
      ok: true, cacheRoot: CACHE_ROOT, cacheRootExists: fs.existsSync(CACHE_ROOT),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      stats, recentErrors, lastProbeAt,
      systemProxy: systemProxyInfo(), upstreamProbe: upstreamProbeInfo(),
      mem: process.memoryUsage(),
    }, null, 2));

    w('stats.json', JSON.stringify(await buildStatsPayload(), null, 2));
    w('request-log.json', JSON.stringify(requestLog, null, 2));

    const tailFile = (file, name, maxBytes) => {
      try {
        const st = fs.statSync(file);
        const start = Math.max(0, st.size - maxBytes);
        const buf = Buffer.alloc(st.size - start);
        const fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        w(name, buf);
      } catch { /* 没有这份日志就算了，导出不因它失败 */ }
    };
    tailFile(LOG_FILE, 'server-tail.log', 256 * 1024);
    tailFile(path.join(LOG_DIR, 'tray.log'), 'tray-tail.log', 64 * 1024);
    try { w('config.json', fs.readFileSync(CONFIG_FILE)); } catch { /* 没有配置文件就算了 */ }

    let dir = String(process.env.GBFCACHE_EXPORT_DIR || '').trim();
    if (!dir) {
      // 桌面路径每进程只解析一次（PowerShell 启动要几百毫秒，而桌面对同一用户基本不变）
      if (!diagDesktop) {
        diagDesktop = await new Promise((resolve) => {
          require('child_process').execFile('powershell.exe',
            ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"],
            { timeout: 15000, windowsHide: true, encoding: 'utf8' },
            (e, so) => resolve(e ? '' : String(so || '').trim()));
        });
      }
      dir = diagDesktop || path.join(process.env.USERPROFILE || '', 'Desktop');
    }
    fs.mkdirSync(dir, { recursive: true });
    const zipName = 'GBFCache-diagnostics-' + VERSION + '-' + stamp + '.zip';
    const zipPath = path.join(dir, zipName);
    try { fs.unlinkSync(zipPath); } catch { /* 本来就没有 */ }
    await new Promise((resolve) => {
      require('child_process').execFile('tar', ['-a', '-c', '-f', zipName, '-C', tmpDir].concat(out.files),
        // ⚠️ cwd 必须设在输出目录、-f 只给**相对文件名**：bsdtar 会把 "-f C:\..." 里的
        // "C:" 当成 rsh 语法的远程主机名（实测报 "Cannot connect to C: resolve failed"）。
        // -C 的路径是纯 chdir、不走那套解析，绝对路径可以放心用。
        { timeout: 30000, windowsHide: true, cwd: dir }, (e, so, se) => {
          if (e) out.error = String(se || e.message);
          resolve();
        });
    });
    if (fs.existsSync(zipPath)) { out.ok = true; out.zip = zipPath; out.dir = dir; }
    else out.error = out.error || 'tar 没有产出 zip 文件';
    return out;
  } catch (e) {
    out.error = out.error || e.message;
    return out;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清不掉就留着，不碍事 */ }
  }
}

// 弹一个 Windows 原生文件夹选择框（服务本身是隐藏窗口，所以单独起进程让它能显示）
// ------------------------------------------------------- 路径选择器（常驻宿主，V4.6.2）
//
// 过去每点一次「浏览…」都新起一个 powershell.exe 去弹 WinForms 对话框。实测（本机热态中位数）：
//     进程启动 619ms  ->  加载 WinForms 903ms  ->  真的弹出对话框 1149ms
// 也就是说这 1.1 秒里九成是"重新起进程 + 重新加载程序集"，窗口本身只占约 250ms ——
// 用户感受到的就是"点了半天才出来"。而**同一个进程里弹第二次几乎不额外花时间**，
// 所以这里让一个宿主进程常驻：启动一次、加载一次 WinForms，之后来一个请求弹一个窗。
//
// 三条自律（少一条都可能变成新的麻烦）：
//   · 懒启动：不是程序一开就起 —— 用户真去点「浏览…」才起；不用这个功能的人不背那 70MB；
//   · 空闲回收：10 分钟没人用就关掉（内存还给系统），下次用再起；
//   · 失败回退：宿主起不来 / 被安全软件杀掉 / 超时 —— 一律退回原来的"一次性进程"做法，
//     宁可慢回 1 秒，也不能让功能整个失效。
// 环境变量 GBFCACHE_PICKER_HOST=0 可强制只用老办法（排查问题时有用）。
const PICKER_HOST_SCRIPT = path.join(__dirname, 'picker-host.ps1');
const PICKER_HOST_ENABLED = String(process.env.GBFCACHE_PICKER_HOST || '1') !== '0';
const PICKER_IDLE_MS = 10 * 60 * 1000;      // 空闲多久回收宿主
const PICKER_REQ_TIMEOUT_MS = 5 * 60 * 1000; // 单个请求上限（对话框可能被用户开着很久）
let picker = null;

function pickerLog(m) { log('[选择器] ' + m); }

function pickerStart() {
  if (!PICKER_HOST_ENABLED) return null;
  if (!fs.existsSync(PICKER_HOST_SCRIPT)) {
    pickerLog('宿主脚本不存在（' + PICKER_HOST_SCRIPT + '），继续用一次性进程');
    return null;
  }
  const { spawn } = require('child_process');
  let proc;
  try {
    proc = spawn('powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', PICKER_HOST_SCRIPT],
      // windowsHide 只隐藏控制台窗口，不影响 WinForms 对话框（GUI 窗口照常显示）。
      // 这里曾经踩过：写 false 时发行版（GUI 子系统、没有控制台可继承）会自己新建一个
      // **可见**的 PowerShell 黑框，表现为"每次选目录都弹个黑窗口"。
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    pickerLog('启动失败：' + e.message + ' —— 回退到一次性进程');
    return null;
  }

  const p = { proc, ready: false, busy: false, current: null, queue: [], lastUse: Date.now(), buf: '' };
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    p.buf += chunk;
    let i;
    while ((i = p.buf.indexOf('\n')) >= 0) {
      const line = p.buf.slice(0, i).replace(/\r$/, '');
      p.buf = p.buf.slice(i + 1);
      pickerOnLine(p, line);
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (c) => {
    const t = String(c).trim();
    if (t) pickerLog('宿主 stderr：' + t.slice(0, 300));
  });
  proc.on('error', (e) => pickerLog('宿主进程错误：' + e.message));
  proc.on('exit', (code) => {
    pickerLog('宿主已退出（code=' + code + '）—— 下次点选会重新启动');
    if (picker === p) picker = null;
    if (p.reap) { clearInterval(p.reap); p.reap = null; }
    // 正在等的那个请求当作"宿主不可用"，由调用方回退到一次性进程
    if (p.current) {
      clearTimeout(p.current.timer);
      const cb = p.current.cb;
      p.current = null;
      p.busy = false;
      cb(null);
    }
    while (p.queue.length) p.queue.shift().cb(null);
  });
  // 空闲回收：宿主自己不知道"多久没人用"（ReadLine 是阻塞的），由父进程看着表
  p.reap = setInterval(() => {
    if (!picker || picker !== p) return;
    if (p.busy || p.queue.length) return;
    if (Date.now() - p.lastUse < PICKER_IDLE_MS) return;
    pickerStop('空闲超过 ' + Math.round(PICKER_IDLE_MS / 60000) + ' 分钟，释放约 70MB');
  }, 60000);
  if (p.reap.unref) p.reap.unref();
  // 兜底：宿主迟迟不就绪（被安全软件卡住、脚本启动时出错卡在别处）就主动收掉它。
  // 不收的话它会一直挂着占约 70MB，而且因为"进程还活着"，下次点选仍会落到回退路径上
  // —— 功能正常但永远慢，属于最难发现的那种退化。
  p.readyTimer = setTimeout(() => {
    if (picker === p && !p.ready) pickerStop('启动超时（30 秒未就绪）—— 点选继续走一次性进程');
  }, 30000);
  if (p.readyTimer.unref) p.readyTimer.unref();
  return p;
}

function pickerOnLine(p, line) {
  const s = String(line || '').trim();
  if (!s) return;
  if (s === 'READY') {
    p.ready = true;
    if (p.readyTimer) { clearTimeout(p.readyTimer); p.readyTimer = null; }
    pickerLog('宿主就绪（首次点选后常驻，后续弹窗不再等进程启动）');
    pickerPump(p);
    return;
  }
  if (s === 'PONG') {
    if (p.current && p.current.cmd === 'PING') pickerAnswer(p, 'PONG');
    return;
  }
  if (!p.current) { pickerLog('收到无人认领的输出：' + s.slice(0, 120)); return; }
  pickerAnswer(p, s);
}

function pickerAnswer(p, answer) {
  const item = p.current;
  if (!item) return;
  clearTimeout(item.timer);
  p.current = null;
  p.busy = false;
  item.cb(answer);
  pickerPump(p);
}

function pickerPump(p) {
  if (!p || p.busy || !p.ready || !p.queue.length) return;
  const item = p.queue.shift();
  p.current = item;
  p.busy = true;
  p.lastUse = Date.now();
  item.timer = setTimeout(() => {
    // 超时：对话框可能被晾着，但也不能无限等 —— 当作失败，让调用方回退
    pickerLog('请求超时（' + Math.round(PICKER_REQ_TIMEOUT_MS / 1000) + 's）：' + item.cmd.slice(0, 60));
    const cb = item.cb;
    p.current = null;
    p.busy = false;
    cb(null);
    pickerPump(p);
  }, PICKER_REQ_TIMEOUT_MS);
  try {
    p.proc.stdin.write(item.cmd + '\n', 'utf8');
  } catch (e) {
    pickerLog('写入失败：' + e.message);
    clearTimeout(item.timer);
    p.current = null;
    p.busy = false;
    item.cb(null);
  }
}

// 交给宿主去弹窗。返回 false = 这次别指望宿主（还没起来 / 起好了又坏了 / 被禁用），
// 调用方应当立刻走一次性进程那条路 —— 关键点：**第一次点选不等宿主**。
// 为什么（实测踩过）：宿主首次启动要 0.9 秒（起进程 + 加载 WinForms），遇到安全软件扫描新脚本
// 或机器繁忙时能拖到十几秒（本机真出现过一次 15 秒）。若让第一次点选排队等它，用户看到的就是
// "点了半天没反应"，比优化前还糟。所以这里只"顺手把宿主热起来"，本次请求仍走老路
// （耗时与优化前相同），下一次点选才是快的（约 0.25 秒）。
function pickerRequest(cmd, cb) {
  if (!PICKER_HOST_ENABLED) return false;
  const healthy = picker && picker.ready && picker.proc.exitCode === null;
  if (!healthy) {
    if (!picker || picker.proc.exitCode !== null) picker = pickerStart();   // 预热，但不阻塞本次请求
    // 记一条：这一条是排查"为什么点选还是慢"的关键 —— 有它就知道这次走了回退路径
    pickerLog('宿主未就绪（' + (picker ? '启动中' : '不可用') + '），本次点选走一次性进程');
    return false;
  }
  // 宿主正忙（用户在拖着上一个对话框）时**不排队**：排队意味着第二次点选要等前一个窗口关掉，
  // 极端情况下要等好几分钟（请求上限 5 分钟），用户看到的是"点了没反应"。
  // 直接回退到一次性进程 —— 立刻就能弹出第二个窗口，两个窗口互不干扰。
  if (picker.busy) {
    pickerLog('宿主正忙（上一个对话框还开着），本次点选另起一个进程');
    return false;
  }
  picker.lastUse = Date.now();
  picker.queue.push({ cmd, cb, timer: null, at: Date.now() });
  pickerPump(picker);
  return true;
}

// 停掉宿主（空闲回收、诊断、测试都用它）。下次点选会重新懒启动。
function pickerStop(reason) {
  if (!picker) return false;
  const p = picker;
  picker = null;
  if (p.reap) { clearInterval(p.reap); p.reap = null; }
  if (p.readyTimer) { clearTimeout(p.readyTimer); p.readyTimer = null; }
  if (p.current) {
    clearTimeout(p.current.timer);
    const cb = p.current.cb;
    p.current = null;
    p.busy = false;
    cb(null);          // 当作"宿主不可用"，调用方回退到一次性进程
  }
  while (p.queue.length) p.queue.shift().cb(null);
  pickerLog('宿主已停止' + (reason ? '（' + reason + '）' : ''));
  try { p.proc.stdin.end(); p.proc.kill(); } catch { /* 忽略 */ }
  return true;
}

// 宿主还活着吗 + 一次往返多少毫秒（给 /api/picker-status 用，排查"点选很慢"时先看这里）
// starting=true 表示"正在启动/加载中"—— 那期间的第一次点选仍走老办法，属正常。
function pickerStatus(cb) {
  const alive = !!(picker && picker.proc.exitCode === null);
  const base = {
    enabled: PICKER_HOST_ENABLED,
    running: !!(alive && picker.ready),
    starting: !!(alive && !picker.ready),
    busy: !!(alive && picker.busy),
    idleSec: picker ? Math.round((Date.now() - picker.lastUse) / 1000) : null,
    hostPid: picker ? picker.proc.pid : null,
  };
  if (!base.running) return cb(Object.assign(base, { pingMs: null }));
  const t0 = Date.now();
  if (!pickerRequest('PING', () => cb(Object.assign(base, { pingMs: Date.now() - t0 })))) {
    cb(Object.assign(base, { running: false, pingMs: null }));
  }
}

// 把宿主/一次性进程的返回统一成 cb(path, error|null)
function pickAnswerToCb(answer, cb) {
  if (answer === 'CANCEL') return cb(null, null);
  if (answer.indexOf('ERR|') === 0) return cb(null, answer.slice(4));
  if (answer.indexOf('OK|') === 0) return cb(answer.slice(3), null);
  cb(null, '选择器返回了无法识别的结果：' + String(answer).slice(0, 120));
}

function browseFolder(cb) {
  const cmd = 'FOLDER|' + String(CACHE_ROOT) + '|选择缓存文件所在目录';
  if (pickerRequest(cmd, (ans) => {
    if (ans === null) return browseFolderOnce(cb);   // 宿主不可用 -> 回退
    pickAnswerToCb(ans, cb);
  })) return;
  browseFolderOnce(cb);
}

// 老办法：每次新起一个 powershell。宿主不可用时才走这里（慢约 900ms，但功能不失效）。
function browseFolderOnce(cb) {
  const { execFile } = require('child_process');
  const ps = [
    // 重定向的 stdout 上 PowerShell 默认按控制台编码（中文系统是 GBK）输出，
    // 而 Node 按 UTF-8 解 —— 不显式设成 UTF-8 的话，带中文的路径（D:\GBF缓存）会变成乱码。
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = '选择缓存文件所在目录'",
    "$d.ShowNewFolderButton = $true",
    "$d.SelectedPath = '" + String(CACHE_ROOT).replace(/'/g, "''") + "'",
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write("OK|" + $d.SelectedPath) } else { [Console]::Out.Write("CANCEL") }',
  ].join('; ');

  execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps],
    { timeout: 180000, windowsHide: true },
    (err, stdout) => {
      if (err) return cb(null, err.message);
      pickAnswerToCb(String(stdout || '').trim(), cb);
    });
}

// 弹一个 Windows 原生「选择 exe 文件」对话框（供「启动加速器」/「启动游戏」的自定义路径用）
function browseFile(cb, title) {
  const cmd = 'FILE|' + String(CACHE_ROOT) + '|'
    + String(title || '选择加速器主程序（exe）').replace(/\|/g, ' ')
    + '|可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*';
  if (pickerRequest(cmd, (ans) => {
    if (ans === null) return browseFileOnce(cb, title);
    pickAnswerToCb(ans, cb);
  })) return;
  browseFileOnce(cb, title);
}

function browseFileOnce(cb, title) {
  const { execFile } = require('child_process');
  const ps = [
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$f = New-Object System.Windows.Forms.OpenFileDialog',
    "$f.Title = '" + String(title || '选择加速器主程序（exe）').replace(/'/g, "''") + "'",
    "$f.Filter = '可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*'",
    'if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write("OK|" + $f.FileName) } else { [Console]::Out.Write("CANCEL") }',
  ].join('; ');

  execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps],
    { timeout: 180000, windowsHide: true },
    (err, stdout) => {
      if (err) return cb(null, err.message);
      pickAnswerToCb(String(stdout || '').trim(), cb);
    });
}

// 「启动加速器」的目标 exe：config.json 的 "acceleratorPath"。
// 纯通用 —— 不内置任何软件的路径；没配置就是没配置，界面会引导用户去 ⚙ 选择。
function acceleratorPath() {
  return String(config.acceleratorPath || '').trim();
}

// 「启动游戏」的目标程序：config.json 的 "gameLaunchPath"（V4.5.0 新增）。
// 空 = 用系统默认浏览器打开（老行为，默认就是它）；非空 = 启动这个 exe 并把游戏 URL 作为参数传给它
//（所以它通常是某个指定浏览器的 exe，也可以是任何自己写的启动包装程序）。
function gameLaunchPath() {
  return String(config.gameLaunchPath || '').trim();
}

// 「打开控制台」用哪个浏览器：config.json 的 "consoleBrowserPath"（V4.21.0 新增）。
// 空 = 老行为（优先 Edge 应用模式，找不到 Edge 再用系统默认浏览器）；非空 = 用这个 exe，
// 同样优先走 Chromium 的 --app= 无地址栏窗口。Firefox 系没有 --app=，只传 URL。
function consoleBrowserPath() {
  return String(config.consoleBrowserPath || '').trim();
}

// 经 PowerShell 的 Start-Process（ShellExecute 语义）启动一个 exe，并把结果回调给调用方。
// 启动加速器与「指定路径启动游戏」共用这一段，避免两处各写一份、日后各自漂移。
//
// 实现要点（全部是实测踩出来的）：
//   · 用 ShellExecute 语义：需要管理员权限的 exe 会正常弹 UAC（直接 spawn 不会）；
//   · **工作目录必须设为 exe 所在目录** —— 很多程序依赖同目录的 DLL/资源，工作目录不对时
//     进程起来就闪退，表现为「点了没反应」（第一版就没设，换个加速器即失效）；
//   · 用 -EncodedCommand 传脚本，避免路径里的空格/引号被各层转义弄坏；
//   · **带回执**：Start-Process 的真实失败（UAC 被拒、文件被删等）曾被静默吞掉，表现为
//     「按了没反应」。现在 PowerShell 把结果（OK / ERR:原因）base64 写回 stdout，
//     等它退出后原样返回；等 UAC 超过 30 秒则按「已交给系统、待确认」处理。
//   · args 里的每个参数都单独加引号并转义单引号，所以路径/URL 带空格也安全。
function launchExeViaShell(exe, args, cb) {
  const dir = path.dirname(exe);
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const argList = (args && args.length)
    ? ' -ArgumentList ' + args.map(q).join(',')
    : '';
  const ps = "try { Start-Process -FilePath " + q(exe) + argList
    + " -WorkingDirectory " + q(dir)
    + " -ErrorAction Stop; [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('OK'))) }"
    + " catch { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('ERR:' + $_.Exception.Message))) }";
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');
  const { execFile } = require('child_process');
  execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', b64],
    { timeout: 30000, encoding: 'utf8', windowsHide: true },
    (err, stdout) => {
      let result;
      if (err && err.killed) {
        // 30 秒没回来：多半在等 UAC 确认 —— 按已交给系统处理
        result = { ok: true, path: exe, pending: true };
      } else {
        let msg = '';
        try { msg = Buffer.from(String(stdout || '').trim(), 'base64').toString('utf8'); } catch { msg = ''; }
        if (!err && msg === 'OK') result = { ok: true, path: exe };
        else result = { ok: false, error: (msg || (err && err.message) || '未知原因').replace(/^ERR:/, '') };
      }
      cb(result);
    });
}

// ---------------------------------------------------------------- 请求处理

// ---------------------------------------------------------------- 命中的 Range 支持（P0-4，V4.17.0）
//
// 取证（2026-10-14，构造请求打真实构建）：
//   · 命中一律回 200 全量、且不发 Accept-Ranges —— 合法（RFC 允许服务器忽略 Range），
//     但浏览器不知道可以切片请求，对音频 seek 不友好；
//   · 未命中把源站的 206 原样转发时**丢了 Content-Range / Accept-Ranges** —— 畸形 206，
//     浏览器对 fetch/XHR 会直接判网络错误（媒体元素多半容错，但协议层面就是坏的）。
// 本函数处理"命中回放"这半边：单区间用本地字节切片（零额外读盘），越界回 416；
// 多区间 / 非法写法 / 非 bytes 单位一律忽略（回 200 全量）。未命中的透传补全在各回源点。
function applyHitRange(req, headers, body) {
  const out = Object.assign({}, headers, { 'Accept-Ranges': 'bytes' });
  const raw = String(req.headers['range'] || '').trim();
  if (!raw) return { status: 200, headers: out, body };
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);        // 单区间才算（含逗号的多区间不匹配 → 忽略）
  if (!m || (m[1] === '' && m[2] === '')) return { status: 200, headers: out, body };
  const size = body.length;
  const unsat = () => ({ status: 416, headers: Object.assign({}, out, { 'Content-Range': 'bytes */' + size, 'Content-Length': 0 }), body: Buffer.alloc(0) });
  if (size === 0) return unsat();
  let start, end;
  if (m[1] === '') {                                 // 后缀区间 bytes=-N：最后 N 字节
    const n = Number(m[2]);
    if (n === 0) return unsat();
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    if (!Number.isFinite(start)) return { status: 200, headers: out, body };
    // 越界判定必须在"end 与 start 比大小"之前：bytes=64-（文件 64 字节）的 end 默认是
    // size-1，先比大小会把它误判成"非法区间"回 200，绕过 RFC 要求的 416（测试抓出来的）。
    if (start >= size) return unsat();
    end = m[2] === '' ? size - 1 : Number(m[2]);
    if (!Number.isFinite(end) || end < start) return { status: 200, headers: out, body };
  }
  end = Math.min(end, size - 1);
  const slice = body.subarray(start, end + 1);
  return {
    status: 206,
    headers: Object.assign({}, out, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Content-Length': slice.length,
    }),
    body: slice,
  };
}

// 缓存命中查找（V4.12.0）：handle（扩展 /f/ 路径）与 handleIntercepted（HTTPS 中间人）
// 两处命中循环的**合并版**。此前是两份手抄的同一逻辑，已经多次出现"改了一处、另一处
// 漏掉"的漂移风险（V4.10.2 的全量 502 就是这类双路径不同步的产物）——现在只有一个地方
// 可以改，测试也只需要钉一份。
//
// 同时把读盘从同步改为异步（stat/readFile/gunzip 全程不占事件循环），返回结构：
//   { kind: 'hit',           headers, body }   —— 命中，调用方按 200 发送
//   { kind: 'not-modified',  headers }         —— If-None-Match 快路径，调用方按 304 发送
//   { kind: 'mismatch' }                       —— 有缓存文件但查询串（资源版本）对不上
//   { kind: 'miss' }                           —— 没有可用缓存
// 读盘失败不抛出：计入 stats.error 并继续尝试下一个候选（与旧实现一致）。
async function lookupCache(req, fsRoot, fsPath, rest, query) {
  const inm = req.headers['if-none-match'];
  let mismatch = false;
  if (fsPath) {
    const candidates = [fsPath];
    // 兼容百分号编码差异：再试一次解码后的路径。
    // ⚠️ 这一步**必须**过边界检查：解码会把 %2f 变成真正的目录分隔符，于是
    // '/assets/..%2f..%2fsecret.txt' 这类请求的 fsPath（含字面百分号，能通过
    // cachePathFor 的检查）解码后就逃出了缓存目录 —— 实测确认过，那是任意文件读取
    // （读到的内容会被当资源回给浏览器）。见 test-cachepath.js。
    try {
      const dec = decodeURIComponent(fsPath);
      if (dec !== fsPath && isInsideRoot(fsRoot, dec)) candidates.push(dec);
    } catch { }

    for (const c of candidates) {
      let st = null;
      try { st = await fsp.stat(c); } catch { continue; }
      if (!st.isFile()) continue;

      // 条件请求快路径（V4.9.0）：浏览器带着 If-None-Match 来、且本地元数据能对上
      //（ETag 相等 + 版本号 q 一致）时，不必读正文，直接 304 —— 大文件（音视频）省一次
      // 全量读盘。q 不一致绝不能 304：那是另一个资源版本，见 cacheEntryMatchesQuery。
      if (inm) {
        const metaOnly = await readExtMetaAsync(c);   // V4.14.6：这次 .ext 读也异步化
        if (metaOnly && metaOnly.ETag && cacheEntryMatchesQuery(metaOnly, query)
            && ifNoneMatchHits(inm, metaOnly.ETag)) {
          stats.notModified++;
          pushLog({ tag: 'HIT', path: rest + query, source: 'cache-304' });
          const h304 = {
            'Cache-Control': cacheControlForHit(rest),
            'X-GBFCache-Source': noteSource('local-cache'),
            'ETag': metaOnly.ETag,
          };
          if (metaOnly.LastModified) h304['Last-Modified'] = metaOnly.LastModified;
          Object.assign(h304, corsHeadersForHit(metaOnly, req));
          return { kind: 'not-modified', headers: h304 };
        }
      }

      try {
        const { body, meta } = await readCacheEntryAsync(c);
        // 版本号对不上就不算命中（详见 cacheEntryMatchesQuery 的说明）
        if (!cacheEntryMatchesQuery(meta, query)) { mismatch = true; continue; }
        stats.hit++;
        pushLog({ tag: 'HIT', path: rest + query, size: body.length, source: 'cache' });
        const hdrs = {
          'Content-Type': mimeFor(c, meta),
          'Content-Length': body.length,
          'Cache-Control': cacheControlForHit(rest),
          'X-GBFCache-Source': noteSource('local-cache'),
        };
        // 源站的验证器回放给浏览器（V4.9.0）：此后浏览器才会带 If-None-Match 来，
        // 上面的 304 快路径才有用武之地。老缓存没有这两个字段，照常工作。
        if (meta && meta.ETag) hdrs['ETag'] = meta.ETag;
        if (meta && meta.LastModified) hdrs['Last-Modified'] = meta.LastModified;
        if (HOST_LOG_VERBOSE) log(`HIT  ${rest} (${body.length}B)`);
        Object.assign(hdrs, corsHeadersForHit(meta, req));
        return { kind: 'hit', headers: hdrs, body };
      } catch (e) {
        stats.error++;
        noteError(`读缓存失败 ${c}: ${e.message}`);
        log(`读缓存失败 ${c}: ${e.message}`);
      }
    }
  }
  return mismatch ? { kind: 'mismatch' } : { kind: 'miss' };
}

// ---------------------------------------------------------------- 管理面的本机来源校验（V4.14.5 安全加固）
//
// /api/*、/events、/stats、/test 是本机管理面：删缓存文件、删版本戳目录、写系统 hosts、
// 改缓存目录（在任意可写位置建目录）、关服务、读请求日志。浏览器对跨源请求只拦「读响应」、
// 不拦「发请求」，所以任意网页都能让浏览器向 http://127.0.0.1:8799/api/... 发 POST ——
// 删文件、停服务这些副作用照样发生。DNS rebinding（把攻击者域名解析到 127.0.0.1 冒充同源）
// 则要靠 Host 头来挡。两条检查都在本机、零开销：
//   · Host 存在时必须是 127.0.0.1 / localhost / ::1 —— rebinding 的 Host 是攻击者域名，直接 403；
//   · 带了 Origin 头就必须是本源 —— 控制台页面的同源请求带的是自己的地址；托盘（PowerShell）、
//     各测试脚本都不带 Origin，一律放行。
// 资源路径（/f/… 与代理拦截路径）不经这里，分流与 CORS 回显行为一字不变。
function isLocalApiRequest(req) {
  const host = String(req.headers.host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host) {
    const h = host.replace(/:\d+$/, '');
    if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') return false;
  }
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (origin
      && origin !== 'http://127.0.0.1:' + PORT
      && origin !== 'http://localhost:' + PORT) {
    return false;
  }
  return true;
}

// /api/stats 的完整载荷（V4.14.10 从 handle() 里提出来）：控制台轮询与「诊断一键导出」
// 共用同一份构造，避免两处各写一份、日后漂移。
async function buildStatsPayload() {
  return {
    stats,
    // 观测（V4.6.5）：命中来源分布 + X-VERSION 观测。定义处的注释写了各自怎么读、
    // 以及"浏览器缓存命中对代理不可见"这处测量盲区。
    sources: sourceCounts(),
    xVersion: xVersionObs,
    // 迁移/跟随实况 + 档位（控制台"当前档位"徽标用；V4.19.7 起卡片并入启动游戏面板）
    followLive: { queued: followState.queue.length, active: followState.active },
    modes: { prewarmEnabled: config.prewarmEnabled === true, followEnabled: followEnabled() },
    // 版本戳状况（V4.7.0）：从已扫好的 byGroup 直接推导，零额外开销，
    // 所以可以安全地放进被控制台定期轮询的这个接口里。界面用它显示"有几个过期戳、可回收多少"。
    stamps: stampStatusFromCacheInfo(),
    // PAC 串接用的本机代理是否还活着（V4.7.1）。alive：true 可用 / false 探明不通（已从 PAC 摘掉）
    // / null 还没结论。界面用它提示"加速器关了但端口还留着"这类情况。
    chain: chainLivenessInfo(),
    // 回源耗时分布（V4.11.0）：只含前台资源未命中后的真实出网回源（口径见 noteOriginLatency）。
    // count=0 表示还没回源过；p50/p95/p99 单位毫秒。
    originLatency: originLatencyPercentiles(),
    recentErrors: recentErrors.slice(-15),
    log: requestLog.slice(-120),
    cache: {
      scanAt: cacheInfo.scanAt, scanning: cacheInfo.scanning,
      files: cacheInfo.files, bytes: cacheInfo.bytes, byExt: cacheInfo.byExt,
      // 每类占多少字节：控制台「按类型清理」面板用它显示体积。
      // 注意这里是逐字段列举的，新增 cacheInfo 字段必须同时加到这里，否则界面上拿不到
      // （自我测试就抓到过这个漏项）。
      byExtBytes: cacheInfo.byExtBytes,
      // 按目录 / 版本戳分组的体积（V4.6.5）：决定"保留几个版本戳"的依据。
      // 注意这里是逐字段列举的，新增 cacheInfo 字段必须同时加到这里，否则界面上拿不到。
      byGroup: cacheInfo.byGroup,
      groupTruncated: cacheInfo.groupTruncated,
      root: cacheInfo.root, rootExists: fs.existsSync(cacheInfo.root),
      writable: cacheInfo.writable, freeBytes: cacheInfo.freeBytes,
      isDefault: cacheInfo.root === DEFAULT_CACHE_ROOT,
    },
    server: {
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      port: PORT,
      version: process.version,
      platform: process.platform,
    },
    extensionHint: {
      port: PORT,
      folder: path.join(__dirname, 'console-extension'),
    },
    probe: { lastProbeAt, count: probeCount },
    appVersion: VERSION,
    autoLaunch: {
      enabled: config.autoLaunchGame !== false,
      accel: config.autoLaunchAccel !== false,
    },
    // 悬浮监控窗（V4.13.2）：控制台的开关按钮读 enabled + show，托盘另走 /api/float-state。
    // 两边同一份判定（floatWinState()），不各写一套。
    floatWin: floatWinState(),
    accelerator: { path: acceleratorPath() },
    game: { path: gameLaunchPath() },
    consoleBrowser: { path: consoleBrowserPath() },
    proxy: {
      lastRequestAt: lastProxyRequestAt,
      lastRequestPath: lastProxyRequestPath,
      // 近 10 分钟内有没有请求经过代理 —— 配合探针判断「到底在不在接管」
      //（探针是在控制台自己那个窗口里跑的，该窗口未必经过代理，两者要一起看）
      activeRecently: lastProxyRequestAt > 0 && (Date.now() - lastProxyRequestAt) < 600000,
    },
    systemProxy: systemProxyInfo(),
    cert: await certStoreInfo(),
    upstreamProbe: upstreamProbeInfo(),
  };
}

async function handle(req, res) {
  const rawUrl = req.url || '/';
  res._acgpOrigin = req.headers.origin || '*';
  res._acgpReqHeaders = req.headers['access-control-request-headers'] || '';
  res._acgpVary = 'Accept-Encoding, Origin';

  // 诊断：记录浏览器实际发来的 Origin（重定向后跨源请求的 Origin 会被浏览器改写）
  if (process.env.GBFCACHE_TRACE_ORIGIN === '1' && ASSET_PATH_RE.test(rawUrl)) {
    const o = req.headers.origin;
    logToFile(`[trace] ${req.method} ${rawUrl.slice(0, 70)} origin=${o === undefined ? '(未发送)' : JSON.stringify(o)} sec-fetch-mode=${req.headers['sec-fetch-mode'] || '-'}`);
  }

  // 管理面来源校验（V4.14.5）：非本机来源一律 403，详见 isLocalApiRequest 的说明。
  // 故意把 _acgpOrigin 置回 *：403 里不给对方任何 CORS 回显。
  // 只记日志不进任何统计 —— 攻击者的扫描不该污染命中率这类业务指标。
  if ((rawUrl.startsWith('/api/') || rawUrl === '/events' || rawUrl === '/stats'
       || rawUrl === '/test' || rawUrl.startsWith('/test?')) && !isLocalApiRequest(req)) {
    log(`WARN 拒绝非本机来源的管理请求: ${req.method} ${rawUrl} origin=${req.headers.origin || '-'} host=${req.headers.host || '-'}`);
    res._acgpOrigin = '*';
    return send(res, 403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify({ ok: false, error: '本程序的管理接口只接受本机访问' }));
  }

  if (req.method === 'OPTIONS') {
    return send(res, 204, {});
  }

  // 健康检查 / 统计
  if (rawUrl === '/health') {
    return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({
      ok: true,
      cacheRoot: CACHE_ROOT,
      cacheRootExists: fs.existsSync(CACHE_ROOT),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      stats,
      recentErrors,
      lastProbeAt,
      systemProxy: systemProxyInfo(),
      upstreamProbe: upstreamProbeInfo(),
      // 内存读数（V4.7.2）：长跑稳定性观察（原清单 P1-7）一直没做，一部分原因就是**没有仪表** ——
      // 以前只能从外面用 tasklist 看个总数，既不方便也不可复现。这里直接报自己的用量，
      // 配合 /api/stats 的缓存体积，就能画出"跑了多久 / 内存与缓存各涨到多少"。
      // rss 是进程实际占用的物理内存，heapUsed 是 JS 堆，两个都看才能区分"堆泄漏"与"缓冲区累积"。
      mem: (() => {
        const m = process.memoryUsage();
        return {
          rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external,
          uptimeSec: Math.floor(process.uptime()),
        };
      })(),
    }));
  }
  // 手动触发一次「加速器本地代理」探测：开着加速器时点它最有意义。
  // 手动这次允许全面扫描本机监听端口（不只挑进程名像加速器的）。
  if (rawUrl === '/api/probe-upstream') {
    detectedUpstream = null;
    chainAgentCache = { key: '', agent: null };
    chainWarned = false;
    await detectUpstreamProxy(true, true);
    return send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify(upstreamProbeInfo()));
  }

  if (rawUrl === '/stats') {
    return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(stats, null, 2));
  }

  // ---------------- 可视化控制台 ----------------

  // 控制台界面
  if (rawUrl === '/' || rawUrl === '/index.html') {
    let html;
    try {
      html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
      // 占位符替换：把本程序的代理地址下发给页面（体检卡的 PAC 判定要用它当比对基准）。
      // 与 /test 页的 PROXY_TXT 同一工法 —— 端口是运行时事实，不能写死在静态页面里。
      html = html.replace(/__GBFCACHE_PROXY_TXT__/g, HOST + ':' + PROXY_PORT);
    } catch (e) {
      return send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' },
        '缺少 dashboard.html，请确认它与 server.js 在同一目录。\u000a');
    }
    // 顺手把选择器宿主热起来：控制台是唯一有「浏览…」按钮的地方，而从"看到界面"到"第一次点浏览"
    // 通常隔几秒到几分钟，足够宿主就绪（约 0.9 秒）—— 于是第一次点选也是快的。
    // 代价是一个 PowerShell 进程（约 70MB）待命，空闲 10 分钟后由 pickerReap 收掉。
    // 只在"还没起"的时候预热，且失败不影响页面返回。
    if (PICKER_HOST_ENABLED && (!picker || picker.proc.exitCode !== null)) {
      try { picker = pickerStart(); } catch { /* 预热失败就算了，点选时会回退 */ }
    }
    return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, html);
  }

  // 界面首屏数据
  // 证书存储位置：强制重查一次（界面上的「重新检查」按钮用）。
  // 单独开一个接口的原因：/api/stats 被控制台每几秒拉一次，不能在轮询里反复开 PowerShell 查询。
  if (rawUrl === '/api/cert-check') {
    if (req.method !== 'POST') {
      return send(res, 405, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: '只接受 POST' }));
    }
    let info = null;
    try {
      // await：certStoreInfo 自 V4.6.7 起是异步的（不再同步阻塞事件循环）
      info = await certStoreInfo(true);
    } catch (e) {
      return send(res, 500, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: e.message }));
    }
    log('[证书] 重新检查结果：' + info.state + '（' + info.advice + '）');
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify({ ok: true, cert: info }));
  }

  // 一键修复根证书（V4.14.8，「一键体检」面板的修复按钮走这里）。
  // 只在「确实需要修」的状态下动手：misplaced / stale 先删掉装错（或过期）的那张再装到
  // 正确位置，missing 只装。全部针对**当前用户**存储（certutil -user），不需要管理员；
  // 结束后强制重查一次并把最新状态带回给界面。以前这套命令只能让用户照着提示手抄，
  // 现在一键完成 —— 这是"装错位置 = 资源全废且毫无提示"这类历史故障的最短修复路径。
  if (rawUrl.startsWith('/api/cert-fix') && req.method === 'POST') {
    const run = (cmd, args) => new Promise((r) => {
      require('child_process').execFile(cmd, args, { timeout: 30000, windowsHide: true },
        (e, stdout) => r({ ok: !e, out: String(stdout || '').trim(), err: e ? String(e.message) : '' }));
    });
    let cur = null;
    try { cur = await certStoreInfo(true); } catch (e) {
      return send(res, 500, { 'Content-Type': 'application/json; charset=utf-8' },
        JSON.stringify({ ok: false, error: e.message }));
    }
    if (!cur.needsFix) {
      return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        JSON.stringify({ ok: true, noop: true, message: '当前证书状态无需修复（' + cur.state + '）', cert: cur }));
    }
    const tp = caThumbprint();
    const steps = [];
    if (cur.state === 'misplaced' || cur.state === 'stale') {
      steps.push(['certutil', ['-user', '-delstore', 'CA', tp || CERT_SUBJECT_HINT]]);
    }
    steps.push(['certutil', ['-user', '-addstore', '-f', 'Root', path.join(CERT_DIR, 'ca.crt')]]);
    const results = [];
    for (const [c, a] of steps) {
      const r = await run(c, a);
      // delstore 失败通常只是"中间存储里本来就没有那张"—— 属预期，不算失败；
      // 最后一步 addstore 的结果才决定成败。
      results.push({ cmd: c + ' ' + a.join(' '), ok: r.ok, note: r.ok ? '' : r.err });
    }
    const addOk = results[results.length - 1].ok;
    let cert = cur;
    try { cert = await certStoreInfo(true); } catch { /* 重查失败就带回执行前的状态 */ }
    log('[证书] 一键修复执行：' + results.map((x) => x.cmd + ' -> ' + (x.ok ? 'ok' : x.note)).join('；')
      + '，复查状态 ' + cert.state);
    return send(res, addOk ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify({ ok: addOk, results, cert }));
  }
  if (rawUrl.startsWith('/api/cert-fix')) {
    return send(res, 405, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: '只接受 POST' }));
  }

  if (rawUrl === '/api/stats') {
    // V4.20.5：控制台轮询这个接口 —— 顺手刷新一次串接候选的存活结论（TTL 2 分钟，最多一次探测），
    // 让面板"已探明探不通/是否经加速器"两行不依赖"恰好有浏览器取过 PAC"。刻意只挂在这条路由上：
    // 放在共享的 payload 构造里会让 /health 也触发，抢在"首次取 PAC 还没有结论"之前把候选摘掉。
    try {
      const sc = readSystemProxy();
      const cand = sc.upstream || normalizeProxyServer(config.accelProxy) || normalizeProxyServer(sc.server);
      if (cand && isLoopbackAddr(cand)) refreshChainLiveness(cand).catch(() => {});
    } catch { /* 判活失败不影响统计接口 */ }
    return send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify(await buildStatsPayload()));
  }

  // 控制台「启动游戏」按钮 / 托盘开机自启：把游戏打开。
  //
  // 两条路（V4.5.0 起可自选）：
  //   · 配置了 gameLaunchPath —— 启动那个 exe，并把游戏 URL 作为**参数**传给它
  //     （用途：指定某个浏览器，或任何自己写的启动包装程序）；
  //   · 没配置（默认）—— ShellExecute 打开游戏 URL，走**系统默认浏览器**。
  // 两条路都不碰浏览器配置、不需要任何扩展：缓存一律靠系统 PAC 分流生效，而系统 PAC 对所有
  // 浏览器一视同仁，所以"不挑浏览器"依然是默认形态。
  // （与 V4.3.6 移除的「独立窗口 / 显式把代理塞给 Edge」不同：那个只对 Edge 有效、还要维护一份
  //  独立浏览器 profile；这里只是换个程序去打开同一个 URL。）
  const GAME_URL = 'https://game.granbluefantasy.jp/';
  if (rawUrl.startsWith('/api/launch-game') && req.method === 'POST') {
    const exe = gameLaunchPath();
    if (exe) {
      if (!fs.existsSync(exe)) {
        return send(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({
          ok: false, code: 'BAD_PATH',
          error: '找不到指定的启动程序（路径不存在或已移动）：' + exe
            + '　—— 可在「启动游戏」旁的 ⚙ 里重新选择，或清空该路径改用默认浏览器',
        }));
      }
      // 注意：响应在回调里异步发出 —— 这里必须立刻 return，
      // 否则会一路落到底部的 404 兜底，把请求抢先应答掉。
      launchExeViaShell(exe, [GAME_URL], (result) => {
        log('[控制台] 启动游戏（指定程序 ' + exe + '）：'
          + (result.ok ? (result.pending ? '已交给系统，可能在等 UAC 确认' : '成功') : '失败：' + result.error));
        send(res, 200, { 'Content-Type': 'application/json' },
          JSON.stringify(Object.assign({ target: 'custom', program: exe }, result)));
      });
      return;
    }
    try {
      // ShellExecute 方式打开 URL —— 走系统默认浏览器，不挑浏览器、不碰任何配置
      const { spawn } = require('child_process');
      const cp = spawn('rundll32', ['url.dll,FileProtocolHandler', GAME_URL],
        { detached: true, stdio: 'ignore' });
      cp.on('error', () => { /* 防 Unhandled 'error' 崩掉服务 */ });
      cp.unref();
      log('[控制台] 已用默认浏览器打开游戏（系统 PAC 分流：资源走缓存、接口直连）');
      return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, target: 'default' }));
    } catch (e) {
      log(`[控制台] 默认浏览器打开游戏失败：${e.message}`);
      return send(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // 切换开机自启相关开关：游戏（enabled）、启动目标（target）、加速器（accel）。
  // 例：POST /api/set-auto-launch?target=default   POST /api/set-auto-launch?enabled=0
  //     POST /api/set-auto-launch?accel=0
  if (rawUrl.startsWith('/api/set-auto-launch') && req.method === 'POST') {
    let patch = {};
    try {
      const u = new URL('http://x' + rawUrl);
      const en = u.searchParams.get('enabled');
      const ac = u.searchParams.get('accel');
      // 启动方式已统一为「系统默认浏览器」（V4.3.6 移除了独立窗口模式）：
      // 这里不再接受启动目标参数；旧 config.json 里残留的那个键会被直接忽略。
      if (en === '0' || en === '1') patch.autoLaunchGame = en === '1';
      if (ac === '0' || ac === '1') patch.autoLaunchAccel = ac === '1';
    } catch { /* 忽略 */ }
    if (Object.keys(patch).length) saveConfig(patch);
    return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({
      ok: true,
      autoLaunch: {
        enabled: config.autoLaunchGame !== false,
        accel: config.autoLaunchAccel !== false,
      },
    }));
  }

  // 「启动加速器」按钮：通用 exe 唤醒 —— 不针对任何软件，配置什么就启动什么。
  // 实现要点（实测踩坑）：
  //   · 经 PowerShell Start-Process（ShellExecute 语义）：需要管理员权限的 exe 会正常弹 UAC；
  //   · **工作目录必须设为 exe 所在目录** —— 很多程序依赖同目录的 DLL/资源，
  //     工作目录不对时进程起来就闪退，表现为「点了没反应」（第一版就没设，换别的加速器即失效）；
  //   · 用 -EncodedCommand 传脚本，避免路径里的空格/引号被各层转义弄坏；
  //   · **带回执**：Start-Process 的真实失败（UAC 被拒、文件被删等）第一版被静默吞掉，
  //     表现为「按了没反应」。现在 PowerShell 把结果（OK / ERR:原因）base64 写回 stdout，
  //     等它退出后原样返回给按钮提示；等 UAC 超过 30 秒则按「已交给系统、待确认」处理。
  if (rawUrl.startsWith('/api/launch-accelerator') && req.method === 'POST') {
    const exe = acceleratorPath();
    if (!exe) {
      return send(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({
        ok: false, code: 'NO_PATH', error: '尚未设置要启动的程序：请点旁边的 ⚙ 选择 exe',
      }));
    }
    if (!fs.existsSync(exe)) {
      return send(res, 400, { 'Content-Type': 'application/json' },
        JSON.stringify({ ok: false, error: '找不到该程序（路径不存在或已移动）：' + exe }));
    }
    // 启动细节（ShellExecute 语义 / 工作目录 / 回执）统一在 launchExeViaShell 里，
    // 与「指定路径启动游戏」共用同一段，免得两边各写一份、日后各自漂移。
    launchExeViaShell(exe, null, (result) => {
      log('[控制台] 启动加速器（' + exe + '）：'
        + (result.ok ? (result.pending ? '已交给系统，可能在等 UAC 确认' : '成功') : '失败：' + result.error));
      send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(result));
    });
    return;
  }

  // 设置加速器 exe 路径：POST /api/set-accelerator-path?path=...
  if (rawUrl.startsWith('/api/set-accelerator-path') && req.method === 'POST') {
    let np = '';
    try { np = (new URL('http://x' + rawUrl).searchParams.get('path') || '').trim(); } catch { /* 忽略 */ }
    if (!np) {
      return send(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: '路径为空' }));
    }
    saveConfig({ acceleratorPath: np });
    return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true, path: acceleratorPath() }));
  }

  // 设置「启动游戏」的目标程序：POST /api/set-game-launch-path?path=...
  // 与加速器不同，这里**允许传空**：空 = 清空该配置、回到「用系统默认浏览器打开」。
  // 不做存在性检查（与加速器路径一致）：真正打开时的失败会带着原因回给按钮提示，
  // 而此刻文件可能正好在移动盘/网络盘上，存的时候判它"不存在"反而是误伤。
  if (rawUrl.startsWith('/api/set-game-launch-path') && req.method === 'POST') {
    let np = '';
    try { np = (new URL('http://x' + rawUrl).searchParams.get('path') || '').trim(); } catch { /* 忽略 */ }
    saveConfig({ gameLaunchPath: np });
    log('[控制台] 启动游戏的目标程序已' + (np ? '设为 ' + np : '清空（改用系统默认浏览器）'));
    return send(res, 200, { 'Content-Type': 'application/json' },
      JSON.stringify({ ok: true, path: gameLaunchPath() }));
  }

  // 设置「打开控制台」用的浏览器：POST /api/set-console-browser-path?path=...
  // 空 = 恢复老行为（优先 Edge 应用模式，找不到 Edge 再用系统默认浏览器）。
  // 与 gameLaunchPath 一样不做存在性检查：路径可能在移动盘/网络盘上，真正打开失败会写日志。
  if (rawUrl.startsWith('/api/set-console-browser-path') && req.method === 'POST') {
    let np = '';
    try { np = (new URL('http://x' + rawUrl).searchParams.get('path') || '').trim(); } catch { /* 忽略 */ }
    saveConfig({ consoleBrowserPath: np });
    log('[控制台] 控制台浏览器已' + (np ? '设为 ' + np : '恢复默认（优先 Edge）'));
    return send(res, 200, { 'Content-Type': 'application/json' },
      JSON.stringify({ ok: true, path: consoleBrowserPath() }));
  }

  // 弹原生文件选择框，返回选中的 exe 路径（加速器路径、启动游戏程序、控制台浏览器共用）。
  // ?for=game/console 只影响对话框标题（同一个选择器，标题说清楚在选什么）。
  if (rawUrl.startsWith('/api/browse-file')) {
    let forWhat = '';
    try { forWhat = (new URL('http://x' + rawUrl).searchParams.get('for') || ''); } catch { /* 忽略 */ }
    const title = forWhat === 'game'
      ? '选择用来打开游戏的程序（通常是某个浏览器的 exe）'
      : forWhat === 'console'
        ? '选择打开控制台窗口的浏览器（建议 Chromium 内核：Edge / Chrome / Iron / Brave / Vivaldi）'
        : undefined;
    browseFile((picked, err) => {
      const body = JSON.stringify({ path: picked || '', error: err || null });
      send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body);
    }, title);
    return;
  }

  // 托盘程序用它来优雅停止服务
  if (rawUrl === '/api/shutdown') {
    send(res, 200, { 'Content-Type': 'application/json' }, '{"ok":true}');
    log('收到退出请求，正在停止服务…');
    // 主动广播一条 shutdown：控制台据此把自己那个 app 窗口关掉。
    // 否则退出后会在桌面上留一个显示「与服务断开」的死窗口 —— 用户会以为没退干净。
    try { broadcast('shutdown', { ok: true }); } catch { /* 广播失败不影响退出 */ }
    // 留 400ms 而不是原来的 250ms：给 SSE 这条推送一点刷出时间（托盘那边等 3 秒，够用）
    setTimeout(() => process.exit(0), 400);
    return;
  }

  // 代理自动配置文件（PAC）
  //
  // 由系统/浏览器的「自动代理配置」指向这里，比依赖浏览器扩展更可靠 ——
  // MV3 的 Service Worker 是惰性的，扩展不保证能在启动时成功设置代理。
  // 这种「自己算 PAC」的做法在既有方案里已被验证可行。
  //
  // 规则（详见文件上方「系统代理」一节）：GBF 的 /assets/ 走本地缓存代理，
  // 其余流量交回加速器 —— 否则会把加速器经系统代理做的加速整体旁路掉。
  // 内容每次现算（加速器的代理地址可能变），并且 no-store 让浏览器别缓存它。
  if (rawUrl === PAC_PATH || rawUrl === PAC_PATH + '/' || rawUrl.startsWith(PAC_PATH + '?')) {
    // V4.12.0：revalidate —— 数据过期就**后台**刷新、本次先用缓存值。PAC 下发绝不同步查
    // 注册表（浏览器偶尔来取一次，取的那次不该被 execSync 卡住事件循环）；缓存由 20 秒
    // 巡检持续保鲜，实际拿到的几乎总是新鲜的。
    revalidateSystemProxy();
    return send(res, 200, {
      'Content-Type': 'application/x-ns-proxy-autoconfig; charset=utf-8',
      'Cache-Control': 'no-store',
    }, buildPac(readSystemProxy()));
  }

  // 触发重新扫描缓存目录
  if (rawUrl === '/api/scan') {
    scanCache();
    return send(res, 200, { 'Content-Type': 'application/json' }, '{"ok":true}');
  }

  // 弹出原生文件夹选择框，返回用户选中的路径
  if (rawUrl === '/api/browse-folder') {
    browseFolder((picked, err) => {
      const body = JSON.stringify({ path: picked, error: err || null });
      send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body);
    });
    return;
  }

  // 选择器宿主的状态（排查"点选很慢"时先看这里：running=false 就说明每次都在重新起进程）
  if (rawUrl === '/api/picker-status') {
    pickerStatus((st) => {
      send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify(st));
    });
    return;
  }

  // 停掉选择器宿主：给排查/自测用（自测靠它制造"冷态"再对比热态；
  // 支持场景下也可以用它把疑似卡住的宿主清掉，下次点选会重新起一个）。
  // 与其他会改状态的接口一致：只允许 POST。
  if (rawUrl.startsWith('/api/picker-host')) {
    if (req.method !== 'POST') {
      return send(res, 405, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: false, error: '请用 POST' }));
    }
    const stopped = pickerStop('接口请求');
    return send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify({ ok: true, stopped }));
  }

  // 切换缓存目录
  if (rawUrl.startsWith('/api/set-cache-root')) {
    const u = new URL('http://x' + rawUrl);
    const raw = (u.searchParams.get('path') || '').trim();

    if (!raw) {
      return send(res, 400, { 'Content-Type': 'application/json' },
        JSON.stringify({ ok: false, error: '路径为空' }));
    }

    let next;
    try {
      next = path.resolve(raw);
    } catch {
      return send(res, 400, { 'Content-Type': 'application/json' },
        JSON.stringify({ ok: false, error: '路径格式不正确' }));
    }

    // 目录必须能创建或已存在，并且可写 —— 否则改了也没用
    try {
      if (!fs.existsSync(next)) fs.mkdirSync(next, { recursive: true });
      const t = path.join(next, `__write_test_${Date.now()}.tmp`);
      fs.writeFileSync(t, 'gbftest');
      fs.unlinkSync(t);
    } catch (e) {
      return send(res, 400, { 'Content-Type': 'application/json' },
        JSON.stringify({ ok: false, error: `目录不可用或不可写：${e.message}` }));
    }

    const prev = CACHE_ROOT;
    CACHE_ROOT = next;
    // 这是"用户显式选过"的唯一来源：从这一刻起这个值才允许写进 config.json
    chosenCacheRoot = next;
    cacheInfo.root = next;
    cacheInfo.scanAt = null;
    cacheInfo.files = 0;
    cacheInfo.bytes = 0;
    cacheInfo.byExt = {};
    cacheInfo.byExtBytes = {};
    saveConfig();
    log(`缓存目录已切换：${prev} -> ${next}`);
    scanCache();
    broadcast('cache-root', { root: next, prev });

    return send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify({ ok: true, prev, root: next }));
  }

  // 按类型清理缓存（界面上的「清理 png / jpg」这类按钮走这里）
  //   POST /api/clean-cache?ext=png,jpg      真删
  //   GET  /api/clean-cache?ext=png&dryRun=1 只预览（不删）
  // 真删必须用 POST：避免被浏览器的预取/爬取意外触发（删除是不可逆的）
  if (rawUrl.startsWith('/api/clean-cache')) {
    let exts = '', dryRun = false;
    try {
      const u = new URL('http://x' + rawUrl);
      exts = u.searchParams.get('ext') || u.searchParams.get('exts') || '';
      dryRun = u.searchParams.get('dryRun') === '1';
    } catch { /* 参数解析失败就按空处理，下面会报"没有可用的扩展名" */ }

    if (!dryRun && req.method !== 'POST') {
      return send(res, 405, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        JSON.stringify({ ok: false, error: '清理必须用 POST 请求' }));
    }

    const r = cleanCacheByExt(exts, dryRun);
    const mb = (r.bytes / 1048576).toFixed(1);
    log(`[缓存清理]${r.dryRun ? '预览' : '执行'} 类型=${r.exts.join(',') || '-'}：` +
      `${r.dryRun ? '将删除' : '已删除'} ${r.deleted} 个文件 / ${mb} MB` +
      (r.error ? `；失败：${r.error}` : '') +
      (r.errors.length ? `；${r.errors.length} 项未成功` : ''));
    return send(res, r.ok ? 200 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify(r));
  }

  // 版本戳目录淘汰：清掉不会再被请求的过期 /assets/<数字戳>/ 目录。
  //   GET  /api/evict-stamps            只预览（dryRun，不删）
  //   POST /api/evict-stamps?dryRun=0   真删
  // 【dryRun 默认开】这是删目录、不可逆，所以"没写明要删"一律按预览处理 ——
  // 与 clean-cache 相反（那边默认执行、只要求改用 POST）。删文件的事宁可多问一次。
  if (rawUrl.startsWith('/api/evict-stamps')) {
    let dryRun = true;
    try {
      const u = new URL('http://x' + rawUrl);
      if (u.searchParams.get('dryRun') === '0') dryRun = false;
    } catch { /* 参数解析失败 -> 保持 dryRun */ }

    if (!dryRun && req.method !== 'POST') {
      return send(res, 405, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        JSON.stringify({ ok: false, error: '真正删除必须用 POST 请求' }));
    }

    const r = evictStamps(dryRun);
    const mb = (r.bytes / 1048576).toFixed(1);
    log(`[版本戳淘汰]${r.dryRun ? '预览' : '执行'} 当前戳=${r.current || '-'} 保留=${r.keep.join(',') || '-'}：` +
      `${r.dryRun ? '将删除' : '已删除'} ${r.evicted.length} 个目录 / ${r.files} 个文件 / ${mb} MB` +
      (r.errors.length ? `；${r.errors.length} 项未成功` : ''));
    return send(res, r.ok ? 200 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify(r));
  }

  // hosts + 本地 443 兜底模式（V4.8.0）：PAC 槽被别的程序抢占且无法串接时的**最后手段**。
  //   GET  /api/hosts-mode                            看状态（不碰系统）
  //   POST /api/hosts-mode?action=apply               预览将做什么（dryRun 默认开）
  //   POST /api/hosts-mode?action=apply&dryRun=0      真写 hosts（需要管理员权限）
  //   POST /api/hosts-mode?action=restore[&dryRun=0]  只删本程序加的那些行
  if (rawUrl.startsWith('/api/hosts-mode')) {
    let action = 'status', dryRun = true;
    try {
      const u = new URL('http://x' + rawUrl);
      action = (u.searchParams.get('action') || 'status').toLowerCase();
      if (u.searchParams.get('dryRun') === '0') dryRun = false;
    } catch { /* 参数解析失败就按"看状态"处理 */ }

    const json = (code, obj) => send(res, code,
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(obj));

    if (action === 'status') { return json(200, hostsStatus()); }
    if (action !== 'apply' && action !== 'restore') {
      return json(400, { ok: false, error: 'action 只支持 apply / restore（缺省是看状态）' });
    }
    // 真改系统文件必须用 POST（与 clean-cache / evict-stamps 同一约定）
    if (!dryRun && req.method !== 'POST') {
      return json(405, { ok: false, error: '真正修改 hosts 必须用 POST 请求' });
    }
    // 启用前先把 443 监听拉起来 —— 顺序理由见 setHostsMode 里的注释（监听没起来就写 hosts = 断网）
    if (action === 'apply') { await new Promise((r) => startHostsModeListener(() => r())); }
    return await new Promise((resolve) => {
      setHostsMode(action, dryRun, (out) => {
        log('[hosts 模式] ' + action + (dryRun ? '（预览）' : '') + '：' + (out.ok ? (out.note || 'ok') : out.error));
        resolve(json(out.ok ? 200 : 400, out));
      });
    });
  }

  // 诊断一键导出（V4.14.10）：把排障现场打成一个 zip（默认放桌面），求助时发这一个文件即可。
  // 只接受 POST —— 与其它"有实际动作"的接口同一约定。
  if (rawUrl.startsWith('/api/export-diagnostics') && req.method === 'POST') {
    const r = await exportDiagnostics();
    log('[诊断] 导出' + (r.ok
      ? '成功：' + r.zip + '（' + r.files.length + ' 个文件）'
      : '失败：' + (r.error || '未知')));
    return send(res, r.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify(r));
  }

  // 目录可写性快速测试
  if (rawUrl === '/api/test-write') {
    const r = testCacheWrite();
    log(`[目录测试] 可写=${r.writable} 存在=${r.exists} 新建=${r.created} 错误=${r.errors.length}`);
    return send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify(r));
  }

  // 完整缓存流程测试：删除样本 -> 回源 -> 验证重新写入
  if (rawUrl === '/api/test-cache-cycle') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    });
    const push = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };
    push({ phase: 'start' });
    testCacheCycle()
      .then((r) => { push({ phase: 'done', result: r }); res.end(); })
      .catch((e) => { push({ phase: 'done', result: { ok: false, errors: [String(e)] } }); res.end(); });
    return;
  }

  // 实时事件流（SSE）。控制台用它 —— 同时也正是"控制台在不在"的判据（见上面「悬浮监控窗」）。
  if (rawUrl === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      // V4.14.5：不再回 Access-Control-Allow-Origin:* —— 这条流推的是请求日志与统计，
      // 消费方只有同源的控制台（同源根本不需要 CORS 头）；以前回 * 等于把日志开放给任意网页读。
    });
    res.write(': connected\u000a\u000a');
    sseClients.add(res);

    // 登记为"控制台在场"。悬浮条不用 SSE（它轮询 /api/float-state），所以这条流上的
    // 连接一律算控制台 —— 不会出现"悬浮条把自己当成控制台、于是永远不显示"。
    consoleEverOpened = true;
    lastConsoleDropAt = 0;            // 控制台回来了 —— 撤销"可能已关闭"的判定
    consoleAnnouncedClosingAt = 0;    // 撤销"页面说要走"（刷新时新连接会走到这里）
    // 回到"跟随自动"：这样「打开控制台收起 → 关掉控制台再出来」永远成立，
    // 不会因为之前手动点过而静默失灵。用户想彻底关掉这个能力，用控制台里的开关。
    floatManualWant = null;
    consoleClients.add(res);
    // 这条日志是**排查"悬浮窗很久才出来"的关键证据**：能看出究竟是"页面没连上"、
    // "连接一直没断"还是"断了但判定没跟上"。（V4.13.3 加 —— 上一版一行都没有，
    // 用户报"很久才出来"时完全看不出卡在哪一环。）
    log(`[悬浮窗] 控制台已连接（当前 ${consoleClients.size} 个连接）—— 收起悬浮窗`);

    const ping = setInterval(() => {
      try { res.write(': ping\u000a\u000a'); } catch {}
    }, 20000);

    const bye = () => {
      clearInterval(ping);
      sseClients.delete(res);
      if (consoleClients.delete(res) && consoleClients.size === 0) {
        // 最后一条控制台连接断了。不立刻显示悬浮条 —— 记下时刻，宽限期过后才算"真关了"
        //（页面刷新、服务重启后自动重连都会走这里，一断就显示会闪）。
        lastConsoleDropAt = Date.now();
        log(`[悬浮窗] 控制台连接已断开（剩 0 个）—— ${Math.round(CONSOLE_GRACE_MS / 1000)} 秒宽限期后若无连接则显示悬浮窗`);
      }
    };
    req.on('close', bye);
    req.on('error', bye);
    return;
  }

  // 悬浮窗的状态 + 它要显示的那几个数字。
  // 托盘用 `show` 决定 Show()/Hide() 那个 WinForms 小条；小条自己用它刷新数字。
  // 只回几个数字，够小；刻意不复用 /api/stats（那个要查证书存储）。
  if (rawUrl === '/api/float-state') {
    const st = floatWinState();
    // 只在"该不该显示"翻转时记一行。托盘每 2 秒问一次，所以这条时间线与真实翻转几乎同步，
    // 排查"多久才出来"时直接看它即可（带上判断依据，一眼能看出是哪条规则在起作用）。
    if (st.show !== lastFloatShowLogged) {
      lastFloatShowLogged = st.show;
      log(`[悬浮窗] ${st.show ? '该显示' : '该收起'}（控制台连接 ${consoleClients.size} 个 / 宽限期内=${st.consoleEffectiveOpen} / 开关=${st.enabled} / 手动=${st.manual} / 页面已告知关闭=${consoleAnnouncedClosingAt !== 0}）`);
    }
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify(Object.assign({ ok: true, version: VERSION }, st,
        { metrics: floatMetrics(), bypass: pacBypass,
          // 设置面板「游戏更新提醒气泡」（V4.15.2）：关掉时不下发预热实况 → 托盘不再弹气泡。
          prewarm: config.prewarmNotify === false ? null : prewarmLive })));
  }

  // 控制台页面在 pagehide 时打的"我要走了"信号（navigator.sendBeacon）。
  //
  // 【为什么需要它】只靠 SSE socket 断开**不够可靠**：浏览器/系统可能把连接留成"半死"状态
  //（窗口没了、socket 还挂着），服务端要等下一次 20 秒心跳写失败才发现 —— 表现就是
  // "关掉控制台后很久悬浮窗才出来"。有了这个信号，宽限期**立刻**开始计时。
  // 另外它会顺带让判定在宽限期过后**不再相信 socket**（见 consoleEffectiveOpen），
  // 所以哪怕那条僵尸连接一直挂着，悬浮条也照样会出来。
  //
  // 刷新页面也会触发 pagehide，所以宽限期不能省 —— 新页面通常 0.6 秒就连回来（实测）。
  if (rawUrl.startsWith('/api/console-closing') && req.method === 'POST') {
    consoleAnnouncedClosingAt = Date.now();
    log('[悬浮窗] 控制台页面主动告知"即将关闭"（beacon）—— 宽限期从现在开始计时');
    return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ ok: true }));
  }

  // 控制台里的开关：关闭控制台时要不要显示悬浮条
  if (rawUrl.startsWith('/api/set-float-on-close') && req.method === 'POST') {
    let on = null;
    try {
      const v = new URL('http://x' + rawUrl).searchParams.get('enabled');
      if (v === '0' || v === '1') on = (v === '1');
    } catch { /* 忽略 */ }
    if (on !== null) saveConfig({ floatOnConsoleClose: on });
    return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({
      ok: true, floatWin: floatWinState(),
    }));
  }

  // 临时直连开关（V4.14.9）：暂停/恢复缓存接管，不改任何持久化配置。
  //   POST /api/pac-bypass?on=1   暂停（把系统槽位让出去，浏览器流量回到加速器/直连）
  //   POST /api/pac-bypass?on=0   恢复（重新接管；若期间槽位被加速器占了，走既有的
  //                               「从外来 PAC 提取代理并串接」或让位逻辑，不会硬抢）
  // 场景：怀疑缓存引入问题时，一键对比"开/关缓存"，不必整个退出程序。
  // 重复发同一状态是幂等的：状态没翻转就不动 installPacSetting。
  if (rawUrl.startsWith('/api/pac-bypass') && req.method === 'POST') {
    let on = '';
    try { on = new URL('http://x' + rawUrl).searchParams.get('on') || ''; } catch { /* 忽略 */ }
    if ((on === '1' || on === '0') && (on === '1') !== pacBypass) {
      pacBypass = (on === '1');
      log('[控制台] 临时直连' + (pacBypass ? '开启 —— 缓存接管暂停' : '关闭 —— 恢复缓存接管'));
      await installPacSetting().catch(() => { /* 内部各分支已兜底 */ });
    }
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify({ ok: true, bypass: pacBypass, systemProxy: systemProxyInfo() }));
  }

  // ---------------------------------------------------------------- 设置面板（V4.15.2）
  //
  // 统一的功能开关入口：GET /api/settings 读全部状态，POST /api/set-feature?name=&on= 逐个切。
  // 三类底层：config.json 字段（saveConfig）/ 运行态（缓存暂停 = pacBypass）/ 系统启动项（注册表）。
  // name 白名单在 SETTING_CONFIG_KEYS，绝不允许任意键直写 config。
  const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const RUN_VAL = 'GBFCache';

  function exeForAutostart() {
    const p = path.join(__dirname, 'GBFCache.exe');
    return fs.existsSync(p) ? p : null;
  }

  async function autoStartState() {
    const exe = exeForAutostart();
    if (!exe) return { supported: false, on: false };
    const { execFile } = require('child_process');
    const out = await new Promise((resolve) => {
      execFile('reg', ['query', RUN_KEY, '/v', RUN_VAL], { timeout: 5000, windowsHide: true },
        (e, so) => resolve(e ? '' : String(so || '')));
    });
    return { supported: true, on: /REG_SZ/.test(out) };
  }

  async function setAutoStart(on) {
    const exe = exeForAutostart();
    if (!exe) return { ok: false, error: '程序目录里没有 GBFCache.exe（源码开发目录不支持开机自启）' };
    const { execFile } = require('child_process');
    const run = (args) => new Promise((resolve) => {
      execFile('reg', args, { timeout: 5000, windowsHide: true }, (e) => resolve(!e));
    });
    if (on) {
      if (!(await run(['add', RUN_KEY, '/v', RUN_VAL, '/t', 'REG_SZ', '/d', exe, '/f']))) {
        return { ok: false, error: '写入系统启动项失败' };
      }
    } else if (!(await run(['delete', RUN_KEY, '/v', RUN_VAL, '/f']))) {
      return { ok: false, error: '删除系统启动项失败（可能本来就不存在）' };
    }
    return { ok: true };
  }

  function settingsState() {
    return {
      prewarmEnabled: config.prewarmEnabled === true,   // V4.16.0：默认平衡档，全库预热默认关
      followEnabled: config.followEnabled !== false,    // 跟随式小预热：默认开
      prewarmMigrateOnly: config.prewarmMigrateOnly === true,
      prewarmNotify: config.prewarmNotify !== false,
      autoEvictStamps: config.autoEvictStamps === true,
      openDashboardOnStart: config.openDashboardOnStart !== false,
      consoleBrowserPath: consoleBrowserPath(),
      autoLaunchGame: config.autoLaunchGame !== false,
      autoLaunchAccel: config.autoLaunchAccel !== false,
      floatOnConsoleClose: config.floatOnConsoleClose !== false,
      cacheEnabled: !pacBypass,
      autoStartWithWindows: null,   // GET 端点会用注册表实况补上（查询要起子进程，不跟着轮询跑）
    };
  }

  if (rawUrl === '/api/settings') {
    const st = settingsState();
    st.autoStartWithWindows = await autoStartState();
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify({ ok: true, settings: st }));
  }

  if (rawUrl.startsWith('/api/set-feature') && req.method === 'POST') {
    let name = '', on = null;
    try {
      const u = new URL('http://x' + rawUrl);
      name = (u.searchParams.get('name') || '').trim();
      on = u.searchParams.get('on') === '1' ? true : (u.searchParams.get('on') === '0' ? false : null);
    } catch { /* 忽略 */ }
    const fail = (code, error) => send(res, code,
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify({ ok: false, error }));
    // P0-5 ④：更新日模式一键预设（安静/平衡/积极）——先于 on 校验处理（它不带 on）
    if (name === 'prewarmMode') {
      let mode = '';
      try { mode = (new URL('http://x' + rawUrl)).searchParams.get('mode') || ''; } catch { /* 忽略 */ }
      const presets = {
        quiet: { prewarmEnabled: false, followEnabled: false },
        balanced: { prewarmEnabled: false, followEnabled: true },
        aggressive: { prewarmEnabled: true, followEnabled: true },
      };
      if (!presets[mode]) return fail(400, '未知的更新日模式：' + mode);
      saveConfig(presets[mode]);
      log('[设置] 更新日模式 = ' + mode);
      return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        JSON.stringify({ ok: true, name, mode }));
    }
    if (on === null) return fail(400, '缺 on 参数（1 / 0）');

    if (name === 'cacheEnabled') {
      // 缓存开关 = 临时直连的反向（滑块开 = 缓存工作中）。滑块关 = 把 PAC 槽位让出去。
      if (pacBypass === on) {
        pacBypass = !on;
        log('[设置] 缓存功能' + (on ? '恢复' : '暂停') + '（临时直连' + (pacBypass ? '开' : '关') + '）');
        await installPacSetting().catch(() => { /* 内部已兜底 */ });
      }
      return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        JSON.stringify({ ok: true, name, on }));
    }
    if (name === 'autoStartWithWindows') {
      const r = await setAutoStart(on);
      log('[设置] 开机自动启动 = ' + (on ? '开' : '关') + '：' + (r.ok ? '成功' : (r.error || '失败')));
      return send(res, r.ok ? 200 : 500,
        { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        JSON.stringify(Object.assign({ ok: r.ok, name, on }, r.error ? { error: r.error } : {})));
    }
    const cfgKeys = {
      prewarmEnabled: (v) => ({ prewarmEnabled: v }),
      followEnabled: (v) => ({ followEnabled: v }),
      prewarmMigrateOnly: (v) => ({ prewarmMigrateOnly: v }),
      prewarmNotify: (v) => ({ prewarmNotify: v }),
      autoEvictStamps: (v) => ({ autoEvictStamps: v }),
      openDashboardOnStart: (v) => ({ openDashboardOnStart: v }),
      autoLaunchGame: (v) => ({ autoLaunchGame: v }),
      autoLaunchAccel: (v) => ({ autoLaunchAccel: v }),
      floatOnConsoleClose: (v) => ({ floatOnConsoleClose: v }),
    };
    if (!cfgKeys[name]) return fail(400, '未知的功能名：' + name);
    const patch = cfgKeys[name](on);
    // V4.20.3：跟随预热与全库预热是**包含关系**（与三档预设一致：全库开 ⇒ 跟随必开）。
    // 归一放在这个统一入口 —— 直连 API 也生不出"全库开、跟随关"（最主动的扫描却没有任何
    // 关键路径保护）；反向同理：关跟随 = 退回不接受任何主动预热。
    if (patch.prewarmEnabled === true) patch.followEnabled = true;
    if (patch.followEnabled === false) patch.prewarmEnabled = false;
    saveConfig(patch);
    log('[设置] ' + name + ' = ' + (on ? '开' : '关'));
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify({ ok: true, name, on }));
  }

  // 手动显示/收起：托盘菜单、控制台的「立即显示」按钮，以及**用户直接关掉悬浮条**
  //（关掉时托盘会来调它，把 manual 钉成 false —— 于是它不会再被自动判定弹回来，
  //  这正是 V4.13.0 那版"关不掉"的修法）。
  if (rawUrl.startsWith('/api/float-toggle') && req.method === 'POST') {
    const cur = floatWinState();
    floatManualWant = !cur.show;
    return send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({
      ok: true, floatWin: floatWinState(),
    }));
  }

  // 自检页面：用探针图做「确定性」判断（源站不存在该文件，能加载 = 请求确实到了本机服务）。
  //
  // 【为什么探针走 akamaized 而不是游戏本站】—— V4.3.4 修的坑：
  // 游戏本站（granbluefantasy.jp）的 PAC 规则是"**只有 /assets/ 走缓存**、接口直连"，
  // 也就是说那条规则要靠 URL 里的路径来判定。实测在 Windows 的 PAC 引擎上，按路径判定
  // 有可能不命中，于是探针请求会落到 PAC 的兜底（交给加速器）→ 加速器转发到源站 →
  // 源站没有这个文件 → 404。而自检页当时把任何失败都归咎于"浏览器扩展没生效"，把排查方向带偏。
  // 资源域名（*.akamaized.net）是**整域**交给本程序的，判定不依赖路径，稳。
  //
  // 所以这一版：探针走整域代理的域名做**最终判定**；游戏本站那条只作"附加观察"，
  // 并且本页会把 PAC 对几条代表性 URL 的判定直接显示出来 —— 路由问题能被一眼看见。
  if (rawUrl === '/test' || rawUrl.startsWith('/test?')) {
    const PROBE_URL = 'https://prd-game-a-granbluefantasy.akamaized.net/assets/__gbfcache_selftest__.png';
    const GAME_H = 'game.granbluefantasy.jp';
    const PROXY_TXT = HOST + ':' + PROXY_PORT;
    const html = `<!doctype html><meta charset="utf-8"><title>缓存自检</title>
<style>
 body{font:14px/1.75 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:#0e1116;color:#e6edf3;padding:26px}
 h2{margin:0 0 4px;font-size:17px}
 h3{margin:20px 0 6px;font-size:14px;color:#c9d1d9}
 .dim{color:#8b949e;font-size:12.5px}
 #verdict{margin:16px 0;padding:14px 16px;border-radius:9px;font-size:14px;
          background:#161b22;border-left:4px solid #8b949e;line-height:1.7}
 #verdict.ok{border-color:#3fb950;background:rgba(63,185,80,.09)}
 #verdict.bad{border-color:#f85149;background:rgba(248,81,73,.10)}
 #verdict.wait{border-color:#d29922;background:rgba(210,153,34,.08)}
 #probe{margin:10px 0 18px;padding:10px;background:#0b0e13;border:1px solid #262d38;border-radius:8px}
 table{border-collapse:collapse;font-size:12.5px;width:100%}
 td{padding:4px 10px 4px 0;vertical-align:top}
 .ok{color:#3fb950}.bad{color:#f85149}.wait{color:#d29922}
 code{background:#0b0e13;border:1px solid #262d38;border-radius:4px;padding:1px 5px;font-size:12px}
 ol{padding-left:20px;margin:8px 0 0}
 li{margin:3px 0}
 .box{background:#0b0e13;border:1px solid #262d38;border-radius:8px;padding:10px 12px;margin:8px 0}
</style>
<h2>缓存自检</h2>
<div class="dim">本页会请求一个名叫 <code>__gbfcache_selftest__.png</code> 的文件 —— 它在游戏源站上<b>并不存在</b>，
只可能由你本机的缓存服务提供。所以「能加载出来」等价于「游戏资源请求确实被送到了本机缓存服务」。
探针走的是<b>整域都交给本程序</b>的资源域名（<code>akamaized.net</code>），不依赖任何"按路径分流"的规则。</div>

<div id="verdict" class="wait">正在检测…</div>

<div>探针图（应显示为一个青色小方块）：</div>
<div id="probe"></div>

<h3>PAC 分流判定（本页就地求值，反映浏览器应当看到的分流结果）</h3>
<div class="dim">这几行回答的是"这条请求会被交给谁" —— 如果探针那条不是本程序，问题在分流，而不是浏览器扩展。</div>
<table id="pacRows"><tr><td class="wait">读取中…</td></tr></table>

<h3>接管状态与根证书</h3>
<div class="dim">根证书必须装在「受信任的根证书颁发机构」；命令行要用 <code>-addstore -f Root</code>，
<b>不要用 <code>-addstore CA</code></b>（那是「中间证书颁发机构」，浏览器不认 ——
症状是资源<b>全部</b>加载失败、缓存几乎不增长，很容易被当成网络问题）。</div>
<table id="envRows"><tr><td class="wait">读取中…</td></tr></table>

<h3>附加观察（不影响上面的判定）</h3>
<table id="rows"></table>

<script>
var PROBE_URL = ${JSON.stringify(PROBE_URL)};
var PROXY_TXT = ${JSON.stringify(PROXY_TXT)};
var GAME_H = ${JSON.stringify(GAME_H)};

function line(cls, name, note) {
  return '<tr><td class="' + cls + '" style="width:58px">' + name + '</td><td>' + note + '</td></tr>';
}

/* ---------- 把 PAC 脚本取来就地求值：回答"这条 URL 会被交给谁" ---------- */
// PAC 脚本依赖几个内置函数，这里补齐最小实现；求不出来就如实显示"求值失败"。
function isPlainHostName(h) { return String(h).indexOf('.') === -1; }
function shExpMatch(str, pat) {
  var re = '^' + String(pat).replace(/[.+^$\{\}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*/g, '.*').replace(/\\?/g, '.') + '$';
  try { return new RegExp(re).test(String(str)); } catch (e) { return false; }
}
function dnsDomainIs(h, d) { h = String(h); d = String(d); return h.length >= d.length && h.slice(-d.length) === d; }
function localHostOrDomainIs(h, hd) { h = String(h); hd = String(hd); return h === hd || h.indexOf(hd + '.') === 0; }
function dnsDomainLevels(h) { return (String(h).match(/\\./g) || []).length; }
function isResolvable() { return false; }
function isInNet() { return false; }
function dnsResolve() { return null; }
function myIpAddress() { return '127.0.0.1'; }

function pacLookup(url) {
  var host = url.replace(/^https?:\\/\\//, '').split('/')[0];
  try {
    var factory = new Function('isPlainHostName', 'shExpMatch', 'dnsDomainIs', 'localHostOrDomainIs',
      'dnsDomainLevels', 'isResolvable', 'isInNet', 'dnsResolve', 'myIpAddress',
      PAC_TEXT + '\\nreturn FindProxyForURL;');
    var f = factory(isPlainHostName, shExpMatch, dnsDomainIs, localHostOrDomainIs,
      dnsDomainLevels, isResolvable, isInNet, dnsResolve, myIpAddress);
    return String(f(url, host));
  } catch (e) { return '求值失败：' + e.message; }
}

var PAC_TEXT = null;
fetch('/proxy.pac', { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (t) {
  PAC_TEXT = t;
  // 每行：URL、期望（'ours' = 应当交给本程序；'other' = 应当不交给本程序）
  var cases = [
    ['资源域名（探针走的就是这里）', 'https://prd-game-a-granbluefantasy.akamaized.net/assets/x.png', 'ours'],
    ['游戏本站的 /assets/（按路径判定）', 'https://' + GAME_H + '/assets/x.png', 'ours'],
    ['游戏本站的接口 /rest/（必须直连）', 'https://' + GAME_H + '/rest/user/content/index', 'other'],
    ['其它站点', 'https://www.example.com/', 'any']
  ];
  var out = '';
  cases.forEach(function (c) {
    var d = pacLookup(c[1]);
    var ours = d.indexOf(PROXY_TXT) !== -1;
    var cls = c[2] === 'ours' ? (ours ? 'ok' : 'bad') : (c[2] === 'other' ? (ours ? 'bad' : 'ok') : 'wait');
    out += '<tr><td class="' + cls + '" style="width:58px">' +
      (cls === 'ok' ? '符合' : cls === 'bad' ? '不符' : '—') + '</td><td>' + c[0] +
      '<br><span style="color:#6e7681">' + c[1] + '</span><br>判定：<code>' + d + '</code></td></tr>';
  });
  document.getElementById('pacRows').innerHTML = out;
}).catch(function (e) {
  document.getElementById('pacRows').innerHTML =
    line('bad', '失败', '取不到 /proxy.pac：' + e.message + '（服务端可能在旧版本）');
});

/* ---------- 接管状态：直接问服务端（注册表事实），不靠猜 ---------- */
var takeover = { mode: '?', installed: null, autoConfig: '' };
var CERT = null;   // 服务端查出来的根证书存储位置（装错位置是"资源全废"的常见真因）
var CERT_LABEL = {
  ok: '已装好', misplaced: '装错位置', missing: '没找到', stale: '是旧的那张', unknown: '未能判定'
};
fetch('/api/stats', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
  var sp = d.systemProxy || {};
  takeover = { mode: sp.mode || '?', installed: sp.installed, autoConfig: sp.autoConfig || '' };
  CERT = d.cert || null;
  var certRows = '';
  if (CERT) {
    var cls = CERT.state === 'ok' ? 'ok' : (CERT.state === 'unknown' ? 'wait' : 'bad');
    var where = '';
    if (CERT.stores) {
      where = Object.keys(CERT.stores).map(function (k) {
        // 用正则吃掉前缀里的那个反斜杠：页面 JS 源码里不出现反斜杠字面量，
        // 免得在「server.js 模板字符串 -> 页面 JS」的两层转义里把引号转义掉（踩过）。
        var nm = k.replace(/^CurrentUser./, '当前用户/').replace(/^LocalMachine./, '本地计算机/');
        return nm + (CERT.stores[k].exact > 0 ? ' <b>在</b>' : ' —');
      }).join('　');
    }
    certRows =
      line(cls, CERT_LABEL[CERT.state] || CERT.state,
        '根证书位置（本程序要在本地解密 HTTPS，证书必须装在「受信任的根证书颁发机构」）' +
        '<br><span style="color:#6e7681">' + where + '</span>' +
        '<br>' + CERT.advice +
        (CERT.fix ? '<br>修复命令：<code>' + CERT.fix[0] + '</code><br><code>' + CERT.fix[1] + '</code>' : '') +
        '　<button onclick="recheckCert()">重新检查</button>');
  }
  document.getElementById('envRows').innerHTML =
    line(takeover.installed ? 'ok' : 'bad', takeover.installed ? '已接管' : '未接管',
      '接管方式 <code>' + takeover.mode + '</code>　系统自动配置脚本：<code>' + (takeover.autoConfig || '（空）') + '</code>') +
    (takeover.foreign && takeover.foreign.url
      ? line('bad', '槽位被占',
          '系统「自动配置脚本」被<b>别的程序</b>占用：<code>' + takeover.foreign.url + '</code><br>' +
          '本程序<b>没有接管</b>它（避免与加速器互抢），因此<b>缓存不会生效</b>。<br>' +
          '没接管的原因：' + (takeover.foreign.reason || '未知') + '<br>' +
          '<b>可选做法</b>：① 把加速器改成「静态代理 / 全局代理」模式 —— 本程序能自动识别并串接它，' +
          '缓存与加速并用（<b>首选</b>）；② 在占用它的程序里关掉「系统代理 / PAC」，然后重启本程序；' +
          '③ 若它不依赖 PAC（TUN 网卡 / 路由模式），可加载随包的 <code>console-extension</code>' +
          '（浏览器层优先级高于系统设置）；④ 确认不再需要它时，再手动清空该槽位。')
      : '') +
    line('wait', '说明',
      '接管方式为 <code>system</code> 时，浏览器<b>不需要装扩展</b>：系统代理设置对所有浏览器生效。' +
      '随包的 <code>console-extension</code> 是可选兜底 —— 它给 Chromium 内核浏览器单独挂上本程序的 PAC' +
      '（在 Chromium 里扩展的代理设置优先于系统设置），适合系统槽位被加速器/别的代理占用的情况；不装也能正常缓存。') +
    certRows;
}).catch(function (e) {
  document.getElementById('envRows').innerHTML = line('bad', '失败', '取不到 /api/stats：' + e.message);
});

function recheckCert() {
  fetch('/api/cert-check', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.cert) { CERT = d.cert; }
    location.reload();
  }).catch(function (e) { alert('重新检查失败：' + e.message); });
}

/* ---------- 探针：最终判定 ---------- */
var probe = new Image();
var settled = false;

probe.onload = function () {
  if (settled) return; settled = true;
  var v = document.getElementById('verdict');
  v.className = 'ok';
  v.innerHTML = '<b>✅ 接管正常</b><br>' +
    '探针图由你本机的缓存服务返回，说明游戏资源请求确实被转到了这里。' +
    '如果控制台里日志很少或为空，通常是因为资源已经全部命中<b>浏览器自身的缓存</b>，' +
    '根本不需要发起网络请求 —— 那是最理想的状态。';
  document.getElementById('rows').innerHTML = line('ok', '探针', '正常（这是关键结论）');
  runAssets();
};

probe.onerror = function () {
  if (settled) return; settled = true;
  var v = document.getElementById('verdict');
  v.className = 'bad';
  var pac = PAC_TEXT ? pacLookup(PROBE_URL) : '（还没取到 PAC）';
  var pacOurs = PAC_TEXT ? pac.indexOf(PROXY_TXT) !== -1 : null;
  var certItem = '';
  if (CERT && CERT.state !== 'ok' && CERT.state !== 'unknown') {
    certItem = '<li><b>根证书有问题（这一页已经替你查实）</b>：' + CERT.advice +
      (CERT.fix ? '<br>修复命令：<code>' + CERT.fix.join('</code>　然后　<code>') + '</code>' : '') + '</li>';
  }
  var head = '<b>❌ 探针没走通</b><br>探针图没能加载 —— 请求没被送到本机缓存服务。' +
    '这里按<b>已经测出来的数据</b>分几种原因，别一律当成扩展问题：<ol>' + certItem +
    '<li><b>分流没把这条请求交给本程序</b>：上面「PAC 分流判定」里探针那条的判定是 <code>' + pac + '</code>' +
    (pacOurs === false ? ' —— <b>确实不是本程序</b>，问题在分流（例如被加速器/别的代理接管），与浏览器扩展无关。' : '。') + '</li>' +
    '<li><b>请求交给了本程序、但连接没成功</b>：最常见的是<b>根证书没被信任</b>（本程序要在本地解密 HTTPS）。' +
    '双击 <code>certs\\ca.crt</code> → 安装证书 → 「当前用户」→「受信任的根证书颁发机构」→ 完成后' +
    '<b>完全退出浏览器再打开</b>（证书信任在启动时加载，只刷新页面不算）。</li>' +
    '<li><b>浏览器自己的代理设置被覆盖</b>：某些代理类扩展会盖掉系统设置（先禁用试试）。' +
    '若你手动加载过本程序的 <code>console-extension</code>，再去 <code>edge://extensions</code> 确认它的开关与「开发人员模式」。</li>' +
    '</ol>';
  var steps = '<div class="box"><b>决定性测试（30 秒）</b>：在<b>这个</b>浏览器的地址栏直接打开<br>' +
    '<code>' + PROBE_URL + '</code><br>' +
    '• 看到<b>青色小方块</b> → 一切正常，只是本页这一下没走通，点刷新即可<br>' +
    '• 看到<b>证书错误</b> → 属于上面第 2 条（证书）<br>' +
    '• 看到 <b>404 / Not Found</b> → 属于上面第 1 条（分流没交给本程序）</div>';
  v.innerHTML = head + steps;
  document.getElementById('rows').innerHTML = line('bad', '探针', '失败 —— 按上面的分类定位');
};

document.getElementById('probe').appendChild(probe);
probe.src = PROBE_URL + '?_=' + Date.now();

// 8 秒还没结论就如实说明。旧版这里提示用户"去确认控制台窗口还开着"——
// 而发行版是 GUI 子系统、根本没有控制台窗口，那句早已过期，本次一并移除。
setTimeout(function () {
  if (!settled) {
    var v = document.getElementById('verdict');
    v.className = 'wait';
    v.innerHTML = '<b>检测超时</b><br>探针请求既没成功也没失败。请确认程序仍在运行' +
      '（托盘图标还在、控制台能打开），然后点本页刷新重试。';
  }
}, 8000);

/* ---------- 附加观察：真实资源的加载情况（不是判断依据）---------- */
function runAssets() {
  var rows = document.getElementById('rows');
  var ASSETS = [
    { p: '/assets/img/sp/arcarum/common/bg.png', note: '图片，缓存中有' },
    { p: '/assets/img/sp/arcarum/header.jpg', note: '图片，缓存中有' },
    { p: '/assets/1662343412/js/config.js', note: '脚本，缓存中以 gzip 存放' },
    { p: '/assets/font/basic_number.woff', note: '字体，缓存中有' },
    { p: '/assets/img/definitely-not-exist-zzz.png', note: '故意放的、确实不存在的文件', expect404: true }
  ];
  ASSETS.forEach(function (item, i) {
    var t = document.createElement('tr');
    t.innerHTML = '<td class="wait" style="width:58px">检测中</td><td>' + item.p +
      ' <span style="color:#6e7681">— ' + item.note + '</span></td>';
    rows.appendChild(t);

    var done = false;
    var mark = function (cls, txt) {
      if (done) return; done = true;
      t.firstChild.className = cls; t.firstChild.textContent = txt;
    };

    fetch('https://prd-game-a-granbluefantasy.akamaized.net' + item.p + '?_=' + Date.now() + i, { cache: 'no-store' })
      .then(function (r) {
        if (item.expect404) mark('ok', '' + r.status);
        else if (r.ok) mark('ok', 'HTTP ' + r.status);
        else mark('bad', 'HTTP ' + r.status);
      })
      .catch(function () {
        // 请求没被转发时，源站不会给出允许本页跨域的头，fetch 会直接抛错
        mark(item.expect404 ? 'ok' : 'bad', '未转发');
      });

    setTimeout(function () { mark('wait', '超时'); }, 9000);
  });
}
</script>`;
    return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, html);
  }

  // 扩展诊断回报通道（调试用）
  if (rawUrl.startsWith('/_diag')) {
    const u = new URL('http://x' + rawUrl);
    const tag = u.searchParams.get('tag') || '?';
    const d = u.searchParams.get('d') || '';
    console.log(`[DIAG:${tag}] ${d}`);
    return send(res, 200, { 'Content-Type': 'text/plain' }, 'ok');
  }

  // 控制台的 /api/* 走到这里就说明**没有匹配的端点** —— 本地直接回 404，不要放它下去。
  //
  // 【为什么必须显式挡掉，V4.8.7 实测】不挡的话它会掉进下面的"代理/回源"分支：
  //   · 被当成一条资源请求 → 记一条 WARN、并把 stats.dynamic 加一（那个数字本该**恒为 0**）；
  //   · 然后**跑去游戏源站取**这个接口 —— 于是"已删除的端点返回 404"这条自测断言
  //     变成了**依赖上游网络**的断言：上游慢一点或 RST 一次，探测就报"传输层拿不到响应"。
  // 实测现场（do-all 自测实例的日志）：
  //     WARN 非静态路径被拦截: /api/launch-args
  //     MISS /api/launch-args  ->  依次尝试 game.granbluefantasy.jp / ...
  //     [回源] read ECONNRESET —— 300ms 后重试（第 2/3 次）
  // 连红两轮构建都是它。并且 /api/launch-args 在 V4.3.6 就被删了，本该永远 404（现已改为本地 404）。
  // /stats 同理：它是给脚本看的原始统计，走到这里也说明没匹配上。
  if (rawUrl.startsWith('/api/') || rawUrl === '/stats') {
    return send(res, 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify({ ok: false, error: '没有这个接口：' + rawUrl }));
  }

  // 解析请求路径：
  //   /f/<host>/<path>   显式指定原始主机
  //   /<path>            裸路径，按 GBF 处理（扩展用 transform 改写主机后就是这种形式）
  let host, rest;
  const m = /^\/f\/([^\/]+)(\/.*)$/.exec(rawUrl);
  if (m) {
    host = m[1];
    rest = m[2];
  } else {
    host = 'game.granbluefantasy.jp';
    rest = rawUrl;
  }

  let query = '';
  const qi = rest.indexOf('?');
  if (qi >= 0) {
    query = rest.slice(qi);
    rest = rest.slice(0, qi);
  }

  const fsRoot = cacheRootFor(host);
  const fsPath = cachePathFor(fsRoot, rest);

  // 防线：本服务只该处理静态资源。若收到没有静态扩展名的路径（例如 /user/content/index），
  // 说明扩展的拦截范围过宽，把动态接口也劫持进来了 —— 这类请求需要携带该域的 Cookie，
  // 而浏览器不会把 granbluefantasy.jp 的 Cookie 发到 127.0.0.1，所以必然拿不到正确结果。
  // 这里明确报警，方便定位；响应仍尽力回源，避免直接报错。
  // 自检探针：只有本服务会返回它，源站没有这个文件。
  //
  // 这是界面用来判断「扩展是否还在拦截」的内部健康检查，不是真实的缓存业务请求，
  // 因此**故意不写入请求日志、也不计入任何统计** —— 否则每分钟一条假 HIT 会把日志刷满，
  // 还会让「缓存命中」这个数字失真。界面改为显示 lastProbeAt（最后检测时间）来体现它。
  if (rest === SELFTEST_PATH) {
    lastProbeAt = Date.now();
    probeCount++;
    return send(res, 200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-GBFCache-Selftest': 'ok',
    }, SELFTEST_PNG);
  }

  // 观测 X-VERSION。必须放在这里（早退与分支判断之前）：历史日志显示它只出现在
  // /rest/ 这类**非资源**请求上，若挪进静态资源分支就会永远读不到。
  noteXVersion(req, rest);

  const reqExt = path.extname(rest).toLowerCase();
  const isStaticPath = reqExt !== '' && CACHEABLE_EXT.has(reqExt);
  if (!isStaticPath) {
    stats.dynamic++;
    pushLog({ tag: 'WARN', path: rest + query, source: 'over-reach' });
    noteError(`拦截到非静态路径 ${rest}${query} —— 该请求本不该被扩展劫持，请检查 console-extension/rules.json`);
    log(`WARN 非静态路径被拦截: ${rest}${query}`);
  } else {
    // 被动学习"这个戳还在被用"（V4.7.3）。放进 else 分支：只有真按资源处理的请求才算，
    // 与上面那条 WARN 互斥。（noteStampFromPath 内部还会再校验 /assets/<纯数字>/ 的形状，
    // 所以这里的"静态资源"判定即便偏宽也不会记进奇怪的东西。）
    // V4.20.0：这条通道（扩展 /f/，旧的按规则拦截路径）同样是"有人在游玩"的证据 ——
    // 闲置缓扫的启动与暂停止损都读这个时钟，漏掉这里会让走扩展的用户"锁着玩"时被当成闲置。
    if (req.method === 'GET' || req.method === 'HEAD') {
      lastProxyRequestAt = Date.now();
      lastProxyRequestPath = rest;
    }
    noteStampFromPath(rest);
  }

  // 1) 尝试命中缓存（V4.12.0：与 handleIntercepted 共用 lookupCache，读盘/解压已异步化）
  const hit = await lookupCache(req, fsRoot, fsPath, rest, query);
  if (hit.kind === 'not-modified') return send(res, 304, hit.headers);
  if (hit.kind === 'hit') {
    const r = applyHitRange(req, hit.headers, hit.body);   // P0-4：单区间本地切片（206/416）
    return send(res, r.status, r.headers, req.method === 'HEAD' ? undefined : r.body);
  }

  // 1.5) 按需过户（V4.15.10）：版本切换后的首批请求会赶在后台预热前面 —— 就地用
  //      旧戳副本过户/落库，避免这批热点文件整包重下（详见 migrateOnMiss 一节）。
  //      只在无查询串、可缓存扩展名上做（有查询串的资源走版本号比对语义，不搅和）。
  if (query === '' && fsPath && CACHEABLE_EXT.has(path.extname(rest).toLowerCase())
      && await migrateOnMiss(host, rest, fsPath, req)) {
    const hit2 = await lookupCache(req, fsRoot, fsPath, rest, query);
    if (hit2.kind === 'not-modified') return send(res, 304, hit2.headers);
    if (hit2.kind === 'hit') {
      const r = applyHitRange(req, hit2.headers, hit2.body);   // P0-4：单区间本地切片（206/416）
      return send(res, r.status, r.headers, req.method === 'HEAD' ? undefined : r.body);
    }
    // 极端情况（落库被内容体检拒收等）：落回下面的正常回源
  }

  // 2) 未命中 -> 回源
  // 依次尝试候选源站主机：资源可能在 game.granbluefantasy.jp，也可能在 Akamai CDN 上
  stats.miss++;
  pushLog({
    tag: 'MISS',
    path: rest + query,
    source: hit.kind === 'mismatch' ? 'version-mismatch' : 'upstream',
  });
  log(`MISS ${rest}  ->  依次尝试 ${ORIGIN_HOSTS.join(' / ')}`);

  try {
    // 回源合并（V4.9.0）：同一资源同一版本的并发请求只放第一个出网
    const { up, tried, leader: isLeader } = await fetchOriginShared(
      host + rest + query,
      async () => {
        // 耗时打点（V4.11.0）：包在队首 fetcher 里，只有真正出网的那次会记。
        // 用 finally —— 失败的回源（超时/重试）也要进分布，p99 靠它说话。
        const t0 = Date.now();
        try {
          return await fetchFromAnyOrigin(rest, query, req.headers);
        } finally {
          noteOriginLatency(Date.now() - t0);
        }
      });
    if (tried && (tried.length > 1 || up.status !== 200)) {
      log(`  源站: ${tried.join(' | ')}  [${req.method}] origin=${req.headers.origin || '-'}`);
    }
    if (!up) throw new Error('所有候选源站都没有返回响应：' + (tried || []).join(' | '));

    const ct = up.headers['content-type'] || MIME[path.extname(rest).toLowerCase()] || 'application/octet-stream';

    // 写回缓存（仅静态资源 & 200 & 有内容 & 本次回源是队首——被合并的等待者不重复写）。
    // 不等待写入完成：writeCacheEntry 内部已做内容体检与原子落盘，失败只记日志，
    // 绝不影响本次响应 —— 响应不等磁盘。
    if (isLeader && fsPath && up.status === 200 && up.body.length > 0
        && CACHEABLE_EXT.has(path.extname(rest).toLowerCase())) {
      writeCacheEntry(fsPath, up.body, ct, null, query, up.headers).catch((e) => {
        log(`写缓存异常 ${fsPath}: ${e.message}`);
      });
    }

    const upHeaders = {
      'Content-Type': ct,
      'Content-Length': up.body.length,
      'Cache-Control': up.headers['cache-control'] || 'public, max-age=86400',
      'X-GBFCache-Source': noteSource('upstream'),
    };
    // 源站如果返回 3xx，Location 必须透传，否则浏览器跟不过去
    if (up.headers['location']) upHeaders['Location'] = up.headers['location'];
    // P0-4：Range 相关的头必须完整透传 —— 206/416 缺 Content-Range 是畸形响应
    //（取证见 applyHitRange 上方注释：2026-10-14 实测到 206 缺头）。
    if (up.headers['content-range']) upHeaders['Content-Range'] = up.headers['content-range'];
    if (up.status === 206) upHeaders['Accept-Ranges'] = up.headers['accept-ranges'] || 'bytes';
    if (up.headers['content-disposition']) upHeaders['Content-Disposition'] = up.headers['content-disposition'];
    return send(res, up.status, upHeaders, req.method === 'HEAD' ? undefined : up.body);
  } catch (e) {
    stats.error++;
    pushLog({ tag: 'ERR', path: rest + query, source: 'upstream-fail', detail: e.message });
    noteError(`回源失败 ${rest}${query}: ${e.message}`);
    log(`回源失败 ${rest}${query}: ${e.message}`);
    return send(res, 502, { 'Content-Type': 'text/plain; charset=utf-8' },
      `回源失败: ${e.message}\n\n该资源不在本地缓存中，且无法连接源站。\n`);
  }
}

const HOST_LOG_VERBOSE = process.env.GBFCACHE_VERBOSE === '1' || process.env.ACGP_VERBOSE === '1';

// ---------------------------------------------------------------- HTTPS 中间人代理
//
// 为什么需要它：走「扩展重定向到 127.0.0.1」这条路时，请求的源(origin)被改了，
// 浏览器会拒绝「携带凭据的跨源请求被重定向到另一个源」（实测报 InvalidAllowCredentials），
// 导致游戏里大量用 XHR/fetch 加载的资源直接失败、界面加载不出来。
//
// 代理方案不改变请求的域名和协议：浏览器把请求交给代理，代理再以原样去取。
// 对浏览器而言 origin 始终没变，所以 CORS、Cookie、Referer 全部正常。
// 代价是需要一张本地信任的根证书来做 TLS 解密（沿用既有方案的做法）。

const tls = require('tls');
const PROXY_PORT = parseInt(process.env.GBFCACHE_PROXY_PORT || '8899', 10);
const CERT_DIR = path.join(__dirname, 'certs');

let tlsContext = null;
function loadCerts() {
  try {
    tlsContext = tls.createSecureContext({
      key: fs.readFileSync(path.join(CERT_DIR, 'server.key')),
      cert: fs.readFileSync(path.join(CERT_DIR, 'server.crt')),
    });
    return true;
  } catch (e) {
    tlsContext = null;
    return false;
  }
}

// 需要接管的域名（其余一律按普通代理转发，不解密）
// 注意：CDN 主机是 prd-game-a-granbluefantasy.akamaized.net，
// 其中 granbluefantasy 前面是「连字符」而不是点号，
// 所以任何要求域名边界(^|\.)的写法都匹配不到它 —— 只能用后缀匹配。
// V4.14.4：**英语树用的是另一套 CDN** —— prd-game-a-gbf.akamaized.net，
// 那个域名里根本没有 granbluefantasy 这个词（手机端实测踩过同一个坑）。
const INTERCEPT_HOST_RE = /(?:granbluefantasy\.(?:jp|akamaized\.net)|gbf\.akamaized\.net)$/i;

// 只缓存素材路径下的静态资源（日语 /assets/、英语 /assets_en/ —— V4.14.4）。
// 这一点很关键：游戏接口（/rest/...、/user/... 等）返回的是带登录态的动态内容，
// 绝不能因为路径恰好以 .json/.js 结尾就被当成资源缓存下来。
function proxyCacheable(p) {
  if (!ASSET_PATH_RE.test(p)) return false;
  return CACHEABLE_EXT.has(path.extname(p).toLowerCase());
}

// 4xx/5xx 时留现场用。X-VERSION 是游戏给每个 XHR 带的「客户端资源版本」，
// 页面上则是 server-props.version；两者不一致就说明页面自身是旧的。
function describeReq(req) {
  const h = req.headers || {};
  return `x-version=${h['x-version'] || '-'} referer=${h['referer'] || '-'}`
    + ` origin=${h['origin'] || '-'} mode=${h['sec-fetch-mode'] || '-'}`;
}

// 处理解出来的内层 HTTP 请求：此时 host/path/query 与原站完全一致
// （V4.12.0 起为 async：命中查找走 lookupCache 的异步读盘；调用方须接住返回的 Promise）
async function handleIntercepted(host, req, res) {
  const rawUrl = req.url || '/';
  let rest = rawUrl, query = '';
  const qi = rest.indexOf('?');
  if (qi >= 0) { query = rest.slice(qi); rest = rest.slice(0, qi); }

  // 自检探针必须最先判断 —— 它自带查询串，若不先处理会被下面的
  // 「带查询串绕过缓存」规则误转发到源站（源站并没有这个文件）。
  if (rest === SELFTEST_PATH) {
    lastProbeAt = Date.now();
    probeCount++;
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-GBFCache-Selftest': 'ok',
    });
    return res.end(SELFTEST_PNG);
  }

  // 观测 X-VERSION。必须放在这条早退**之前**：
  // /rest/ 这类请求（实测唯一见到 X-VERSION 的地方）走的就是下面那句
  // forwardTransparent 早退，挪到 isAssetReq 分支里就永远读不到。
  noteXVersion(req, rest);

  // 分流：只有素材路径（日语 /assets/、英语 /assets_en/）下的 GET/HEAD 才当作可缓存资源处理；
  // 其余（POST、/rest/ 接口、页面等）一律原样转发，绝不改动。
  const isAssetReq = (req.method === 'GET' || req.method === 'HEAD') && ASSET_PATH_RE.test(rest);
  if (isAssetReq) {
    // 给界面用：证明"确实有请求经过代理"（专用浏览器模式下的接管判据）
    lastProxyRequestAt = Date.now();
    lastProxyRequestPath = rest;
    // 被动学习"这个戳还在被用"（V4.7.3）—— 只在此处（确认是资源请求）记录，
    // 别放到 handle 入口那种"什么都算"的位置，否则 /rest/123 之类的路径也会被记进来。
    noteStampFromPath(rest);
  }
  if (!isAssetReq) {
    return forwardTransparent(host, req, res);
  }

  // 带查询串的请求（游戏用 `?1729002592` 这类参数标记资源版本）**照常走缓存**，
  // 但命中前必须比对该版本号（见 cacheEntryMatchesQuery）：
  //   · 版本一致 -> 命中，直接读本地（这是常态，能省掉整次下载）
  //   · 版本不一致或本地没记过 -> 当作未命中，回源取了**并且写进缓存**
  //
  // 早先的写法是"带查询串一律不查也不写、直接透传"，理由是不能拿旧版本文件顶 —— 前半句
  // 是对的，后半句（连带不写）是过度保守：结果是这类资源**永远不落盘、每次进游戏都重下**，
  // 控制台上只看到一排 MISS 却没有任何 STORE（实测现象）。现在把"不能顶"精确成
  // "版本对不上就不命中"，写入照做。
  const fsRoot = cacheRootFor(host);
  const fsPath = cachePathFor(fsRoot, rest);

  // 1) 命中缓存 —— 与 handle 共用 lookupCache（V4.12.0 合并；此前是两份手抄的循环，
  //    已经多次出现"改了一处忘另一处"的漂移风险，现在只有一个地方可以改）
  const hit = await lookupCache(req, fsRoot, fsPath, rest, query);
  if (hit.kind === 'not-modified') {
    res.writeHead(304, hit.headers);
    return res.end();
  }
  if (hit.kind === 'hit') {
    const r = applyHitRange(req, hit.headers, hit.body);   // P0-4：单区间本地切片（206/416）
    res.writeHead(r.status, r.headers);
    return res.end(req.method === 'HEAD' ? undefined : r.body);
  }

  // 1.5) 按需过户（V4.15.10）：与 handle 同款 —— 莫让版本切换后的首批请求
  //      在后台预热轮到之前整包重下（详见 migrateOnMiss 一节）。
  if (query === '' && fsPath && proxyCacheable(rest)
      && await migrateOnMiss(host, rest, fsPath, req)) {
    const hit2 = await lookupCache(req, fsRoot, fsPath, rest, query);
    if (hit2.kind === 'not-modified') { res.writeHead(304, hit2.headers); return res.end(); }
    if (hit2.kind === 'hit') {
      const r = applyHitRange(req, hit2.headers, hit2.body);   // P0-4：单区间本地切片（206/416）
      res.writeHead(r.status, r.headers);
      return res.end(req.method === 'HEAD' ? undefined : r.body);
    }
    // 极端情况（落库被内容体检拒收等）：落回下面的正常回源
  }

  // 2) 未命中 -> 以原始 Host 回源（这里能拿到真实主机，不再需要猜）
  stats.miss++;
  pushLog({
    tag: 'MISS',
    path: rest + query,
    source: hit.kind === 'mismatch' ? 'version-mismatch' : 'proxy-upstream',
  });

  // 请求头照搬（只去逐跳头），保证源站收到的和浏览器发出的一致
  const fwd = upstreamHeaders(req.headers);

  // 回源合并（V4.9.0）：同一资源同一版本的并发请求只放第一个出网，
  // 等待者直接回放队首的响应、不重复写缓存。
  // fetchUpstream 解出来是 {status, headers, body}，必须包成 {up} 才与
  // fetchOriginShared 的消费端（下方解构、另一条路径的 fetchFromAnyOrigin）对齐；
  // V4.9.0/V4.10.0/V4.10.1 漏了这层包装，up 恒为 undefined，代理模式全量 502。
  fetchOriginShared(host + rest + query,
    async () => {
      // 耗时打点（V4.11.0）：与 handle 路径同名约定 —— 队首真正出网才记，失败也记。
      const t0 = Date.now();
      try {
        return await fetchUpstream(`https://${host}${rest}${query}`, fwd).then((up) => ({ up }));
      } finally {
        noteOriginLatency(Date.now() - t0);
      }
    })
    .then(({ up, leader: isLeader }) => {
    const ct = up.headers['content-type'] || MIME[path.extname(rest).toLowerCase()] || 'application/octet-stream';
    const cors = corsHeaders(up.headers, req);

    // 只队首写缓存，不等待写入完成（内容体检与原子落盘都在 writeCacheEntry 内部）
    if (isLeader && fsPath && up.status === 200 && up.body.length > 0 && proxyCacheable(rest)) {
      writeCacheEntry(fsPath, up.body, ct, cors, query, up.headers).catch((e) => {
        log(`写缓存异常 ${fsPath}: ${e.message}`);
      });
    }

    // 源站对资源回非 200 时留下现场：409/410 正是游戏弹
    // 「新しいバージョンがあります」并整页重载的触发码
    if (up.status !== 200) {
      pushLog({
        tag: String(up.status),
        path: rest + query,
        source: 'upstream-status',
        detail: describeReq(req),
      });
      if (up.status === 409 || up.status === 410 || up.status >= 500) {
        log(`[${up.status}] 资源回源 ${host}${rest}${query}  ${describeReq(req)}`);
      }
    }

    const out = {
      'Content-Type': ct,
      'Content-Length': up.body.length,
      'Cache-Control': up.headers['cache-control'] || 'public, max-age=86400',
      'X-GBFCache-Source': noteSource('upstream'),
    };
    if (up.headers['location']) out['Location'] = up.headers['location'];
    // P0-4：Range 相关的头必须完整透传（理由同上：206/416 缺 Content-Range 是畸形响应）
    if (up.headers['content-range']) out['Content-Range'] = up.headers['content-range'];
    if (up.status === 206) out['Accept-Ranges'] = up.headers['accept-ranges'] || 'bytes';
    Object.assign(out, cors);
    res.writeHead(up.status, out);
    res.end(req.method === 'HEAD' ? undefined : up.body);
  }).catch((e) => {
    stats.error++;
    noteError(`代理回源失败 ${host}${rest}: ${e.message}`);
    try {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`proxy upstream failed: ${e.message}`);
    } catch { /* 忽略 */ }
  });
}

function startProxy() {
  if (!loadCerts()) {
    log('[代理] 未找到 certs/server.crt，HTTPS 代理未启用');
    return;
  }

  // 内层 HTTP 服务器：把解密后的连接交给它处理
  const inner = http.createServer((req, res) => {
    const hostRaw = req.headers.host || '';
    const host = hostRaw.replace(/:\d+$/, '');
    handleIntercepted(host, req, res).catch((e) => {
      stats.error++;
      noteError(`代理处理异常 ${host}: ${e.message}`);
      try { res.writeHead(500); res.end(); } catch { /* 忽略 */ }
    });
  });

  const proxy = http.createServer((req, res) => {
    // 明文 HTTP 代理请求：绝对 URI 形式
    try {
      const u = new URL(req.url);
      const host = u.hostname;
      if (INTERCEPT_HOST_RE.test(host)) {
        req.url = u.pathname + u.search;
        req.headers.host = u.host;
        handleIntercepted(host, req, res).catch(() => { try { res.writeHead(400); res.end(); } catch { /* 忽略 */ } });
        return;
      }
      // 其余走普通转发
      const up = httpRequestForward(req, u);
      up.on('response', (r2) => {
        res.writeHead(r2.statusCode, r2.headers);
        r2.pipe(res);
      });
      up.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
      req.pipe(up);
    } catch {
      try { res.writeHead(400); res.end(); } catch {}
    }
  });

  // HTTPS：先回 200，再用我们的证书跟浏览器握手，冒充目标主机
  proxy.on('connect', (req, clientSocket, head) => {
    // 解析 CONNECT 目标。必须按 URL 解析，不能按冒号切：
    // 浏览器大量使用 IPv6，地址形如 [2400:3200::1]:443，按冒号切会得到 host='[2400'、port=3200，
    // 结果是「缓存模式的浏览器连不上任何网站」（curl 很少走 IPv6，所以 curl 测不出来）。
    let targetHost = '';
    let targetPort = 443;
    try {
      const u = new URL('https://' + req.url);
      targetHost = String(u.hostname).replace(/^\[|\]$/g, '');
      targetPort = parseInt(u.port || '443', 10) || 443;
    } catch {
      const s = String(req.url);
      const i = s.lastIndexOf(':');
      targetHost = (i === -1 ? s : s.slice(0, i)).replace(/^\[|\]$/g, '');
      targetPort = i === -1 ? 443 : (parseInt(s.slice(i + 1), 10) || 443);
    }

    if (!INTERCEPT_HOST_RE.test(targetHost)) {
      // 不在接管范围：建立隧道原样透传（不解释 TLS，也不缓存）
      //
      // 关键：若配了上游代理（VPN / 加速器的本地代理），**隧道也要经它出去**。
      // 否则被墙的域名（例如登录时要用的谷歌验证 recaptcha）会从本机直连出去，
      // 表现为「验证码出不来」。经上游代理时先向它发 CONNECT，等它回 200 再对接。
      const chain = currentUpstreamProxy();
      const net2 = require('net');
      const up = chain
        ? net2.connect({ host: chain.host, port: chain.port })
        : net2.connect({ host: targetHost, port: targetPort });
      let established = false;
      const tunnelFail = (why) => {
        // 必须回一个响应再关，否则浏览器只能干等超时（表现为「连不上网络」）
        try { clientSocket.write('HTTP/1.1 502 Bad Gateway' + CRLF + CRLF); } catch { /* 忽略 */ }
        try { clientSocket.destroy(); } catch { /* 忽略 */ }
        try { up.destroy(); } catch { /* 忽略 */ }
        // 记进控制台/日志：缓存模式浏览器报「连不上网络」时，这里能看到是哪个域名、什么原因。
        // 广告/统计类域名除外 —— 它们本来就不通，记下来只是噪音。
        if (isNoiseHost(targetHost)) {
          if (HOST_LOG_VERBOSE) log(`[代理] 隧道失败（广告/统计域名，已忽略）${targetHost}:${targetPort} ${why}`);
        } else {
          stats.error++;
          noteError(`隧道透传失败 ${targetHost}:${targetPort}${chain ? '（经 ' + chain.host + ':' + chain.port + '）' : ''} —— ${why}`);
        }
      };
      // 超时时间要短：连不通的域名（如被墙的后台探活域名）必须尽快失败并回 502，
      // 否则浏览器把一堆请求挂在这里，连通性探测会判定「没有网络」。
      up.setTimeout(8000, () => tunnelFail('连接超时'));
      up.on('error', (e) => tunnelFail(e.code || e.message));

      const establish = (leftover) => {
        established = true;
        up.setTimeout(0);
        try { clientSocket.write('HTTP/1.1 200 Connection Established' + CRLF + CRLF); } catch { /* 忽略 */ }
        if (leftover && leftover.length) { try { clientSocket.write(leftover); } catch { /* 忽略 */ } }
        if (head && head.length) up.write(head);
        up.pipe(clientSocket);
        clientSocket.pipe(up);
      };

      up.on('connect', () => {
        if (!chain) return establish(null);
        // 让上游代理去连目标
        up.write('CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1' + CRLF
          + 'Host: ' + targetHost + ':' + targetPort + CRLF + CRLF);
        let hb = '';
        const onProxyData = (chunk) => {
          hb += chunk.toString('latin1');
          const i = hb.indexOf(CRLF + CRLF);
          if (i === -1) {
            if (hb.length > 8192) tunnelFail('上游代理响应异常');
            return;
          }
          up.removeListener('data', onProxyData);
          const status = parseInt((hb.split(CRLF)[0].split(' ')[1] || ''), 10);
          if (status !== 200) return tunnelFail('上游代理拒绝 CONNECT（HTTP ' + status + '）');
          const rest = hb.slice(i + 4);
          establish(rest.length ? Buffer.from(rest, 'latin1') : null);
        };
        up.on('data', onProxyData);
      });
      clientSocket.on('error', () => { try { up.destroy(); } catch { /* 忽略 */ } });
      up.on('close', () => { if (established) { try { clientSocket.destroy(); } catch { /* 忽略 */ } } });
      return;
    }

    clientSocket.write('HTTP/1.1 200 Connection Established' + CRLF + CRLF);
    const tlsSocket = new tls.TLSSocket(clientSocket, { isServer: true, secureContext: tlsContext });
    tlsSocket.on('error', () => { try { clientSocket.destroy(); } catch { /* 忽略 */ } });
    inner.emit('connection', tlsSocket);
  });

  proxy.on('error', (e) => log(`[代理] 错误: ${e.message}`));
  proxy.listen(PROXY_PORT, HOST, () => {
    log(`HTTPS 代理已启动: http://${HOST}:${PROXY_PORT}（接管 *.granbluefantasy.jp / *.granbluefantasy.akamaized.net）`);
  });
}

// 把请求「原样」转发到源站：保留方法、请求头、请求体，响应也原样回传。
// 游戏在 assets/<ver>/js/init/app.js 里是这么判定的：
//   ajaxError 时记下状态码 -> ajaxStop 时
//     409: alert(Game.message.update) + window.location.reload()
//     410: alert(Game.message.appUpdate)（强制更新）
// 所以「新しいバージョンがあります。更新します。」= 某次 XHR 收到了 **409**。
// 本代理自己从不返回 409，真凶一定藏在源站的响应里，必须把现场记下来。
const STATUS_WATCH = new Set([400, 401, 403, 404, 405, 409, 410, 429, 500, 502, 503]);

// ---------------------------------------------------------------- 根证书存储位置检查
//
// 为什么要有这段：本程序要在本地解密 HTTPS，所以随包的 certs\ca.crt 必须装进
// 「受信任的根证书颁发机构」(Root) —— 装在别处浏览器一律不认。而「中间证书颁发机构」
// 的存储名恰好就是 CA：网上一堆通用教程写的 `certutil -addstore CA ...`、以及 PowerShell 的
// `Cert:\CurrentUser\CA`，指的都是**中间**存储（`Root` 才是受信任根），非常容易装错。
// 装错之后浏览器会静默拒绝本程序解密的连接：游戏资源**全部**加载失败、缓存几乎不增长，
// 而控制台此前没有任何提示 —— 只能靠人工去翻证书存储才发现（真实案例，排查了很久）。
// 这段负责把"证书到底装在哪"查出来，装错就明确报出来并给出可照抄的修复命令。
const CERT_SUBJECT_HINT = 'GBF Local Cache';
const CERT_STORE_LIST = ['CurrentUser\\Root', 'CurrentUser\\CA', 'LocalMachine\\Root', 'LocalMachine\\CA'];
let certStoreCache = { at: 0, value: null };
let certStoreWarned = false;

// 取随包 ca.crt 的 SHA-1 指纹（与 certutil 显示的 Thumbprint 同格式），用于精确比对
function caThumbprint() {
  try {
    const { X509Certificate } = require('crypto');
    const c = new X509Certificate(fs.readFileSync(path.join(CERT_DIR, 'ca.crt'), 'utf8'));
    return String(c.fingerprint || '').replace(/:/g, '').toUpperCase();
  } catch { return ''; }
}

// 修复用的两条命令（装错位置时最常要的就是"先删掉装错的、再装到正确位置"）
function certFixCommands() {
  const tp = caThumbprint();
  return [
    'certutil -user -delstore CA ' + (tp || '"' + CERT_SUBJECT_HINT + '"'),
    'certutil -user -addstore -f Root certs\\ca.crt',
  ];
}

// 由"四个存储的命中情况"推导结论。刻意做成**纯函数**（不读文件、不跑命令、不依赖外部常量），
// 这样可以用合成数据把每个分支都测到 —— 特别是「装进中间存储」这条：真实环境里
// 装错位置是罕见但致命的场景（浏览器静默拒绝一切），不能只靠"本机恰好是对的"来验证。
function certStateFromStores(stores, caFileFound) {
  const keys = Object.keys(stores || {});
  const hitRoot = keys.some((k) => /\\Root$/.test(k) && stores[k].exact > 0);
  const hitCA = keys.some((k) => /\\CA$/.test(k) && stores[k].exact > 0);
  const hitSubject = keys.some((k) => stores[k].subject > 0);

  // 拿不到随包 ca.crt 的指纹时**什么都判断不了**：exact 恒为 0，任何同名证书都会被误判成
  // "旧证书"（自测环境漏拷 ca.crt 就是这么骗过一次的）。所以这条必须排在最前面。
  if (!caFileFound) {
    return { state: 'unknown', needsFix: false, advice: '读不到程序目录下的 certs/ca.crt，无法比对证书存储（拿不到指纹）。' };
  }
  if (hitRoot) {
    return { state: 'ok', needsFix: false, advice: '根证书已装在「受信任的根证书颁发机构」，浏览器会信任本程序解密出来的连接。' };
  }
  if (hitCA) {
    return {
      state: 'misplaced', needsFix: true,
      advice: '根证书被装进了「中间证书颁发机构」—— 浏览器只信任「受信任的根证书颁发机构」里的证书，' +
        '所以游戏资源会**全部**加载失败、缓存几乎不增长（症状很像网络问题，实际是证书位置不对）。' +
        '请先删掉装错的那张、再装到正确位置，然后**完全退出浏览器**再打开（证书信任在启动时加载，只刷新页面不算）。',
    };
  }
  if (hitSubject) {
    return {
      state: 'stale', needsFix: true,
      advice: '证书存储里有同名的 GBF 证书，但**不是当前这张**（指纹对不上）—— 多半是旧版本留下的。' +
        '建议删掉旧的、重新导入当前这张，否则浏览器可能仍用旧证书链校验而失败。',
    };
  }
  return {
    state: 'missing', needsFix: true,
    advice: '没在证书存储里找到本程序的根证书 —— 请按使用说明第 2 步导入。' +
      '注意务必装到「受信任的根证书颁发机构」：命令行要用 `-addstore -f Root`，' +
      '**不要用 `-addstore CA`**（那是「中间证书颁发机构」，PowerShell 里同理是 `Cert:\\CurrentUser\\CA`）。',
  };
}

// 查四个存储（当前用户 / 本地计算机 × 受信任根 / 中间），结果带缓存：
// 一切正常时缓存 5 分钟（没必要反复开 PowerShell）；不正常时只缓存 30 秒，
// 这样用户照着提示修好之后，界面很快就能自己变绿。
// 异步查证书存储（V4.6.7 起）
//
// 【为什么不能再用 execSync】它会**同步阻塞整个事件循环** —— 在它返回之前，缓存转发、
// /api/stats、SSE 推送全部停摆，最长 25 秒（timeout）。本函数有两个调用点：
//   · /api/cert-check —— 界面上的「重新检查」按钮（force=true）
//   · /api/stats       —— 控制台**定期轮询**（force 缺省）
// 后者尤其要紧：证书状态不是 ok 时 TTL 只有 30 秒，等于每 30 秒就可能卡住一次。
// do-all.ps1 里那条"偶发红"的断言正是踩到它 —— 见该文件第 6 段那段注释：
// 前一条断言 POST /api/cert-check 把事件循环挡了几秒，紧随其后的请求就撞上了超时。
function queryCertStores(ps) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'latin1', timeout: 25000, windowsHide: true, maxBuffer: 1 << 20,
    }, (err, stdout) => { if (err) reject(err); else resolve(String(stdout || '')); });
  });
}

// 带 TTL 缓存 + **并发去重**的对外入口。
// 去重是必要的：控制台轮询与用户手点「重新检查」可能同时到达；若各起一个 PowerShell，
// 既浪费又会互相拖慢（PowerShell 启动本身就要几百毫秒）。
let certStoreInflight = null;

async function certStoreInfo(force) {
  const ttl = (certStoreCache.value && certStoreCache.value.state === 'ok') ? 300000 : 30000;
  if (!force && certStoreCache.value && Date.now() - certStoreCache.at < ttl) return certStoreCache.value;
  if (certStoreInflight) return certStoreInflight;
  certStoreInflight = doCertStoreInfo();
  try {
    return await certStoreInflight;
  } finally {
    certStoreInflight = null;   // 成功失败都要清掉，否则一次失败会永久卡住后续查询
  }
}

async function doCertStoreInfo() {
  const out = {
    caFileFound: false, thumbprint: '', stores: {},
    inRoot: false, inCA: false, subjectMatchSomewhere: false,
    state: 'unknown', advice: '', fix: null, checkedAt: Date.now(),
  };
  const tp = caThumbprint();
  out.thumbprint = tp;
  out.caFileFound = !!tp;

  // 一次 PowerShell 查完四个存储，每行输出 "存储|指纹精确命中数|同主题命中数"。
  // 全部用单引号，避免与 -Command 外面的双引号打架（反斜杠交给 PowerShell 自己解析）。
  const ps = [
    "$want = '" + tp + "'",
    "$stores = @('" + CERT_STORE_LIST.join("','") + "')",
    'foreach ($s in $stores) {',
    "  $all = @(Get-ChildItem ('Cert:\\' + $s) -ErrorAction SilentlyContinue)",
    '  $exact = @($all | Where-Object { $_.Thumbprint -eq $want }).Count',
    "  $subj = @($all | Where-Object { $_.Subject -like '*" + CERT_SUBJECT_HINT + "*' }).Count",
    "  Write-Output ($s + '|' + $exact + '|' + $subj)",
    '}',
  ].join('; ');

  let text = '';
  try {
    text = await queryCertStores(ps);
  } catch (e) {
    out.state = 'unknown';
    out.advice = '查询证书存储失败（' + e.message + '）';
    certStoreCache = { at: Date.now(), value: out };
    return out;
  }
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z]+\\[A-Za-z]+)\|(\d+)\|(\d+)/.exec(line.trim());
    if (!m) continue;
    out.stores[m[1]] = { exact: parseInt(m[2], 10), subject: parseInt(m[3], 10) };
  }

  const keys = Object.keys(out.stores);
  if (!keys.length) {
    out.state = 'unknown';
    out.advice = '没能从证书存储里读到任何信息（PowerShell 查询没有返回可解析的结果）';
  } else {
    out.inRoot = keys.some((k) => /\\Root$/.test(k) && out.stores[k].exact > 0);
    out.inCA = keys.some((k) => /\\CA$/.test(k) && out.stores[k].exact > 0);
    out.subjectMatchSomewhere = keys.some((k) => out.stores[k].subject > 0);
    const v = certStateFromStores(out.stores, out.caFileFound);
    out.state = v.state;
    out.advice = v.advice;
    if (v.needsFix) {
      // misplaced / stale 需要"先删掉装错的、再装到正确位置"两条；
      // missing 只需要装这一条。
      out.fix = v.state === 'missing' ? [certFixCommands()[1]] : certFixCommands();
    }
  }

  certStoreCache = { at: Date.now(), value: out };
  if (out.state !== 'ok' && !certStoreWarned) {
    certStoreWarned = true;
    log('[证书] ' + out.advice + (out.fix ? '  修复：' + out.fix.join('  |  ') : ''));
  }
  return out;
}

function noteStatus(host, req, status) {
  if (!STATUS_WATCH.has(status)) return;
  const detail = describeReq(req);
  // 环形缓冲（控制台可见）记下所有可疑状态码
  pushLog({ tag: String(status), path: `${host}${req.url}`, source: 'forward', detail });
  // 文件日志只留真正要紧的，免得常规 404 把信号淹掉
  if (status === 409 || status === 410 || status >= 500) {
    log(`[${status}] ${req.method} ${host}${req.url}  ${detail}`);
  }
  if (status === 409 || status === 410) {
    noteError(`源站返回 ${status} —— 游戏会据此弹「新しいバージョンがあります」并整页重载: ${host}${req.url}`);
  }
}

// 凡是不能当作静态资源处理的请求（POST、非 /assets/ 路径等）都必须走这里，
// 否则接口会被破坏 —— 之前正是因为把 POST 变成了无体的 GET，
// 导致游戏接口数据异常、反复提示「有新版本」并重载。
function forwardTransparent(host, req, res) {
  // 这一路是「游戏页面与接口」的转发。它同样证明"有请求经过代理"，
  // 所以也更新接管判据 —— 否则游戏开着但暂时不取资源时，界面会一直显示"等待游戏请求"。
  lastProxyRequestAt = Date.now();
  lastProxyRequestPath = host + (req.url || '/');
  // 请求头照搬，只去逐跳头（见 upstreamHeaders）
  const headers = upstreamHeaders(req.headers);
  // 只有 GET/HEAD 能重放（重试时请求体已经消费掉了）
  const replayable = req.method === 'GET' || req.method === 'HEAD';
  let attemptNo = 0;
  let curUp = null;
  // 浏览器提前断开（游戏常取消长轮询/预取）：不是故障，别记错误、更别重试。
  // 不这样做的话，游戏每次取消轮询都会在我们这里留下一条"转发失败"。
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableFinished) {
      clientGone = true;
      try { if (curUp) curUp.destroy(); } catch { /* 忽略 */ }
    }
  });

  const attempt = (agent) => {
    attemptNo++;
    // 这里刻意不用 keep-alive 连接池：源站（nginx）声明了 Keep-Alive: timeout=5，
    // 空闲连接会被它单方面关掉，而连接池里那条已死的连接一旦被复用，请求就会
    // 一直挂在「等不到响应」上 —— 日志里那两条 90 秒 timeout（游戏首页 `/`、
    // 一个页面 XHR）就是这么产生的。每次新建连接的代价在这里可以忽略。
    // 方案 C 生效时改走加速器的代理（同样是每次新建连接）。
    const up = https.request({
      hostname: host,
      port: 443,
      method: req.method,
      path: req.url,
      headers: headers,
      agent: agent || false,
      timeout: 90000,
    }, (upRes) => {
      noteStatus(host, req, upRes.statusCode);
      // 逐跳头不能回给浏览器（会让浏览器与代理的保活语义错位）
      const out = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (HOP_BY_HOP.has(k)) continue;
        out[k] = v;
      }
      try { res.writeHead(upRes.statusCode, out); } catch { /* 忽略 */ }
      upRes.pipe(res);
    });
    curUp = up;

    up.on('timeout', () => {
      if (clientGone) return;          // 浏览器早就走了，不算超时故障
      stats.error++;
      noteError(`代理转发超时 ${host}${req.url}（90s 无响应）`);
      try { up.destroy(new Error('timeout')); } catch { /* 忽略 */ }
    });
    up.on('error', (e) => {
      const msg = String((e && e.message) || e);
      if (clientGone) return;          // 客户端已断开：静默收尾
      // 会重试的两类失败（只对可重放的 GET/HEAD）：
      //   · 连不上加速器代理 -> 改直连重试
      //   · 源站瞬时重置（ECONNRESET 等，实测游戏首页偶发）-> 同链路再试一次
      // 逻辑类失败（比如 4xx）不会走到这里，交给浏览器看真实状态码。
      const chainIssue = !!agent && /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|加速器代理/i.test(msg);
      const transient = /ECONNRESET|EPIPE|socket hang up/i.test(msg);
      if (attemptNo === 1 && replayable && (chainIssue || transient)) {
        log(`[代理] 转发失败（${msg}），可重放请求再试一次：${host}${req.url}`);
        // 瞬时重置给一点间隔，避开对端刚重置完的窗口
        setTimeout(() => { if (!clientGone) attempt(transient ? agent : null); }, transient ? 150 : 0);
        return;
      }
      stats.error++;
      noteError(`代理转发失败 ${host}${req.url}: ${msg}`);
      try { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('proxy error'); } catch { /* 忽略 */ }
    });

    if (attemptNo === 1) req.pipe(up); else up.end();
  };

  attempt(chainAgent());
}

// 普通 HTTP 转发（用于非接管域名）
function httpRequestForward(req, u) {
  const mod = u.protocol === 'http:' ? http : require('https');
  return mod.request({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'http:' ? 80 : 443),
    path: u.pathname + u.search,
    method: req.method,
    headers: req.headers,
  });
}

// ---------------------------------------------------------------- 启动

// Firefox 系没有 Chromium 的 --app= 应用模式；传 URL 本体（普通窗口/标签）而不是
// --app=，否则命令行参数会被当成未知选项。判错也不致命：最坏是浏览器忽略这个参数。
function isFirefoxFamily(exe) {
  return /^(firefox|waterfox|librewolf|palemoon)\.exe$/i.test(path.basename(exe || ''));
}

// 控制台浏览器的选择顺序：config.json 的 consoleBrowserPath > Edge > 系统默认浏览器。
// 配置了但文件不存在时回退到老路（并留一条日志），不让一个失效路径把控制台整个弄丢。
function findConsoleBrowser() {
  const configured = consoleBrowserPath();
  if (configured) {
    try {
      if (fs.existsSync(configured)) return { exe: configured, configured: true };
    } catch { /* 路径不可读：按不存在处理 */ }
    log(`配置的控制台浏览器不存在：${configured} —— 回退到默认方式`);
  }
  const edgeCandidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ];
  const edge = edgeCandidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  return edge ? { exe: edge, configured: false } : { exe: '', configured: false };
}

// 用配置的浏览器（或 Edge）打开控制台；失败则退回系统默认浏览器打开。
function openDashboard() {
  const url = `http://${HOST}:${PORT}/`;
  const { spawn } = require('child_process');
  const target = findConsoleBrowser();

  try {
    if (target.exe) {
      // Chromium 系用 --app=：没有地址栏和标签栏的独立窗口；
      // Firefox 系只传 URL（普通窗口/标签）。
      const args = isFirefoxFamily(target.exe) ? [url] : [`--app=${url}`];
      spawn(target.exe, args, {
        detached: true, stdio: 'ignore',
      }).unref();
      log(`已打开可视化控制台（${target.configured ? '自定义浏览器' : 'Edge 应用模式'}：${target.exe}）`);
    } else {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      log('未配置控制台浏览器且未找到 Edge，已用默认浏览器打开控制台');
    }
  } catch (e) {
    log(`打开控制台失败: ${e.message} —— 可手动访问 ${url}`);
  }
}

function main() {
  // 全局兜底（V4.14.5）：漏网的同步异常 / Promise 拒绝只记日志、不退出 —— 这是常驻代理，
  // 「扔掉一个请求」永远好过「整个服务带着游戏一起消失」。各请求路径已有 .catch，
  // 这里接的是定时器与回调里漏网的那类；日志进文件，便于事后定位是哪一处漏了。
  process.on('uncaughtException', (e) => {
    try { log('未捕获异常(已忽略):', (e && (e.stack || e.message)) || String(e)); } catch { /* 退出阶段 */ }
  });
  process.on('unhandledRejection', (e) => {
    const r = (e && e.reason) || e;
    try { log('未处理的Promise拒绝(已忽略):', (r && (r.stack || r.message)) || String(r)); } catch { /* 退出阶段 */ }
  });

  // 设置控制台窗口标题。不写在 start-server.bat 里，是因为批处理文件一旦含非 ASCII 字符，
  // cmd.exe 的解析就会错乱（实测会直接跑不起来），所以标题交给 Node 设。
  const TITLE = '碧蓝幻想本地缓存程序';
  try {
    process.title = TITLE;
    // OSC 0 序列：ESC ] 0 ; <标题> BEL
    if (process.stdout.isTTY) {
      process.stdout.write(String.fromCharCode(27) + ']0;' + TITLE + String.fromCharCode(7));
    }
  } catch { /* 非交互终端忽略 */ }

  // 默认目录现在落在程序目录内，首次运行还不存在是正常的 —— 先建出来，免得控制台
  // 报「目录不存在」把用户吓一跳（装在 Program Files 这类受保护目录时建不出来，
  // 那种情况下下面这条警告才是真该看的）。
  if (!fs.existsSync(CACHE_ROOT)) {
    try { fs.mkdirSync(CACHE_ROOT, { recursive: true }); } catch { /* 建不出来就走下面的警告 */ }
  }

  console.log('==============================================');
  console.log('  碧蓝幻想本地缓存程序（独立版）');
  console.log('==============================================');
  console.log(`  缓存目录 : ${CACHE_ROOT}${chosenCacheRoot ? '' : '（默认）'}`);
  if (fs.existsSync(CACHE_ROOT)) {
    console.log('            [已找到]');
  } else {
    console.log('            [警告] 目录不存在或建不出来！只会走回源，不会命中缓存；');
    console.log('                   请在控制台里把缓存目录改到可写的位置。');
  }
  console.log(`  监听地址 : http://${HOST}:${PORT}`);
  console.log(`  控制台   : http://${HOST}:${PORT}/`);
  console.log(`  健康检查 : http://${HOST}:${PORT}/health`);
  console.log(`  日志文件 : ${LOG_FILE}`);
  console.log('  按 Ctrl+C 停止');
  console.log('==============================================');

  scanCache();   // 后台统计缓存目录，不阻塞启动
  startProxy();  // 启动 HTTPS 中间人代理（不使用扩展重定向时的第二条路径）

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      stats.error++;
      noteError(`未捕获错误: ${e && e.message}`);
      log('未捕获错误:', e && e.message);
      try { send(res, 500, { 'Content-Type': 'text/plain' }, 'internal error\n'); } catch {}
    });
  });

  server.listen(PORT, HOST, () => {
    startedAt = Date.now();
    log('服务已启动，等待浏览器请求...');
    log('程序版本：' + VERSION);
    if (legacyFrozenRoot) {
      log(`缓存目录：已忽略旧版本自动写入的默认路径 ${legacyFrozenRoot}（那不是你选的），`
        + `改用程序目录内的 ${DEFAULT_CACHE_ROOT}`);
      log('           想用别处（例如原来那份缓存）就在控制台「缓存目录」里重新选一次，之后不会再被改回去。');
    } else if (!chosenCacheRoot) {
      log(`缓存目录：未指定，使用程序目录内的默认目录 ${DEFAULT_CACHE_ROOT}`);
    }
    log(`可视化控制台: http://${HOST}:${PORT}/`);

    // hosts 模式自愈（V4.8.0）：若 hosts 里还留着我们的条目（上次启用过、这次重启了程序），
    // **自动把 443 监听拉起来**并告警 —— 否则 CDN 已被指向 127.0.0.1 却没人监听，游戏资源会全挂。
    // 宁可继续缓存，也不要断网。清理办法一并说清楚，免得用户不知道这东西是谁加的。
    try {
      const hs = hostsStatus();
      if (hs.blockPresent) {
        log('[hosts 模式] hosts 里仍有本程序添加的条目（' + (hs.hosts.join('、') || '?') + '）—— 自动恢复 443 监听');
        log('           不再需要这个兜底模式时：POST /api/hosts-mode?action=restore&dryRun=0，');
        log('           或手工删掉 hosts 里 `' + HOSTS_MARK_BEGIN + '` 与 `' + HOSTS_MARK_END + '` 之间的行。');
        startHostsModeListener((ok, err) => {
          if (ok) { hostsMode.active = true; hostsMode.appliedAt = Date.now(); }
          else log('[hosts 模式] 自愈失败：' + err + ' —— 请尽快手工清理 hosts 里本程序的条目，否则那些域名将不可用');
        });
      }
    } catch (e) { log('[hosts 模式] 启动自检出错：' + e.message); }

    // 接管系统「自动配置脚本」槽位（若空着或本来就是我们的）
    installPacSetting().catch(() => { /* 内部各分支已兜底，这里防意外拒载 */ });


    // 后台巡检（每 20 秒）：
    //   1) 确认系统代理槽位还是我们接管的状态 —— 加速器切模式会把它清掉/覆写
    //   2) 体检/探测加速器的本地代理（方案 C）
    // V4.12.0：整条巡检改为异步（注册表/netstat/tasklist/PowerShell 全走 exec 系），
    // 且串行执行 —— installPacSetting 的强制刷新先保鲜缓存，后面的体检直接吃缓存，
    // 一个 tick 只发一次 reg query。过去这串全是 execSync，每 20 秒把事件循环卡住
    // 几百毫秒，游戏请求跟着周期性顿一下。
    // 巡检计数器（V4.15.8 修）：V4.15.2 起这里漏了声明 —— `inspectTicks++` 对未声明
    // 变量直接抛 ReferenceError，而它是 tick 的**第一句**：每 20 秒一抛，后面的
    // PAC 槽位复查 / 上游体检 / 链路体检 / 自动清理被**整段跳过**，日志里只留一条
    // 泛化的「未处理的Promise拒绝」。自测实例只跑约 8 秒、触发不到 20 秒定时器，
    // 所以防回归改为静态断言（test-evict.js：先声明后使用）。
    let inspectTicks = 0;
    setInterval(() => {
      (async () => {
        inspectTicks++;
        try { await installPacSetting(); } catch { /* 忽略 */ }
        await checkUpstreamHealth().catch(() => {});
        await checkChainHealth().catch(() => {});
        // 自动清理过期版本戳（设置面板开关，默认关）：约每 5 分钟点名一次
        if (config.autoEvictStamps === true && inspectTicks % 15 === 0) {
          await autoEvictCheck().catch(() => {});
        }
      })().catch((e) => { try { log('[巡检] 本轮意外出错（下一轮照常）：' + ((e && e.message) || e)); } catch { /* 忽略 */ } });
    }, 20000);

    // 用浏览器「应用模式」打开控制台：无地址栏、无标签页，观感接近原生窗口。
    // V4.21.0 起可在设置面板指定浏览器（不指定则优先 Edge）。设置面板「启动后打开控制台」
    // 可关 —— V4.15.2，关掉后从托盘/双击 exe 手动打开。
    if (config.openDashboardOnStart !== false
        && process.env.GBFCACHE_OPEN_UI !== '0' && process.env.ACGP_OPEN_UI !== '0') {
      openDashboard();
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n端口 ${PORT} 已被占用。`);
      console.error('可能上一次的服务还在运行，或改用其他端口：');
      console.error(`  set GBFCACHE_PORT=8800 && node server.js\n`);
    } else {
      console.error('服务启动失败:', e.message);
    }
    process.exit(1);
  });

  // 任何退出路径（Ctrl+C、控制台点「退出服务」、启动失败）都还原系统代理槽位。
  // 这条很要紧：之前程序退出后 PAC 一直留在注册表里，而它对非 GBF 流量返回 DIRECT，
  // 结果就是「用了这个程序之后，加速器一直失效」，只能手动改注册表才能恢复。
  process.on('exit', () => {
    try { restorePacSetting(); } catch { /* 退出阶段不再抛错 */ }
  });

  process.on('SIGINT', () => {
    console.log('\n--- 运行统计 ---');
    console.log(`  缓存命中 : ${stats.hit}`);
    console.log(`  回源请求 : ${stats.miss}`);
    console.log(`  新写入缓存 : ${stats.stored}`);
    console.log(`  错误     : ${stats.error}`);
    console.log('已停止。');
    process.exit(0);
  });
}

main();
