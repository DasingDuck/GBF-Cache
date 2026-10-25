'use strict';

/*
 * 只做一件事：点击工具栏图标时打开侧边栏。
 *
 * 这个扩展与 edge-extension（负责代理/PAC 的那个）完全独立：
 *   · 不申请 proxy 权限，不碰任何浏览器代理设置；
 *   · 不读取游戏请求，只把 127.0.0.1:8799 的控制台页面装进侧栏。
 * 两个扩展可以同时安装，互不覆盖。
 */

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

chrome.runtime.onInstalled.addListener(enableActionClick);
chrome.runtime.onStartup.addListener(enableActionClick);
enableActionClick();

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
