/* ===================================================================
 * notes-comment.js — 学习笔记「选中评论」侧栏（5 篇 HTML 共用）
 * -------------------------------------------------------------------
 * 作用：选中笔记里的文字 → 写评论 → 评论沉在右侧栏，多设备互通。
 *       读完一轮后由 AI（ask-note skill）批量读取、答复、必要时改笔记。
 *
 * 架构（无服务端）：浏览器直连 GitHub Contents API，读写私有仓
 *   oldyears/notes-comments 里的 <笔记basename>.json。
 *   凭证是 fine-grained PAT（只有该仓 Contents 写权限），只存 localStorage，
 *   绝不写进任何仓库。
 *
 * 静默模式（重要）：站点是公开的。没有 token 时本脚本什么都不做——
 *   不注入样式、不建 DOM、不发请求。陌生访客看到的是干净的阅读页。
 *   录入入口：URL 加 #nc-setup，或 500ms 内连按三次 c。
 *
 * 无外部依赖、单文件（对齐 note-conventions 5.2）。数学公式取 TeX 源码，
 * 走 MathJax.startup.document.math 配对，不依赖脚本与排版的先后时机。
 *
 * 引用方式：各 HTML 在 </body> 前用 hostname 分流加载（线上被同步脚本
 * 拍平到同目录，本地在上一层）：
 *   <script>
 *     (function(){var l=location.protocol==="file:"||
 *       /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
 *       var s=document.createElement("script");
 *       s.src=l?"../notes-comment.js":"notes-comment.js";
 *       s.onerror=function(){};document.body.appendChild(s);})();
 *   </script>
 * =================================================================== */
(function () {
  "use strict";

  /* =================================================================
   * 0. 常量与小工具
   * ================================================================= */

  var REPO = "oldyears/notes-comments";       // 评论专用私有仓
  var API = "https://api.github.com/repos/" + REPO;
  var K_TOKEN = "nc:token";
  var K_DEVICE = "nc:device";
  var K_NOTE = "nc:note:";                    // + basename
  var SCHEMA = 1;
  var CTX = 60;                               // prefix/suffix 各取多少字符
  var QUOTE_MAX = 400;
  var PUSH_RETRY = 3;

  // 笔记 basename → 源码路径。线上拿不到 hwX 层级，靠这张表让评论带上
  // sourcePath，方便 AI 直接定位。加新笔记时补一行；漏了也不致命——
  // ask-note skill 会在 cmu-dlsys/homework 下按 basename glob 兜底。
  var NOTE_SOURCES = {
    "softmax-loss-derivation": "cmu-dlsys/homework/hw0/softmax-loss-derivation.html",
    "backprop-derivation": "cmu-dlsys/homework/hw0/backprop-derivation.html",
    "autodiff-derivation": "cmu-dlsys/homework/hw1/autodiff-derivation.html",
    "autodiff-impl-derivation": "cmu-dlsys/homework/hw1/autodiff-impl-derivation.html",
    "optimization-derivation": "cmu-dlsys/homework/hw2/optimization-derivation.html"
  };

  function $(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function nowISO() {
    // 带本地时区偏移的 ISO，便于人读（AI 也按这个排序）
    var d = new Date();
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? "+" : "-";
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) +
      sign + pad(Math.floor(Math.abs(off) / 60)) + ":" + pad(Math.abs(off) % 60);
  }

  function uid() {
    return "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  }

  // 滚动定位：老浏览器/非浏览器环境可能没有 scrollIntoView，别为此炸掉整条链路
  function scrollTo(el, opts) {
    if (el && typeof el.scrollIntoView === "function") {
      try { el.scrollIntoView(opts); } catch (e) { el.scrollIntoView(); }
    }
  }

  // GitHub 的 content 是 UTF-8 base64。btoa 直接吃中文会抛，必须先编字节。
  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = "", CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function noteKey() {
    var parts = decodeURIComponent(location.pathname).split("/");
    var last = parts[parts.length - 1] || "index.html";
    return last.replace(/\.html?$/i, "");
  }

  function sourcePath(key) {
    if (NOTE_SOURCES[key]) return NOTE_SOURCES[key];
    // 本地打开时能从路径里直接推出来
    var p = decodeURIComponent(location.pathname);
    var i = p.indexOf("/cmu-dlsys/");
    if (i >= 0) return p.slice(i + 1);
    var j = p.indexOf("/homework/");
    if (j >= 0) return "cmu-dlsys" + p.slice(j);
    return null;
  }

  var NOTE = noteKey();
  var SRC = sourcePath(NOTE);

  /* =================================================================
   * 1. 静默模式闸门 —— 没 token 就什么都不做
   * ================================================================= */

  function getToken() {
    try { return localStorage.getItem(K_TOKEN) || ""; } catch (e) { return ""; }
  }

  if (!getToken()) {
    installSetupTrigger();
    return;   // 零 DOM、零样式、零请求
  }

  boot();

  /* -------- 录入入口：#nc-setup 或连按三次 c -------- */
  function installSetupTrigger() {
    function check() {
      if (location.hash === "#nc-setup") openSetup();
    }
    window.addEventListener("hashchange", check);
    var hits = [], LIMIT = 500;
    window.addEventListener("keydown", function (e) {
      if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target, tag = t && t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (t && t.isContentEditable)) return;
      var now = Date.now();
      hits = hits.filter(function (x) { return now - x < LIMIT; });
      hits.push(now);
      if (hits.length >= 3) { hits = []; openSetup(); }
    });
    check();
  }

  /* =================================================================
   * 2. 样式（自注入，不依赖页面已有 class）
   * 配色沿用笔记既有语义色：主蓝 #4a90d9、成功绿 #22a06b、警示橙 #d97706
   * ================================================================= */

  var CSS = [
    /* ---- 正文位移：只在开栏时生效，关栏时页面与原来完全一致 ---- */
    "html.nc-open body{max-width:820px;margin:40px auto 40px max(24px,calc(50% - 560px));}",
    "html.nc-open #nc-panel{transform:translateX(0);}",

    /* ---- 侧栏 ---- */
    "#nc-panel{position:fixed;top:0;right:0;width:300px;height:100vh;z-index:99998;",
    "background:#fbfcfd;border-left:1px solid #d0d7de;display:flex;flex-direction:column;",
    "font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;font-size:13px;",
    "color:#1f2328;transform:translateX(100%);transition:transform .22s ease;}",
    "#nc-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e4e8ec;",
    "background:#fff;flex:0 0 auto;}",
    "#nc-title{font-weight:600;font-size:13px;flex:1 1 auto;}",
    "#nc-head button{background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px;",
    "border-radius:4px;color:#57606a;line-height:1;}",
    "#nc-head button:hover{background:#eef1f4;}",
    "#nc-state{cursor:pointer;font-size:13px;padding:2px 4px;border-radius:4px;}",
    "#nc-state:hover{background:#eef1f4;}",
    "#nc-filter{display:flex;align-items:center;gap:6px;padding:7px 12px;border-bottom:1px solid #e4e8ec;",
    "color:#57606a;font-size:12px;background:#fff;flex:0 0 auto;}",
    "#nc-filter label{display:flex;align-items:center;gap:5px;cursor:pointer;}",
    "#nc-list{flex:1 1 auto;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:9px;}",
    "#nc-empty{color:#8b949e;font-size:12px;line-height:1.7;padding:14px 4px;}",

    /* ---- 卡片 ---- */
    ".nc-card{background:#fff;border:1px solid #d8dee4;border-left:3px solid #d0d7de;border-radius:6px;",
    "padding:9px 10px;cursor:pointer;transition:border-color .15s,box-shadow .15s;}",
    ".nc-card:hover{box-shadow:0 1px 5px rgba(0,0,0,.07);}",
    ".nc-card.open{border-left-color:#d97706;}",
    ".nc-card.resolved{border-left-color:#22a06b;background:#fcfdfc;}",
    ".nc-card.active{border-color:#4a90d9;box-shadow:0 0 0 2px rgba(74,144,217,.16);}",
    ".nc-card.stale{border-left-color:#cf222e;}",
    ".nc-quote{color:#57606a;font-size:11.5px;line-height:1.55;border-left:2px solid #ffd97a;",
    "padding-left:7px;margin-bottom:6px;max-height:3.2em;overflow:hidden;}",
    ".nc-body{line-height:1.6;white-space:pre-wrap;word-break:break-word;}",
    ".nc-reply{margin-top:7px;padding:7px 8px;background:#f0f7f3;border-radius:5px;",
    "font-size:12.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;color:#1a4d38;}",
    ".nc-reply-h{font-weight:600;font-size:11px;color:#1a7a4f;margin-bottom:3px;}",
    ".nc-meta{display:flex;align-items:center;gap:7px;margin-top:6px;font-size:11px;color:#8b949e;}",
    ".nc-meta .sp{flex:1 1 auto;}",
    ".nc-meta button{background:none;border:none;cursor:pointer;color:#8b949e;font-size:11px;padding:1px 3px;",
    "border-radius:3px;}",
    ".nc-meta button:hover{background:#eef1f4;color:#1f2328;}",
    ".nc-badge{font-size:10.5px;padding:1px 6px;border-radius:9px;border:1px solid transparent;}",
    ".nc-badge.b-open{background:#fff8e6;border-color:#f0d9a8;color:#a35a04;}",
    ".nc-badge.b-res{background:#eafaf1;border-color:#a8dcc0;color:#1a7a4f;}",
    ".nc-badge.b-stale{background:#fff0ef;border-color:#f0b8b4;color:#a4292f;}",

    /* ---- 编辑态 ---- */
    ".nc-edit textarea{width:100%;box-sizing:border-box;min-height:62px;resize:vertical;",
    "border:1px solid #c9d1d9;border-radius:5px;padding:6px 7px;font-size:13px;line-height:1.6;",
    "font-family:inherit;color:#1f2328;}",
    ".nc-edit textarea:focus{outline:none;border-color:#4a90d9;box-shadow:0 0 0 2px rgba(74,144,217,.14);}",
    ".nc-edit-bar{display:flex;align-items:center;gap:6px;margin-top:6px;}",
    ".nc-edit-bar .hint{flex:1 1 auto;font-size:10.5px;color:#8b949e;}",
    ".nc-primary{background:#4a90d9;color:#fff;border:none;border-radius:5px;padding:4px 12px;",
    "font-size:12px;cursor:pointer;}",
    ".nc-primary:hover{background:#3b7bc0;}",
    ".nc-ghost{background:none;border:1px solid #d0d7de;border-radius:5px;padding:4px 10px;",
    "font-size:12px;cursor:pointer;color:#57606a;}",
    ".nc-ghost:hover{background:#f3f5f7;}",

    /* ---- 正文高亮 ---- */
    "mark.nc-hl{background:#fff4c2;color:inherit;padding:0;border-radius:2px;cursor:pointer;",
    "scroll-margin-top:90px;}",
    "mark.nc-hl.active{background:#ffe58a;box-shadow:0 0 0 1px #e0b34a;}",
    ".nc-hl-box{outline:2px solid #ffd97a;outline-offset:1px;border-radius:3px;scroll-margin-top:90px;}",
    ".nc-hl-box.active{outline-color:#e0b34a;}",

    /* ---- 浮动按钮 / 把手 / toast ---- */
    "#nc-btn{position:fixed;z-index:99999;display:none;align-items:center;gap:5px;background:#4a90d9;",
    "color:#fff;border:none;border-radius:6px;padding:7px 13px;font-size:13px;min-height:34px;",
    "font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;cursor:pointer;",
    "box-shadow:0 2px 8px rgba(0,0,0,.18);}",
    "#nc-btn:hover{background:#3b7bc0;}",
    "#nc-handle{position:fixed;z-index:99997;right:0;top:50%;transform:translateY(-50%);",
    "background:#4a90d9;color:#fff;border:none;border-radius:6px 0 0 6px;padding:11px 5px;",
    "font-size:12px;line-height:1.25;cursor:pointer;writing-mode:vertical-rl;letter-spacing:2px;",
    "box-shadow:-1px 0 6px rgba(0,0,0,.14);}",
    "html.nc-open #nc-handle{display:none;}",
    "#nc-toast{position:fixed;z-index:100000;top:18px;left:50%;transform:translate(-50%,-8px);",
    "background:#22a06b;color:#fff;padding:9px 16px;border-radius:6px;font-size:13px;",
    "font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:76vw;",
    "box-shadow:0 3px 12px rgba(0,0,0,.2);opacity:0;transition:opacity .2s,transform .2s;",
    "pointer-events:none;}",
    "#nc-toast.show{opacity:1;transform:translate(-50%,0);}",

    /* ---- 设置弹窗 ---- */
    "#nc-modal{position:fixed;inset:0;z-index:100001;display:flex;align-items:center;",
    "justify-content:center;background:rgba(20,24,28,.45);padding:20px;}",
    "#nc-modal .box{background:#fff;border-radius:9px;padding:20px 22px;width:min(430px,100%);",
    "box-shadow:0 10px 34px rgba(0,0,0,.26);font-family:-apple-system,'PingFang SC',sans-serif;",
    "font-size:13px;color:#1f2328;box-sizing:border-box;}",
    "#nc-modal h3{margin:0 0 10px;font-size:15px;}",
    "#nc-modal p{margin:0 0 12px;color:#57606a;line-height:1.7;font-size:12px;}",
    "#nc-modal label{display:block;margin-bottom:4px;font-size:12px;color:#57606a;}",
    "#nc-modal input{width:100%;box-sizing:border-box;border:1px solid #c9d1d9;border-radius:5px;",
    "padding:7px 9px;font-size:13px;margin-bottom:12px;font-family:inherit;}",
    "#nc-modal input:focus{outline:none;border-color:#4a90d9;box-shadow:0 0 0 2px rgba(74,144,217,.14);}",
    "#nc-modal .row{display:flex;align-items:center;gap:8px;}",
    "#nc-modal .row .sp{flex:1 1 auto;}",
    "#nc-modal .err{color:#a4292f;font-size:12px;margin:-6px 0 10px;min-height:1.2em;}",

    /* ---- 窄屏（手机/iPad 是多设备主力）：侧栏改覆盖式，不挤正文 ---- */
    "@media (max-width:1100px){",
    "html.nc-open body{max-width:820px;margin:40px auto;}",
    "#nc-panel{width:min(340px,86vw);box-shadow:-3px 0 18px rgba(0,0,0,.18);}",
    "#nc-backdrop{position:fixed;inset:0;z-index:99996;background:rgba(20,24,28,.32);}",
    "}"
  ].join("");

  /* =================================================================
   * 3. 文本索引与 TeX 还原
   * -----------------------------------------------------------------
   * 目标：把正文压成一条「归一化纯文本」，并保留 纯文本偏移 ↔ text node
   * 的双向映射。mjx-container 整体当作一个不可分割 token，其文本取回
   * TeX 源码，这样选中公式拿到的是 $...$ 而不是渲染字符垃圾。
   * ================================================================= */

  var texReady = false;

  /* -------- TeX 还原：走 MathJax.startup.document.math 直接配对 --------
   * 每个 MathItem 同时有 .math（源码）和 .typesetRoot（对应的 mjx-container），
   * 是一一对应关系，不依赖本脚本与排版的先后时机——这是主路径。
   * 拿不到时退到「按文档序配对预扫描结果」，再不行标 [公式] 并提示。 */
  var preScan = [];

  function prescanTex() {
    // 若排版尚未发生，正文 text node 里还留着 $...$ 源码，按文档序抽出来备用
    try {
      var items = [];
      collect(document.body, items);
      var buf = items.map(function (x) { return x.kind === "text" ? x.text : ""; }).join("");
      var re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, m;
      while ((m = re.exec(buf))) {
        preScan.push(m[1] != null ? "$$" + m[1] + "$$" : "$" + m[2] + "$");
      }
    } catch (e) { /* 备用路径失败不影响主路径 */ }
  }

  function recoverTex() {
    var containers = document.querySelectorAll("mjx-container");
    if (!containers.length) { texReady = true; return; }

    // 主路径：MathItem 配对
    try {
      var list = Array.from(window.MathJax.startup.document.math);
      var hit = 0;
      for (var i = 0; i < list.length; i++) {
        var it = list[i], root = it.typesetRoot, src = it.math;
        if (!root || typeof src !== "string") continue;
        root.dataset.tex = it.display ? "$$" + src + "$$" : "$" + src + "$";
        hit++;
      }
      if (hit === containers.length) { texReady = true; return; }
    } catch (e) { /* 落到备用路径 */ }

    // 备用路径：按文档序与预扫描结果配对
    if (preScan.length === containers.length) {
      for (var j = 0; j < containers.length; j++) {
        if (!containers[j].dataset.tex) containers[j].dataset.tex = preScan[j];
      }
      texReady = true;
      return;
    }

    // 兜底：标记为 [公式]，提交评论时会提示用户在正文里补充说明
    for (var k = 0; k < containers.length; k++) {
      if (!containers[k].dataset.tex) containers[k].dataset.tex = "[公式]";
    }
    texReady = false;
  }

  function texOf(el) {
    return el.dataset && el.dataset.tex ? el.dataset.tex : "[公式]";
  }

  /* -------- 收集：手写递归，因为 TreeWalker 无法「接受但不下降」 -------- */
  function collect(node, out) {
    if (node.nodeType === 3) {                       // text
      if (node.nodeValue) out.push({ node: node, text: node.nodeValue, kind: "text" });
      return;
    }
    if (node.nodeType !== 1) return;                 // 注释等一律跳过
    var tag = node.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") return;
    if (node.id && node.id.indexOf("nc-") === 0) return;   // 本脚本自己的 DOM
    if (tag === "MJX-CONTAINER") {
      out.push({ node: node, text: texOf(node), kind: "math" });
      return;                                        // 不下降，避免 assistive-mml
    }
    for (var c = node.firstChild; c; c = c.nextSibling) collect(c, out);
  }

  /* -------- 建索引 --------
   * 空白折叠成单个空格（与用户肉眼看到的一致，也便于 AI grep），
   * 每个 text 片段记 offs[]：归一化后第 k 个字符 → 原始 nodeValue 下标。 */
  function buildIndex() {
    var items = [], plain = "", segs = [], prevSpace = true;
    collect(document.body, items);

    for (var i = 0; i < items.length; i++) {
      var it = items[i];

      if (it.kind === "math") {
        var ms = plain.length;
        plain += it.text;
        segs.push({ node: it.node, kind: "math", s: ms, e: plain.length });
        prevSpace = false;
        continue;
      }

      var raw = it.text, ts = plain.length, offs = [];
      for (var j = 0; j < raw.length; j++) {
        var ch = raw.charAt(j);
        var sp = ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === " ";
        if (sp) {
          if (prevSpace) continue;
          plain += " "; offs.push(j); prevSpace = true;
        } else {
          plain += ch; offs.push(j); prevSpace = false;
        }
      }
      if (plain.length > ts) {
        segs.push({ node: it.node, kind: "text", s: ts, e: plain.length, offs: offs });
      }
    }
    return { plain: plain, segs: segs };
  }

  var idx = null;
  function index(force) {
    // 高亮会插入 <mark>（纯文本不变但 node 结构变了），所以按需重建
    if (force || !idx) idx = buildIndex();
    return idx;
  }
  function dirtyIndex() { idx = null; }

  function segAt(ix, off) {
    for (var i = 0; i < ix.segs.length; i++) {
      var g = ix.segs[i];
      if (off >= g.s && off < g.e) return g;
    }
    return null;
  }

  /* -------- 纯文本偏移 → DOM 位置 -------- */
  function rawStart(seg, off) {
    if (seg.kind !== "text") return 0;
    return seg.offs[off - seg.s];
  }
  function rawEnd(seg, off) {
    if (seg.kind !== "text") return 0;
    var k = off - 1 - seg.s;
    if (k < 0) return 0;
    return seg.offs[k] + 1;
  }

  /* -------- DOM 位置 → 纯文本偏移 -------- */
  function plainOffsetOf(ix, node, offset, isEnd) {
    // 元素节点：换算到它的第 offset 个子节点起点
    if (node.nodeType === 1) {
      var kid = node.childNodes[offset];
      if (!kid && node.childNodes.length) kid = node.childNodes[node.childNodes.length - 1];
      if (kid) {
        var g0 = findSegFor(ix, kid);
        if (g0) return isEnd ? g0.e : g0.s;
      }
      var own = findSegFor(ix, node);
      if (own) return isEnd ? own.e : own.s;
      return -1;
    }
    for (var i = 0; i < ix.segs.length; i++) {
      var g = ix.segs[i];
      if (g.node !== node) continue;
      if (g.kind !== "text") return isEnd ? g.e : g.s;
      // 找归一化下标：第一个原始下标 >= offset 的位置
      for (var k = 0; k < g.offs.length; k++) {
        if (g.offs[k] >= offset) return g.s + k;
      }
      return g.e;
    }
    return -1;
  }

  // node 自身或其祖先/后代命中的第一个 segment
  function findSegFor(ix, node) {
    for (var i = 0; i < ix.segs.length; i++) {
      var g = ix.segs[i];
      if (g.node === node) return g;
      if (node.nodeType === 1 && node.contains(g.node)) return g;
      if (g.node.nodeType === 1 && g.node.contains(node)) return g;
    }
    return null;
  }

  /* =================================================================
   * 4. 锚点
   * -----------------------------------------------------------------
   * 存的是引文而非行号/DOM 路径：quote + 前后各 60 字 + 最近标题的 id。
   * 笔记被小幅编辑后依然能命中；实在命中不了就降级到章节级并显式告知，
   * 绝不静默错位。
   * ================================================================= */

  function nearestHeading(node) {
    var heads = document.querySelectorAll("h1,h2,h3");
    var best = null;
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i];
      var rel = h.compareDocumentPosition(node);
      // node 在 h 之后，或就在 h 里面 → h 是候选，取最后一个即最近的
      if (rel === 0 || (rel & Node.DOCUMENT_POSITION_FOLLOWING) ||
          (rel & Node.DOCUMENT_POSITION_CONTAINED_BY)) best = h;
    }
    return best;
  }

  function headingInfo(node) {
    var h = nearestHeading(node);
    if (!h) return { headingText: "", headingId: "" };
    return {
      headingText: (h.textContent || "").replace(/\s+/g, " ").trim(),
      headingId: h.id || ""
    };
  }

  /* -------- 选区 → 锚点 -------- */
  function anchorFromSelection(sel) {
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var r = sel.getRangeAt(0);
    var ix = index(true);

    var s = plainOffsetOf(ix, r.startContainer, r.startOffset, false);
    var e = plainOffsetOf(ix, r.endContainer, r.endOffset, true);

    // 精确映射失败 → 退回「拿 selection 文本在纯文本里搜」
    if (s < 0 || e < 0 || e <= s) {
      var t = (sel.toString() || "").replace(/\s+/g, " ").trim();
      if (!t) return null;
      var at = ix.plain.indexOf(t);
      if (at < 0) return null;
      s = at; e = at + t.length;
    }

    var quote = ix.plain.slice(s, e).trim();
    if (!quote) return null;
    var truncated = false;
    if (quote.length > QUOTE_MAX) { quote = quote.slice(0, QUOTE_MAX) + "…"; truncated = true; }

    var base = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode;
    var hi = headingInfo(base);

    return {
      headingText: hi.headingText,
      headingId: hi.headingId,
      quote: quote,
      prefix: ix.plain.slice(Math.max(0, s - CTX), s).trim(),
      suffix: ix.plain.slice(e, e + CTX).trim(),
      truncated: truncated || undefined
    };
  }

  /* -------- 锚点 → 纯文本区间：四级降级搜索 -------- */
  function locate(ix, a) {
    if (!a || !a.quote) return null;
    var q = a.quote.replace(/…$/, "");
    if (!q) return null;
    var p = ix.plain;

    // 逐级放宽：prefix+quote+suffix → quote+suffix → prefix+quote → 裸 quote
    var tries = [[a.prefix, a.suffix], [null, a.suffix], [a.prefix, null], [null, null]];
    for (var i = 0; i < tries.length; i++) {
      var pre = tries[i][0] || "", suf = tries[i][1] || "";
      var seps = pre || suf ? [" ", ""] : [""];
      for (var v = 0; v < seps.length; v++) {
        var sep = seps[v];
        var needle = (pre ? pre + sep : "") + q + (suf ? sep + suf : "");
        var at = p.indexOf(needle);
        if (at < 0) continue;
        var qs = at + (pre ? pre.length + sep.length : 0);
        return { s: qs, e: qs + q.length, exact: i === 0 };
      }
    }
    return null;
  }

  /* -------- 区间 → 高亮 --------
   * 绝不进入 mjx-container 内部（会破坏 CHTML 结构）：命中区间与公式容器
   * 相交时在边界断开，容器自身只加外框类。 */
  function highlight(cid, a) {
    var ix = index(true);
    var loc = locate(ix, a);
    if (!loc) return false;

    var ops = [], boxes = [];
    for (var i = 0; i < ix.segs.length; i++) {
      var g = ix.segs[i];
      if (g.e <= loc.s || g.s >= loc.e) continue;
      if (g.kind === "math") { boxes.push(g.node); continue; }
      var from = Math.max(g.s, loc.s), to = Math.min(g.e, loc.e);
      if (to <= from) continue;
      ops.push({ node: g.node, a: rawStart(g, from), b: rawEnd(g, to) });
    }
    if (!ops.length && !boxes.length) return false;

    for (var j = 0; j < ops.length; j++) {
      var op = ops[j];
      try { wrapText(op.node, op.a, op.b, cid); } catch (e) { /* 单段失败不影响其余 */ }
    }
    for (var k = 0; k < boxes.length; k++) {
      boxes[k].classList.add("nc-hl-box");
      boxes[k].dataset.cid = cid;
    }
    dirtyIndex();
    return true;
  }

  function wrapText(node, a, b, cid) {
    var len = node.nodeValue.length;
    a = Math.max(0, Math.min(a, len));
    b = Math.max(a, Math.min(b, len));
    if (b <= a) return;
    var target = node;
    if (b < len) target.splitText(b);
    if (a > 0) target = target.splitText(a);
    var mark = $("mark", "nc-hl");
    mark.dataset.cid = cid;
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
  }

  function clearHighlights() {
    var marks = document.querySelectorAll("mark.nc-hl");
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i], p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    }
    var boxes = document.querySelectorAll(".nc-hl-box");
    for (var j = 0; j < boxes.length; j++) {
      boxes[j].classList.remove("nc-hl-box", "active");
      delete boxes[j].dataset.cid;
    }
    dirtyIndex();
  }

  function nodesFor(cid) {
    return document.querySelectorAll('[data-cid="' + cid + '"]');
  }

  /* =================================================================
   * 5. 数据层：localStorage 镜像 + GitHub Contents API + 同步
   * -----------------------------------------------------------------
   * 乐观更新：先写本地 + 渲染，再推远端。推失败就挂着（⏳ 待同步），
   * 联网/切回页面时自动补推。409（别的设备先写了）走「重拉 → 按 id 取
   * 并集 → 重试」，任何情况下不覆盖别人写的评论。
   * ================================================================= */

  var state = "synced";        // synced | pending | offline | unauthorized
  var local = null;            // { doc, sha, dirty }

  function emptyDoc() {
    return {
      note: NOTE, sourcePath: SRC, schema: SCHEMA,
      updatedAt: nowISO(), comments: [], deleted: []
    };
  }

  function readLocal() {
    try {
      var raw = localStorage.getItem(K_NOTE + NOTE);
      if (!raw) return { doc: emptyDoc(), sha: null, dirty: false };
      var o = JSON.parse(raw);
      o.doc = o.doc || emptyDoc();
      o.doc.comments = o.doc.comments || [];
      o.doc.deleted = o.doc.deleted || [];
      return o;
    } catch (e) {
      return { doc: emptyDoc(), sha: null, dirty: false };
    }
  }

  function writeLocal() {
    try { localStorage.setItem(K_NOTE + NOTE, JSON.stringify(local)); }
    catch (e) { toast("本地存储写入失败（配额？）", "warn"); }
  }

  /* -------- 合并：按 id 取并集，墓碑优先，避免删除被复活 -------- */
  function mergeDocs(a, b) {
    var out = emptyDoc();
    out.sourcePath = a.sourcePath || b.sourcePath || SRC;

    var tomb = {};
    (a.deleted || []).concat(b.deleted || []).forEach(function (id) { tomb[id] = 1; });

    var by = {};
    (a.comments || []).concat(b.comments || []).forEach(function (c) {
      if (!c || !c.id || tomb[c.id]) return;
      var prev = by[c.id];
      if (!prev) { by[c.id] = c; return; }
      // 同 id 取更新的那份；updatedAt 缺失时退到 createdAt
      var pt = prev.updatedAt || prev.createdAt || "";
      var ct = c.updatedAt || c.createdAt || "";
      if (ct > pt) by[c.id] = c;
      // 有答复的一份不该被无答复的覆盖
      else if (ct === pt && !prev.reply && c.reply) by[c.id] = c;
    });

    out.comments = Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (x, y) { return (x.createdAt || "") < (y.createdAt || "") ? -1 : 1; });
    out.deleted = Object.keys(tomb);
    out.updatedAt = nowISO();
    return out;
  }

  /* -------- GitHub API -------- */
  function api(method, path, body) {
    var url = API + path;
    var opt = {
      method: method,
      headers: {
        "Authorization": "Bearer " + getToken(),
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    };
    if (body != null) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    return fetch(url, opt).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { /* 非 JSON 响应 */ }
        return { status: r.status, ok: r.ok, body: j };
      });
    });
  }

  var FILE = "/contents/" + encodeURIComponent(NOTE + ".json");

  function fetchRemote() {
    return api("GET", FILE).then(function (r) {
      if (r.status === 404) return { doc: null, sha: null };   // 首次评论，文件还不存在
      if (r.status === 401 || r.status === 403) { state = "unauthorized"; return null; }
      if (!r.ok || !r.body) return null;
      var doc;
      try { doc = JSON.parse(b64decode(r.body.content)); } catch (e) { return null; }
      doc.comments = doc.comments || [];
      doc.deleted = doc.deleted || [];
      return { doc: doc, sha: r.body.sha };
    });
  }

  function putRemote(doc, sha, msg) {
    var body = { message: msg, content: b64encode(JSON.stringify(doc, null, 2) + "\n") };
    if (sha) body.sha = sha;
    return api("PUT", FILE, body);
  }

  /* -------- 推送（含 409 合并重试） -------- */
  var pushing = false;

  function push(msg, attempt) {
    attempt = attempt || 1;
    if (!getToken()) { state = "unauthorized"; renderState(); return Promise.resolve(false); }
    if (pushing) return Promise.resolve(false);
    pushing = true;

    return putRemote(local.doc, local.sha, msg || ("comment: " + NOTE)).then(function (r) {
      pushing = false;

      if (r.ok && r.body && r.body.content) {
        local.sha = r.body.content.sha;
        local.dirty = false;
        writeLocal();
        state = "synced";
        renderState();
        return true;
      }

      if (r.status === 401 || r.status === 403) {
        state = "unauthorized"; renderState();
        toast("凭证无效或已撤销，评论已本地保存。按 #nc-setup 重新录入", "warn");
        return false;
      }

      // sha 过期 / 文件已被别的设备改过 → 重拉合并重试
      if ((r.status === 409 || r.status === 422) && attempt <= PUSH_RETRY) {
        return fetchRemote().then(function (rem) {
          if (rem && rem.doc) {
            local.doc = mergeDocs(local.doc, rem.doc);
            local.sha = rem.sha;
          } else if (rem) {
            local.sha = rem.sha;
          }
          writeLocal();
          render();
          return push(msg, attempt + 1);
        });
      }

      state = "pending"; renderState();
      toast("同步失败（" + r.status + "），评论已本地保存，稍后自动重试", "warn");
      return false;
    }).catch(function () {
      pushing = false;
      state = navigator.onLine ? "pending" : "offline";
      renderState();
      return false;
    });
  }

  function flush() {
    if (local && local.dirty && getToken() && navigator.onLine) push();
  }

  /* -------- 初次加载：先渲本地镜像，再拉远端 -------- */
  function loadAll() {
    local = readLocal();
    if (local.dirty) state = "pending";
    render();

    if (!navigator.onLine) { state = "offline"; renderState(); return; }

    fetchRemote().then(function (rem) {
      if (!rem) { renderState(); return; }
      if (rem.doc) {
        local.doc = local.dirty ? mergeDocs(local.doc, rem.doc) : rem.doc;
      }
      local.sha = rem.sha;
      writeLocal();
      render();
      if (local.dirty) push(); else { state = "synced"; renderState(); }
    }).catch(function () {
      state = navigator.onLine ? "pending" : "offline";
      renderState();
    });
  }

  /* -------- 增删改 -------- */
  function addComment(anchor, body) {
    var c = {
      id: uid(), createdAt: nowISO(), updatedAt: nowISO(),
      device: getDevice(), status: "open",
      anchor: anchor, body: body, reply: null, resolvedAt: null
    };
    local.doc.comments.push(c);
    touch("comment: " + NOTE + " +1");
    return c;
  }

  function editComment(id, body) {
    var c = findComment(id);
    if (!c) return;
    c.body = body;
    c.updatedAt = nowISO();
    touch("comment: " + NOTE + " 编辑");
  }

  function removeComment(id) {
    local.doc.comments = local.doc.comments.filter(function (c) { return c.id !== id; });
    if (local.doc.deleted.indexOf(id) < 0) local.doc.deleted.push(id);
    touch("comment: " + NOTE + " 删除");
  }

  function toggleResolved(id) {
    var c = findComment(id);
    if (!c) return;
    if (c.status === "resolved") { c.status = "open"; c.resolvedAt = null; }
    else { c.status = "resolved"; c.resolvedAt = nowISO(); }
    c.updatedAt = nowISO();
    touch("comment: " + NOTE + " " + c.status);
  }

  function touch(msg) {
    local.doc.updatedAt = nowISO();
    local.doc.sourcePath = local.doc.sourcePath || SRC;
    local.dirty = true;
    state = "pending";
    writeLocal();
    render();
    push(msg);
  }

  function findComment(id) {
    var cs = local.doc.comments;
    for (var i = 0; i < cs.length; i++) if (cs[i].id === id) return cs[i];
    return null;
  }

  function getDevice() {
    try { return localStorage.getItem(K_DEVICE) || "unknown"; } catch (e) { return "unknown"; }
  }

  /* =================================================================
   * 6. UI
   * ================================================================= */

  var panel, listEl, titleEl, stateEl, emptyEl, btn, handle, toastEl, backdrop;
  var onlyOpen = false, activeId = null, draft = null;

  function buildUI() {
    var style = $("style");
    style.id = "nc-style";
    style.textContent = CSS;
    document.head.appendChild(style);

    /* -------- 侧栏 -------- */
    panel = $("div"); panel.id = "nc-panel";

    var head = $("div"); head.id = "nc-head";
    titleEl = $("span"); titleEl.id = "nc-title"; titleEl.textContent = "评论";
    stateEl = $("span"); stateEl.id = "nc-state";
    stateEl.title = "点击重试同步";
    stateEl.addEventListener("click", function () {
      if (state === "unauthorized") openSetup();
      else { flush(); toast("正在同步…"); }
    });

    var expBtn = $("button", null, "⤓");
    expBtn.title = "导出全部评论到剪贴板";
    expBtn.addEventListener("click", exportAll);

    var setBtn = $("button", null, "⚙");
    setBtn.title = "凭证与设备设置";
    setBtn.addEventListener("click", openSetup);

    var closeBtn = $("button", null, "✕");
    closeBtn.title = "收起侧栏";
    closeBtn.addEventListener("click", function () { setOpen(false); });

    head.appendChild(titleEl);
    head.appendChild(stateEl);
    head.appendChild(expBtn);
    head.appendChild(setBtn);
    head.appendChild(closeBtn);

    var filter = $("div"); filter.id = "nc-filter";
    var lab = $("label");
    var cb = $("input"); cb.type = "checkbox";
    cb.addEventListener("change", function () { onlyOpen = cb.checked; render(); });
    lab.appendChild(cb);
    lab.appendChild($("span", null, "只看未解决"));
    filter.appendChild(lab);

    listEl = $("div"); listEl.id = "nc-list";
    emptyEl = $("div"); emptyEl.id = "nc-empty";
    emptyEl.textContent = "还没有评论。选中正文里的任意文字，点浮出的「💬 评论」即可写下疑问。";

    panel.appendChild(head);
    panel.appendChild(filter);
    panel.appendChild(listEl);
    document.body.appendChild(panel);

    /* -------- 浮动按钮 / 把手 / toast -------- */
    btn = $("button"); btn.id = "nc-btn"; btn.type = "button";
    btn.textContent = "💬 评论";
    btn.addEventListener("mousedown", function (e) { e.preventDefault(); });  // 别清掉选区
    btn.addEventListener("click", startDraft);
    document.body.appendChild(btn);

    handle = $("button"); handle.id = "nc-handle"; handle.type = "button";
    handle.textContent = "评论";
    handle.addEventListener("click", function () { setOpen(true); });
    document.body.appendChild(handle);

    toastEl = $("div"); toastEl.id = "nc-toast";
    document.body.appendChild(toastEl);

    /* -------- 选区监听 -------- */
    document.addEventListener("mouseup", function () { setTimeout(positionBtn, 0); });
    document.addEventListener("touchend", function () { setTimeout(positionBtn, 10); });
    document.addEventListener("selectionchange", function () {
      var s = window.getSelection();
      if (!s || s.isCollapsed) btn.style.display = "none";
    });
    window.addEventListener("scroll", function () {
      if (btn.style.display !== "none") positionBtn();
    }, true);

    /* -------- 点高亮 → 定位卡片 -------- */
    document.addEventListener("click", function (e) {
      var t = e.target;
      var hl = t.closest ? t.closest("mark.nc-hl,.nc-hl-box") : null;
      if (!hl || !hl.dataset.cid) return;
      setOpen(true);
      focusCard(hl.dataset.cid, true);
    });

    /* -------- 自动补推时机 -------- */
    window.addEventListener("online", flush);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) flush();
    });
  }

  function setOpen(on) {
    document.documentElement.classList.toggle("nc-open", !!on);
    if (window.innerWidth <= 1100) {
      if (on && !backdrop) {
        backdrop = $("div"); backdrop.id = "nc-backdrop";
        backdrop.addEventListener("click", function () { setOpen(false); });
        document.body.appendChild(backdrop);
      } else if (!on && backdrop) {
        backdrop.parentNode.removeChild(backdrop);
        backdrop = null;
      }
    } else if (backdrop) {
      backdrop.parentNode.removeChild(backdrop);
      backdrop = null;
    }
  }

  function positionBtn() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) { btn.style.display = "none"; return; }
    var r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r || (!r.width && !r.height)) { btn.style.display = "none"; return; }
    btn.style.top = Math.max(8, r.top - 42) + "px";
    btn.style.left = Math.max(8, Math.min(window.innerWidth - 120, r.right - 20)) + "px";
    btn.style.display = "inline-flex";
  }

  function toast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.style.background = kind === "warn" ? "#d97706" : (kind === "err" ? "#cf222e" : "#22a06b");
    toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove("show"); }, 2200);
  }

  /* -------- 新建评论草稿 -------- */
  function startDraft() {
    var a = anchorFromSelection(window.getSelection());
    if (!a) { toast("没选中正文内容", "warn"); return; }
    if (!texReady && a.quote.indexOf("[公式]") >= 0) {
      toast("公式源码未取回，请在评论里补充说明", "warn");
    }
    btn.style.display = "none";
    draft = a;
    setOpen(true);
    render();
    var ta = listEl.querySelector(".nc-edit textarea");
    if (ta) { ta.focus(); scrollTo(ta, { block: "nearest" }); }
  }

  /* -------- 渲染 -------- */
  function render() {
    if (!listEl) return;
    listEl.textContent = "";

    var all = local && local.doc ? local.doc.comments : [];
    var openN = all.filter(function (c) { return c.status !== "resolved"; }).length;
    titleEl.textContent = "评论 " + all.length + (openN ? "（未解决 " + openN + "）" : "");

    if (draft) listEl.appendChild(draftCard());

    var shown = onlyOpen ? all.filter(function (c) { return c.status !== "resolved"; }) : all;
    if (!shown.length && !draft) { listEl.appendChild(emptyEl); }

    clearHighlights();
    var mathNodes = [];
    shown.forEach(function (c) {
      var ok = highlight(c.id, c.anchor);
      var card = commentCard(c, ok);
      listEl.appendChild(card);
      if (c.reply) mathNodes.push(card);
    });

    renderState();

    // 答复里可能有公式，动态插入后必须重排（note-conventions 5.2）
    if (mathNodes.length && window.MathJax && MathJax.typesetPromise) {
      MathJax.typesetPromise(mathNodes).catch(function () { });
    }
  }

  function renderState() {
    if (!stateEl) return;
    var n = local && local.dirty ? "•" : "";
    var map = {
      synced: ["🟢", "已同步"],
      pending: ["⏳", "待同步" + n],
      offline: ["📴", "离线，评论已本地保存"],
      unauthorized: ["🔒", "凭证无效，点击重新录入"]
    };
    var m = map[state] || map.synced;
    stateEl.textContent = m[0];
    stateEl.title = m[1] + "（点击重试同步）";
  }

  function draftCard() {
    var card = $("div", "nc-card nc-edit active");
    if (draft.quote) card.appendChild($("div", "nc-quote", draft.quote));
    var ta = $("textarea");
    ta.placeholder = "写下你的疑问…（⌘/Ctrl+Enter 提交，Esc 取消）";
    card.appendChild(ta);

    var bar = $("div", "nc-edit-bar");
    var save = $("button", "nc-primary", "评论");
    var cancel = $("button", "nc-ghost", "取消");
    bar.appendChild($("span", "hint", draft.headingText ? "§" + draft.headingText : ""));
    bar.appendChild(cancel);
    bar.appendChild(save);
    card.appendChild(bar);

    function submit() {
      var v = ta.value.trim();
      if (!v) { toast("评论内容是空的", "warn"); return; }
      var a = draft; draft = null;
      var c = addComment(a, v);
      activeId = c.id;
      toast("已评论 ✓");
    }
    function abort() { draft = null; render(); }

    save.addEventListener("click", submit);
    cancel.addEventListener("click", abort);
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
      if (e.key === "Escape") { e.preventDefault(); abort(); }
    });
    return card;
  }

  function commentCard(c, anchored) {
    var cls = "nc-card " + (c.status === "resolved" ? "resolved" : "open");
    if (!anchored) cls += " stale";
    if (c.id === activeId) cls += " active";
    var card = $("div", cls);
    card.dataset.card = c.id;

    if (c.anchor && c.anchor.quote) card.appendChild($("div", "nc-quote", c.anchor.quote));
    card.appendChild($("div", "nc-body", c.body));

    if (c.reply) {
      var box = $("div", "nc-reply");
      box.appendChild($("div", "nc-reply-h", "答复"));
      box.appendChild($("div", null, c.reply));
      card.appendChild(box);
    }

    var meta = $("div", "nc-meta");
    if (!anchored) {
      meta.appendChild($("span", "nc-badge b-stale", "⚠ 锚点失效"));
    } else {
      meta.appendChild($("span", "nc-badge " + (c.status === "resolved" ? "b-res" : "b-open"),
        c.status === "resolved" ? "已解决" : "未解决"));
    }
    meta.appendChild($("span", "sp"));

    var res = $("button", null, c.status === "resolved" ? "重开" : "标已解决");
    res.addEventListener("click", function (e) { e.stopPropagation(); toggleResolved(c.id); });
    var ed = $("button", null, "改");
    ed.addEventListener("click", function (e) { e.stopPropagation(); inlineEdit(card, c); });
    var del = $("button", null, "删");
    del.addEventListener("click", function (e) {
      e.stopPropagation();
      if (confirm("删除这条评论？")) { removeComment(c.id); toast("已删除"); }
    });
    meta.appendChild(res); meta.appendChild(ed); meta.appendChild(del);
    card.appendChild(meta);

    card.addEventListener("click", function () { focusCard(c.id, false); });
    return card;
  }

  function inlineEdit(card, c) {
    card.textContent = "";
    card.classList.add("nc-edit");
    if (c.anchor && c.anchor.quote) card.appendChild($("div", "nc-quote", c.anchor.quote));
    var ta = $("textarea");
    ta.value = c.body;
    card.appendChild(ta);
    var bar = $("div", "nc-edit-bar");
    var save = $("button", "nc-primary", "保存");
    var cancel = $("button", "nc-ghost", "取消");
    bar.appendChild($("span", "hint"));
    bar.appendChild(cancel); bar.appendChild(save);
    card.appendChild(bar);
    ta.focus();

    save.addEventListener("click", function (e) {
      e.stopPropagation();
      var v = ta.value.trim();
      if (!v) { toast("评论内容是空的", "warn"); return; }
      editComment(c.id, v);
    });
    cancel.addEventListener("click", function (e) { e.stopPropagation(); render(); });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); }
      if (e.key === "Escape") { e.preventDefault(); render(); }
    });
  }

  /* -------- 双向定位 -------- */
  function focusCard(cid, fromText) {
    activeId = cid;
    var cards = listEl.querySelectorAll(".nc-card");
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle("active", cards[i].dataset.card === cid);
    }
    var marks = document.querySelectorAll("mark.nc-hl,.nc-hl-box");
    for (var j = 0; j < marks.length; j++) {
      marks[j].classList.toggle("active", marks[j].dataset.cid === cid);
    }

    if (fromText) {
      var card = listEl.querySelector('[data-card="' + cid + '"]');
      if (card) scrollTo(card, { block: "nearest", behavior: "smooth" });
      return;
    }
    var hit = nodesFor(cid)[0];
    if (hit) { scrollTo(hit, { block: "center", behavior: "smooth" }); return; }
    // 锚点失效 → 降级到章节定位
    var c = findComment(cid);
    if (c && c.anchor && c.anchor.headingId) {
      var h = document.getElementById(c.anchor.headingId);
      if (h) { scrollTo(h, { block: "start", behavior: "smooth" }); toast("锚点已失效，定位到所在小节", "warn"); }
    }
  }

  /* -------- 导出（API 长期不通时的兜底通道） -------- */
  function exportAll() {
    var out = { exportedAt: nowISO(), notes: {} };
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf(K_NOTE) !== 0) continue;
        var o = JSON.parse(localStorage.getItem(k));
        if (o && o.doc) out.notes[k.slice(K_NOTE.length)] = o.doc;
      }
    } catch (e) { /* 单条坏数据不影响其余 */ }
    var text = JSON.stringify(out, null, 2);
    copy(text).then(function () {
      toast("已复制全部评论 ✓ 可直接粘给 AI");
    }).catch(function () {
      toast("复制失败，请手动复制控制台输出", "warn");
      console.log(text);
    });
  }

  function copy(str) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(str);
    }
    return new Promise(function (res, rej) {
      var ta = $("textarea");
      ta.value = str;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? res() : rej(new Error("copy failed"));
    });
  }

  /* =================================================================
   * 7. 凭证录入弹窗
   * -----------------------------------------------------------------
   * token 只存本设备 localStorage，绝不写进任何仓库。校验方式是拿它读一次
   * 评论仓，200 才存——避免存错后处处报错。
   * ================================================================= */

  function openSetup() {
    if (document.getElementById("nc-modal")) return;

    // 静默模式下样式还没注入，这里补一次（只注一次）
    if (!document.getElementById("nc-style")) {
      var st = $("style"); st.id = "nc-style"; st.textContent = CSS;
      document.head.appendChild(st);
    }

    var wrap = $("div"); wrap.id = "nc-modal";
    var box = $("div", "box");
    box.appendChild($("h3", null, "笔记评论 · 凭证设置"));
    box.appendChild($("p", null,
      "填 GitHub fine-grained PAT（仅 " + REPO + " 的 Contents 读写权限）。" +
      "只存在本设备浏览器，不会写进任何仓库。每台设备各录一次。"));

    box.appendChild($("label", null, "Token"));
    var tin = $("input"); tin.type = "password"; tin.placeholder = "github_pat_…";
    tin.value = getToken();
    box.appendChild(tin);

    box.appendChild($("label", null, "设备名（可选，用于分辨评论来源）"));
    var din = $("input"); din.type = "text"; din.placeholder = "如 mac-home / iphone";
    din.value = getDevice() === "unknown" ? "" : getDevice();
    box.appendChild(din);

    var err = $("div", "err");
    box.appendChild(err);

    var row = $("div", "row");
    var clear = $("button", "nc-ghost", "清除本设备凭证");
    var sp = $("span", "sp");
    var cancel = $("button", "nc-ghost", "取消");
    var save = $("button", "nc-primary", "保存");
    row.appendChild(clear); row.appendChild(sp);
    row.appendChild(cancel); row.appendChild(save);
    box.appendChild(row);

    wrap.appendChild(box);
    document.body.appendChild(wrap);
    tin.focus();

    function close() {
      wrap.parentNode.removeChild(wrap);
      if (location.hash === "#nc-setup") {
        // 清掉 hash，免得录入页被书签/分享出去
        history.replaceState(null, "", location.pathname + location.search);
      }
    }

    clear.addEventListener("click", function () {
      try { localStorage.removeItem(K_TOKEN); } catch (e) { }
      close();
      location.reload();
    });
    cancel.addEventListener("click", close);
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });

    save.addEventListener("click", function () {
      var t = tin.value.trim();
      if (!t) { err.textContent = "token 不能为空"; return; }
      err.textContent = "校验中…";
      save.disabled = true;

      fetch(API, {
        headers: {
          "Authorization": "Bearer " + t,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      }).then(function (r) {
        save.disabled = false;
        if (r.status === 200) {
          try {
            localStorage.setItem(K_TOKEN, t);
            localStorage.setItem(K_DEVICE, din.value.trim() || "unknown");
          } catch (e) {
            err.textContent = "本地存储不可用（隐私模式？）";
            return;
          }
          close();
          location.reload();       // 重新走一遍启动，进入正常模式
          return;
        }
        if (r.status === 401) err.textContent = "token 无效或已过期";
        else if (r.status === 403) err.textContent = "token 权限不足（需要 Contents 读写）";
        else if (r.status === 404) err.textContent = "看不到 " + REPO + "，检查仓库名与 token 的仓库范围";
        else err.textContent = "校验失败：HTTP " + r.status;
      }).catch(function () {
        save.disabled = false;
        err.textContent = "网络不可达，稍后再试";
      });
    });
  }

  /* =================================================================
   * 8. 启动
   * ================================================================= */

  function boot() {
    prescanTex();          // 若排版尚未发生，先把 $...$ 源码抢下来备用

    function start() {
      buildUI();
      installSetupTrigger();   // 已有 token 时也允许改凭证
      recoverTex();
      loadAll();
    }

    function whenTypeset(cb) {
      if (window.MathJax && MathJax.startup && MathJax.startup.promise) {
        MathJax.startup.promise.then(cb).catch(cb);
      } else if (document.readyState === "complete") {
        cb();
      } else {
        window.addEventListener("load", cb);
      }
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { whenTypeset(start); });
    } else {
      whenTypeset(start);
    }
  }
})();
