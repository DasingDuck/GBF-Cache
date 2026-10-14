/* ==========================================================================
   碧蓝幻想本地缓存程序 · 站点交互脚本
   零依赖原生 JS。三块功能：
     1) 导航 / 滚动进场 / 版本号与仓库链接
     2) 请求演示（沿路径动画 + 五个计数器 + 实时日志）
     3) 缓存布局解释器（输入 URL → 判定会不会缓存 + 磁盘路径 + .ext 元数据）
   站点要如实反映程序机制：判定规则与 plugin/server.js 里的一致
     · 主机：*.granbluefantasy.jp / *.granbluefantasy.akamaized.net / *.gbf.akamaized.net
     · 路径：只有 /assets/ 或 /assets_xx/ 下的请求才进缓存
   ========================================================================== */
(function () {
  'use strict';

  var SITE = Object.assign({ version: '', repo: 'GBF-Cache' }, window.GBF_SITE || {});
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var cssVar = function (n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); };

  /* ======================== 1. 版本号与仓库链接 ======================== */

  $$('[data-version]').forEach(function (el) {
    el.textContent = SITE.version || '开发版';
  });

  // <用户名>.github.io/<仓库> 时自动推出仓库地址；本地预览（file:// 或 127.0.0.1）则禁用外链
  function repoBase() {
    var h = location.hostname;
    if (/\.github\.io$/i.test(h)) return 'https://github.com/' + h.split('.')[0] + '/' + SITE.repo;
    return '';
  }
  var BASE = repoBase();
  var LINKS = {
    repo: BASE,
    releases: BASE ? BASE + '/releases/latest' : '',
    issues: BASE ? BASE + '/issues' : ''
  };
  $$('[data-link]').forEach(function (a) {
    var url = LINKS[a.getAttribute('data-link')];
    if (url) { a.href = url; a.target = '_blank'; }
    else {
      a.href = '#';
      a.setAttribute('aria-disabled', 'true');
      a.title = '部署到 GitHub Pages 后自动生效';
      a.classList.add('link-off');
      a.addEventListener('click', function (e) { e.preventDefault(); });
    }
  });

  /* ======================== 2. 导航 / 进场 ======================== */

  var nav = $('#nav');
  var onScroll = function () { nav.classList.toggle('scrolled', window.scrollY > 8); };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // 滚动进场：这里只负责给区块打上 .reveal 标记，动画完全由 CSS 的滚动驱动时间轴
  // （animation-timeline: view()）完成 —— 见 style.css 那段的说明。
  // 之前是 JS + IntersectionObserver 的写法，一旦回调被节流，内容会卡在 opacity:0 的隐藏态；
  // 纯 CSS 方案没有这个失败模式：不支持的浏览器干脆没有动画，但内容始终可见。
  $$('.sec-head, .demo, .step, .note-card, .feat, .deep, .explorer, .acc, .disc, .specs li')
    .filter(function (el) { return !el.closest('.guide'); })   // 面板里的交给切换动画
    .forEach(function (el) { el.classList.add('reveal'); });

  /* ======================== 3. 请求演示 ======================== */

  var packet = $('#packet'), core = $('#packetCore'), packetWrap = $('#packetWrap');
  var logList = $('#logList');
  var statusEl = $('#stageStatus');
  var cmpCard = $('#cmpCard'), cmpOp = $('#cmpOp'), cmpNote = $('#cmpNote');
  var counters = { hit: 0, origin: 0, store: 0, block: 0, error: 0 };
  var counterEls = {};
  $$('#counters .counter').forEach(function (el) {
    var key = $('b', el).getAttribute('data-c');
    counterEls[key] = { box: el, num: $('b', el) };
  });

  var flowEls = {};
  function initStage() {
    $$('.stage-svg .flow').forEach(function (el) {
      if (el.dataset.d) el.setAttribute('d', el.dataset.d);
      var L = el.getTotalLength();
      el.dataset.len = String(L);
      el.style.strokeDasharray = L;
      el.style.strokeDashoffset = L;
      flowEls[el.id.replace(/^f_/, '')] = el;
    });
  }
  initStage();
  window.addEventListener('resize', function () { /* 路径基于 viewBox，无需重算 */ });

  function setStatus(html) { statusEl.innerHTML = html; }

  function pushLog(tag, path, ms) {
    var empty = $('.logline.empty', logList);
    if (empty) empty.remove();
    var li = document.createElement('li');
    li.className = 'logline';
    var t = document.createElement('span'); t.className = 't';
    t.textContent = new Date().toTimeString().slice(0, 8);
    var g = document.createElement('span'); g.className = 'g ' + tag; g.textContent = tag;
    var p = document.createElement('span'); p.className = 'p'; p.textContent = path;
    var m = document.createElement('span'); m.className = 'ms'; m.textContent = ms;
    li.appendChild(t); li.appendChild(g); li.appendChild(p); li.appendChild(m);
    logList.appendChild(li);
    while (logList.children.length > 9) logList.removeChild(logList.firstChild);
    logList.scrollTop = logList.scrollHeight;
  }

  function bump(map) {
    Object.keys(map).forEach(function (k) {
      counters[k] += map[k];
      var c = counterEls[k];
      if (!c) return;
      c.num.textContent = counters[k].toLocaleString('en-US');
      c.box.classList.remove('bump');
      void c.box.offsetWidth;               // 强制重排，让动画能重放
      c.box.classList.add('bump');
    });
  }

  var FLASH_CLASS = { ok: 'flash-ok', warn: 'flash-warn', info: 'flash-info' };
  function flash(nodeId, kind) {
    var n = document.getElementById(nodeId);
    if (!n) return;
    var cls = FLASH_CLASS[kind] || 'flash-info';
    n.classList.add(cls);
    setTimeout(function () { n.classList.remove(cls); }, 900);
  }

  function setCmp(state) {
    if (state === 'off') { cmpCard.hidden = true; cmpCard.classList.remove('matched'); return; }
    cmpCard.hidden = false;
    if (state === 'match') {
      cmpCard.classList.add('matched');
      cmpOp.textContent = '=';
      cmpNote.textContent = '新文件写进磁盘，新的版本串也记进了 .ext 的 q 字段 —— 之后同版本的请求才算命中';
      cmpNote.classList.add('ok');
    } else {
      cmpCard.classList.remove('matched');
      cmpOp.textContent = '≠';
      cmpNote.classList.remove('ok');
      cmpNote.textContent = '两串不一致 → 旧的绝不能当命中，必须回源取新的并覆盖（否则游戏会判定「有新版本」而反复整页重载）';
    }
  }

  var A = '/assets/1789531866/';

  var SCENES = {
    hit: {
      steps: [
        { r: 'b2p', ms: 340, color: '--info',
          say: '<span class="tag info">请求</span>浏览器把资源请求交给本程序（系统里的「自动配置脚本」按域名分流）。',
          arrive: { flash: 'n_proxy' } },
        { r: 'p2c', ms: 300, color: '--ok',
          say: '<span class="tag ok">查本地</span>磁盘上已经有这份文件 → <b>直接读盘，完全不联网</b>。',
          arrive: { flash: 'n_cache', bump: { hit: 1 }, log: { tag: 'HIT', path: A + 'img/sp/ui/btn_ability.png', ms: '0.8 ms' } } },
        { r: 'c2p', ms: 260, color: '--ok' },
        { r: 'p2b', ms: 320, color: '--ok',
          say: '<span class="tag ok">命中</span>文件来自你自己的硬盘 —— 这一次请求，网络一点都没用上。',
          arrive: { flash: 'n_browser' } }
      ]
    },
    miss: {
      steps: [
        { r: 'b2p', ms: 340, color: '--info',
          say: '<span class="tag info">请求</span>这次要的文件本地没有，先到本程序这里。',
          arrive: { flash: 'n_proxy' } },
        { r: 'p2o', ms: 520, color: '--warn',
          say: '<span class="tag warn">回源</span>本地没有 → 去源站取（这一步才真正用到网络）。',
          arrive: { flash: 'n_origin', bump: { origin: 1 }, log: { tag: 'MISS', path: A + 'img/sp/ui/btn_ability.png', ms: '268 ms' } } },
        { r: 'o2p', ms: 480, color: '--warn',
          say: '<span class="tag warn">下载</span>源站把内容回给本程序。',
          arrive: { flash: 'n_proxy' } },
        { r: 'p2c', ms: 240, color: '--store',
          say: '<span class="tag store">落盘</span>按原格式写进磁盘：<b>先写临时文件再改名</b>（原子写），并把 CORS 头与版本串一起记进旁边的 .ext。',
          arrive: { flash: 'n_cache', bump: { store: 1 }, log: { tag: 'STORE', path: A + 'img/sp/ui/btn_ability.png', ms: '1.2 MB' } } },
        { r: 'p2b', ms: 320, color: '--ok',
          say: '<span class="tag ok">返回</span>内容交给浏览器。<b>下一次再要同一个文件，走的就是「命中」那条路。</b>',
          arrive: { flash: 'n_browser' } }
      ]
    },
    version: {
      steps: [
        { r: 'b2p', ms: 340, color: '--info',
          say: '<span class="tag info">请求</span>请求带着版本参数 <code>?1729002592</code> 到达本程序。',
          arrive: { flash: 'n_proxy' }, cmp: 'show' },
        { r: 'p2o', ms: 520, color: '--warn',
          say: '<span class="tag warn">版本比对</span>本地文件记的是 <code>?1728800731</code> —— 两串不一致，<b>绝不能拿旧的顶</b>。',
          arrive: { flash: 'n_origin', bump: { origin: 1 }, log: { tag: 'MISS', path: A + 'js/main.js（版本串不一致）', ms: '212 ms' } } },
        { r: 'o2p', ms: 480, color: '--warn',
          say: '<span class="tag warn">下载</span>取回真正的新版本。',
          arrive: { flash: 'n_proxy' } },
        { r: 'p2c', ms: 240, color: '--store',
          say: '<span class="tag store">覆盖</span>新文件覆盖旧的，并把新的版本串写进 .ext 的 <code>q</code> 字段。',
          arrive: { flash: 'n_cache', bump: { store: 1 }, log: { tag: 'STORE', path: A + 'js/main.js', ms: '96 KB' } }, cmp: 'match' },
        { r: 'p2b', ms: 320, color: '--ok',
          say: '<span class="tag ok">返回</span>之后同版本的请求才算命中，游戏不会再看到「旧的资源」。',
          arrive: { flash: 'n_browser' } }
      ]
    },
    direct: {
      steps: [
        { r: 'b2o', ms: 900, color: '--info',
          say: '<span class="tag info">直连</span>接口请求（登录、抽卡等 <code>/rest/</code>）在浏览器里就<b>直接去了源站</b>，不经过本程序。',
          arrive: { flash: 'n_origin', log: { tag: 'DIRECT', path: '/rest/user/content/index', ms: '—' } } },
        { r: 'o2b', ms: 860, color: '--info',
          say: '<span class="tag info">放行</span>凡是需要 Cookie 才能正确返回的请求都走直连 —— 本程序只碰静态资源。',
          arrive: { flash: 'n_browser' } }
      ]
    }
  };
  var SCENE_ORDER = ['hit', 'miss', 'version', 'direct'];

  var runToken = 0;
  var autoOn = false;
  var current = 'hit';
  // 节点高亮色跟随这一段的颜色：绿=命中、黄=回源、紫=落盘、蓝=直连/请求
  var KIND_BY_COLOR = { '--ok': 'ok', '--warn': 'warn', '--info': 'info', '--store': 'ok' };

  // 路径线亮起后自行淡出（不阻塞下一步：上一条路线留在画面上当"轨迹"）
  function fadeOut(el, L) {
    setTimeout(function () {
      el.style.transition = 'opacity .24s';
      el.style.opacity = '0';
      setTimeout(function () {
        el.style.transition = '';
        el.style.strokeDashoffset = String(L);
        el.style.opacity = '1';
      }, 250);
    }, 160);
  }

  function travel(routeId, ms, colorName, token) {
    var el = flowEls[routeId];
    if (!el) return Promise.resolve(false);
    var L = parseFloat(el.dataset.len);
    var col = cssVar(colorName) || '#58a6ff';
    el.style.stroke = col;
    el.style.strokeDashoffset = L;
    el.style.opacity = '1';
    packet.style.fill = col;
    packetWrap.classList.add('on');
    if (REDUCED) ms = Math.max(90, Math.round(ms * 0.35));

    return new Promise(function (resolve) {
      var settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        el.style.strokeDashoffset = '0';        // 把这条路线补成"已走完"的样子
        packetWrap.classList.remove('on');
        fadeOut(el, L);
        resolve(true);
      }
      // 兜底：帧被挂起时 rAF 不再回调，动画就永远走不完 —— 计数器与日志会停在半路，
      // 看着像"点了没反应"。超时就当成"已经到达"，让整个场景无论机器多卡都能讲完。
      var guard = setTimeout(finish, ms + 900);

      var t0 = performance.now();
      function frame(now) {
        if (token !== runToken) {
          clearTimeout(guard); packetWrap.classList.remove('on'); resolve(false); return;
        }
        var t = ms <= 0 ? 1 : Math.min(1, (now - t0) / ms);
        var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // easeInOutQuad
        var pt = el.getPointAtLength(e * L);
        packet.setAttribute('cx', pt.x); packet.setAttribute('cy', pt.y);
        core.setAttribute('cx', pt.x); core.setAttribute('cy', pt.y);
        el.style.strokeDashoffset = String(L * (1 - e));
        if (t < 1) { requestAnimationFrame(frame); return; }
        clearTimeout(guard);
        finish();
      }
      requestAnimationFrame(frame);
    });
  }

  function markActive(key) {
    $$('.seg-btn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-scene') === key); });
  }

  function resetStage() {
    packetWrap.classList.remove('on');
    setCmp('off');
    Object.keys(flowEls).forEach(function (k) {
      var el = flowEls[k];
      el.style.transition = '';
      el.style.opacity = '1';
      el.style.strokeDashoffset = el.dataset.len;
    });
  }

  async function runScene(key) {
    var scene = SCENES[key];
    if (!scene) return;
    var token = ++runToken;
    current = key;
    markActive(key);
    resetStage();
    for (var i = 0; i < scene.steps.length; i++) {
      var st = scene.steps[i];
      if (token !== runToken) return;
      if (st.cmp) setCmp(st.cmp);
      if (st.say) setStatus(st.say);
      await travel(st.r, st.ms, st.color, token);
      if (token !== runToken) return;
      var arr = st.arrive || {};
      if (arr.flash) flash(arr.flash, KIND_BY_COLOR[st.color] || 'info');
      if (arr.bump) bump(arr.bump);
      if (arr.log) pushLog(arr.log.tag, arr.log.path, arr.log.ms);
      await sleep(REDUCED ? 40 : 120);
    }
    if (autoOn && token === runToken) {
      await sleep(1000);
      if (autoOn && token === runToken) {
        runScene(SCENE_ORDER[(SCENE_ORDER.indexOf(key) + 1) % SCENE_ORDER.length]);
      }
    }
  }

  $$('.seg-btn').forEach(function (b) {
    b.addEventListener('click', function () { runScene(b.getAttribute('data-scene')); });
  });
  $('#autoPlay').addEventListener('change', function (e) {
    autoOn = e.target.checked;
    if (autoOn) runScene(current);
    else runToken++;                       // 停掉正在跑的那一轮
  });
  setStatus('选择上面任意一个场景开始演示。点「自动播放」可以依次看完全部四种走法。');

  /* ======================== 6. 工作讲解：竖向步进导航 ======================== */

  var gItems = $$('.g-item');
  var gPanels = $$('.g-panel');

  function showPanel(key) {
    var hit = false;
    gPanels.forEach(function (pl) {
      var on = pl.getAttribute('data-panel') === key;
      pl.classList.toggle('is-active', on);
      if (on) hit = true;
    });
    if (!hit) return false;
    gItems.forEach(function (b) {
      var on = b.getAttribute('data-panel') === key;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    return true;
  }

  gItems.forEach(function (b) {
    b.addEventListener('click', function () { showPanel(b.getAttribute('data-panel')); });
  });

  // 顶部导航与页脚里的 #demo / #how … 也要能切到对应面板
  $$('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function () {
      var key = (a.getAttribute('href') || '').slice(1);
      if (key) showPanel(key);
    });
  });
  window.addEventListener('hashchange', function () {
    showPanel(location.hash.slice(1));
  });
  if (location.hash) showPanel(location.hash.slice(1));   // 带锚点打开时直接进对应面板
})();
