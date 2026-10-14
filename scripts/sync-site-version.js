#!/usr/bin/env node
/*
 * 把文档站（docs/）里的版本号同步成程序源码里的那一个。
 *
 * 为什么需要它：GitHub Pages 站点上有「当前版本」徽标，而版本号的唯一来源是
 * plugin/server.js 顶部的 `const VERSION`。手抄一份到站点上迟早会抄漏，
 * 所以这里用一个带断言的脚本代替手抄。
 *
 * 用法：
 *   node scripts/sync-site-version.js          # 写入 docs/assets/version.js，并同步 README 里的版本号
 *   node scripts/sync-site-version.js --check   # 只校验，不一致就退出码 1（给 CI / 出包前用）
 *   node scripts/sync-site-version.js --owner=你的GitHub用户名
 *                                               # 额外把 README 顶部的在线演示链接补成真实地址
 *                                               # （首次上传后跑一次即可；站点自身的链接是运行时推导的，不用配）
 *
 * 仓库改名时：改下面 REPO_NAME 一处即可（站点靠它拼 GitHub 链接）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_NAME = 'GBF-Cache';
const ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'plugin', 'server.js');
const OUT_JS = path.join(ROOT, 'docs', 'assets', 'version.js');
const README = path.join(ROOT, 'README.md');

function readVersion() {
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const hits = src.match(/^const VERSION\s*=\s*'([^']+)'\s*;/m);
  if (!hits) {
    console.error('✗ 在 plugin/server.js 里找不到 `const VERSION = \'...\';`');
    console.error('  版本号的唯一来源就是那一行，找不到说明它被挪走或改了写法 —— 先把它改回来。');
    process.exit(2);
  }
  const all = src.match(/^const VERSION\s*=/gm) || [];
  if (all.length !== 1) {
    console.error(`✗ \`const VERSION\` 出现了 ${all.length} 次，唯一来源被破坏了。`);
    process.exit(2);
  }
  return hits[1];
}

function render(version) {
  return [
    '/* 本文件由 scripts/sync-site-version.js 生成，不要手工改。',
    '   版本号的唯一来源是 plugin/server.js 顶部的 const VERSION。',
    '   改完程序后跑一次：node scripts/sync-site-version.js */',
    `window.GBF_SITE = { version: "${version}", repo: "${REPO_NAME}" };`,
    ''
  ].join('\n');
}

const version = readVersion();
const want = render(version);
const check = process.argv.includes('--check');
const ownerArg = (process.argv.find((a) => a.startsWith('--owner=')) || '').slice('--owner='.length).trim();

let have = null;
try { have = fs.readFileSync(OUT_JS, 'utf8'); } catch { /* 还没有这个文件 */ }

/* ---------- README：版本号 +（可选）Pages 链接 ---------- */
function syncReadme(write) {
  let md;
  try { md = fs.readFileSync(README, 'utf8'); } catch { return null; }
  let next = md, changed = [];

  const vMark = /`V[^`]*`(<!--version-->)/g;
  if ((md.match(vMark) || []).length !== 1) {
    console.error('✗ README.md 里应有且仅有一处 `V…`<!--version--> 标记，找不到或出现多次。');
    process.exit(2);
  }
  next = next.replace(vMark, '`' + version + '`$1');
  if (next !== md) changed.push('版本号');

  if (ownerArg) {
    const pMark = /\]\(https:\/\/[^)\s]*\)(<!--pages-->)/g;
    if ((next.match(pMark) || []).length !== 1) {
      console.error('✗ README.md 里应有且仅有一处 Pages 链接标记 <!--pages-->。');
      process.exit(2);
    }
    const url = 'https://' + ownerArg + '.github.io/' + REPO_NAME + '/';
    const replaced = next.replace(pMark, '](' + url + ')$1');
    if (replaced !== next) { next = replaced; changed.push('演示链接 → ' + url); }
  }

  if (!write) {
    return { ok: next === md, changed: changed };
  }
  if (next !== md && !check) fs.writeFileSync(README, next, 'utf8');
  return { ok: true, changed: changed };
}

const readme = syncReadme(true);

if (check) {
  const jsOk = have === want;
  const mdOk = readme && readme.ok;
  if (jsOk && mdOk) {
    console.log(`✓ docs/assets/version.js 与 README 均与源码一致：${version}`);
    process.exit(0);
  }
  if (!jsOk) console.error(`✗ docs/assets/version.js 与源码不一致（源码现在是 ${version}）。`);
  console.error('  跑 `node scripts/sync-site-version.js` 重新生成。');
  process.exit(1);
}

if (have === want) {
  console.log(`= docs/assets/version.js 已是最新：${version}（未改动）`);
} else {
  fs.writeFileSync(OUT_JS, want, 'utf8');
  console.log(`✓ 已写入 ${path.relative(ROOT, OUT_JS)}：${version}`);
}
if (readme && readme.changed.length) console.log('✓ README.md 已同步：' + readme.changed.join('、'));
else console.log('= README.md 已是最新（未改动）');
