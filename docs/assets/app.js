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

  /* ======================== 4. 缓存布局解释器 ======================== */

  var GBF_HOST_RE = /granbluefantasy\.(jp|akamaized\.net)$/i;
  var GBF_EN_CDN_RE = /gbf\.akamaized\.net$/i;
  var ASSET_RE = /^\/assets(?:_([a-z]{2}))?\//;

  var MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
    '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css',
    '.html': 'text/html', '.txt': 'text/plain', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.atlas': 'text/plain'
  };

  function extOf(p) {
    var m = /\.([a-z0-9]+)$/i.exec(p);
    return m ? '.' + m[1].toLowerCase() : '';
  }

  function analyze(raw) {
    var input = String(raw || '').trim();
    if (!input) return { state: 'error', msg: '先输入一条资源地址' };
    var u;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : 'https://' + input);
    } catch (e) {
      return { state: 'error', msg: '这不像一条能识别的网址' };
    }
    var host = u.hostname.toLowerCase();
    var p = u.pathname;
    var q = u.search ? u.search.slice(1) : '';
    var hostOk = GBF_HOST_RE.test(host) || GBF_EN_CDN_RE.test(host);

    if (!hostOk) {
      return {
        state: 'nocache', host: host, path: p, q: q, reason: 'host',
        why: ['<b>' + host + '</b> 不是游戏的域名，程序对它一无所知 —— 请求会原样转发，不缓存、不计数。',
              '程序只认识 <code>*.granbluefantasy.jp</code>（游戏本站）与 <code>*.granbluefantasy.akamaized.net</code> / <code>*.gbf.akamaized.net</code>（资源 CDN，英语树用的是后者）。',
              '域名匹配用的是<b>后缀</b>：CDN 主机名里 <code>granbluefantasy</code> 前面是连字符而不是点，写成「子域名」是匹配不到的。']
      };
    }
    if (!ASSET_RE.test(p)) {
      return {
        state: 'nocache', host: host, path: p, q: q, reason: 'path',
        why: ['主机是游戏域名，但路径 <code>' + p + '</code> 不在 <code>/assets/</code> 下 —— <b>只接管资源</b>。',
              '接口（<code>/rest/</code> <code>/ob/</code> <code>/od/</code>）必须直连：它们要带登录 Cookie 才能返回正确内容，而浏览器不会把游戏的 Cookie 发到本机代理，走缓存必然出错。',
              '一句话原则：<b>凡是需要 Cookie 才能正确返回的请求，都不走本地缓存代理。</b>']
      };
    }
    if (/\/$/.test(p)) {
      return {
        state: 'nocache', host: host, path: p, q: q, reason: 'dir',
        why: ['这条地址以 <code>/</code> 结尾，指向的是目录而不是一份资源文件，不会被缓存。']
      };
    }
    var e = extOf(p);
    var lang = ASSET_RE.exec(p)[1];
    var why = [
      '主机是游戏域名，路径在 <code>/assets' + (lang ? '_' + lang : '') + '/</code> 下 → <b>会被缓存</b>。',
      '磁盘上按 URL 路径<b>原样镜像</b>存放：把 <code>/</code> 换成 <code>\\</code>，接在缓存根目录后面。',
      q ? '这条地址带着版本参数 <code>?' + q + '</code>：它不进文件名，但会记进 <code>.ext</code> 的 <code>q</code> 字段，命中时要和它比对。'
        : '这条地址没有版本参数：<code>.ext</code> 里不会有 <code>q</code> 字段，带查询串的请求来了不会算命中。'
    ];
    if (lang) why.push('英语素材在 <code>assets_' + lang + '</code> 树下，和日语的 <code>assets</code> 是<b>两棵独立的树</b>，各记各的版本戳。');
    if (!e) why.push('注意：这条路径没有文件扩展名，程序会把它当作异常请求告警（尽力回源，不落盘）。');
    else why.push('命中要三样全对：文件在、版本串一致、CORS 头跟着文件一起存着 —— 缺一不可。');

    return { state: 'cache', host: host, path: p, q: q, ext: e, lang: lang, why: why };
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightJson(text) {
    return esc(text).replace(
      /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      function (m) {
        var cls = 'n';
        if (/^"/.test(m)) cls = /:$/.test(m) ? 'k' : 's';
        else if (/^(true|false|null)$/.test(m)) cls = 'b';
        return '<span class="' + cls + '">' + m + '</span>';
      }
    );
  }

  var outKey = $('#outKey'), outPath = $('#outPath'), outExt = $('#outExt');
  var jsonOut = $('#jsonOut'), jsonTitle = $('#jsonTitle');
  var verdictBadge = $('#verdictBadge'), verdictText = $('#verdictText'), whyList = $('#whyList');
  var currentJson = '';

  function render(raw) {
    var r = analyze(raw);
    whyList.innerHTML = '';

    if (r.state === 'error') {
      verdictBadge.textContent = '无法识别';
      verdictBadge.classList.add('off');
      verdictText.textContent = r.msg;
      outKey.textContent = outPath.textContent = outExt.textContent = '—';
      jsonOut.textContent = '—';
      jsonTitle.textContent = '.ext 内容';
      currentJson = '';
      return;
    }
    if (r.state === 'nocache') {
      verdictBadge.textContent = '原样直连';
      verdictBadge.classList.add('off');
      verdictText.textContent = '不进缓存，也不计入任何统计';
      outKey.innerHTML = '<code class="muted">' + esc(r.path) + '（非 /assets/ 路径）</code>';
      outPath.innerHTML = '<code class="muted">— 不落盘 —</code>';
      outExt.innerHTML = '<code class="muted">— 没有元数据 —</code>';
      jsonTitle.textContent = '.ext 内容（不会有）';
      currentJson = '';
      jsonOut.innerHTML = '<span class="c">// 这条请求不会被缓存，磁盘上不会出现对应的文件与 .ext</span>';
      whyList.innerHTML = r.why.map(function (w) { return '<li>' + w + '</li>'; }).join('');
      return;
    }

    // 会被缓存
    verdictBadge.textContent = '会被缓存';
    verdictBadge.classList.remove('off');
    verdictText.textContent = 'GET/HEAD 且路径在 /assets' + (r.lang ? '_' + r.lang : '') + '/ 下';

    var disk = ('<缓存根目录>' + r.path).replace(/\//g, '\\');
    outKey.innerHTML = '<code>' + esc(r.path) + '</code>';
    outPath.innerHTML = '<code>' + esc(disk) + '</code>';
    outExt.innerHTML = '<code>' + esc(disk + '.ext') + '</code>';

    var ct = MIME[r.ext] || 'application/octet-stream';
    var meta = {
      LastModified: 'Mon, 12 Oct 2026 02:11:40 GMT',
      ETag: '"6f1c9a4e-2b0f"',
      at: Math.floor(Date.now() / 1000),
      ce: '',
      ct: ct,
      v: 1
    };
    var crossOrigin = /akamaized\.net$/i.test(r.host);
    if (crossOrigin) meta.cors = { 'access-control-allow-origin': 'https://game.granbluefantasy.jp' };
    if (r.q) meta.q = r.q;

    currentJson = JSON.stringify(meta, null, 2);
    jsonTitle.textContent = '.ext 内容（旁边那份同名元数据）';
    jsonOut.innerHTML = highlightJson(currentJson);
    whyList.innerHTML = r.why.map(function (w) { return '<li>' + w + '</li>'; }).join('');
  }

  var urlInput = $('#urlInput');
  urlInput.addEventListener('input', function () { render(urlInput.value); });
  $$('.exp-presets .chip').forEach(function (c) {
    c.addEventListener('click', function () {
      $$('.exp-presets .chip').forEach(function (x) { x.classList.remove('on'); });
      c.classList.add('on');
      urlInput.value = c.getAttribute('data-url');
      render(urlInput.value);
    });
  });
  $('#copyJson').addEventListener('click', function () {
    var btn = this;
    if (!currentJson) { btn.textContent = '没有内容'; setTimeout(function () { btn.textContent = '复制'; }, 1200); return; }
    var done = function (ok) {
      btn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(function () { btn.textContent = '复制'; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(currentJson).then(function () { done(true); }, function () { done(false); });
    } else {
      try {
        var ta = document.createElement('textarea');
        ta.value = currentJson;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        done(document.execCommand('copy'));
        document.body.removeChild(ta);
      } catch (e) { done(false); }
    }
  });

  render(urlInput.value);
  $$('.exp-presets .chip')[0].classList.add('on');

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
