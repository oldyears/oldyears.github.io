/* ===================================================================
 * assist.js — 学习笔记「选中即问」辅助脚本（5 篇 HTML 共用）
 * -------------------------------------------------------------------
 * 作用：在 note 页面选中任意文字后，右上角浮出「问一下」按钮；
 *       点击后把「文件路径 + 最近标题 + 选中原文」拼好复制到剪贴板，
 *       随即粘给 Claude Code 提问。纯前端、无网络、无 API key。
 *
 * 复制格式（给 Claude grep 定位用）：
 *   [note: hw0/backprop-derivation.html] §4.1 形状对齐（……）
 *
 *   <选中的原文>
 *
 * 引用方式：各 HTML 在 </body> 前加一行
 *   <script src="../assist.js"></script>
 * =================================================================== */
(function () {
  "use strict";

  // ---- 自注入样式（自包含，不依赖页面已有 class）----
  var css = [
    ".assist-btn{position:fixed;z-index:99999;display:none;align-items:center;gap:5px;",
    "background:#4a90d9;color:#fff;border:none;border-radius:6px;padding:6px 12px;",
    "font-size:13px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;",
    "cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.18);transition:background .15s;}",
    ".assist-btn:hover{background:#3b7bc0;}",
    ".assist-toast{position:fixed;z-index:99999;top:18px;right:18px;background:#22a06b;",
    "color:#fff;padding:9px 16px;border-radius:6px;font-size:13px;",
    "font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;",
    "box-shadow:0 3px 12px rgba(0,0,0,.2);opacity:0;transform:translateY(-8px);",
    "transition:opacity .2s,transform .2s;pointer-events:none;}",
    ".assist-toast.show{opacity:1;transform:translateY(0);}"
  ].join("");
  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ---- 浮动按钮 ----
  var btn = document.createElement("button");
  btn.className = "assist-btn";
  btn.type = "button";
  btn.innerHTML = "💬 问一下";
  document.body.appendChild(btn);

  // ---- toast ----
  var toast = document.createElement("div");
  toast.className = "assist-toast";
  document.body.appendChild(toast);
  var toastTimer = null;
  function showToast(msg, ok) {
    toast.textContent = msg;
    toast.style.background = ok === false ? "#d97706" : "#22a06b";
    toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove("show"); }, 1800);
  }

  // ---- 文件路径：取 homework/ 之后的相对路径，取不到就用文件名 ----
  function notePath() {
    var p = decodeURIComponent(location.pathname);
    var i = p.indexOf("/homework/");
    if (i >= 0) return p.slice(i + "/homework/".length);
    var parts = p.split("/");
    return parts[parts.length - 1] || p;
  }

  // ---- 最近标题：DOM 顺序上位于选区起点之前的最后一个 h1/h2/h3 ----
  function nearestHeading(range) {
    var heads = document.querySelectorAll("h1,h2,h3");
    var best = null;
    for (var k = 0; k < heads.length; k++) {
      var h = heads[k];
      // 标题在选区起点之前（或包含选区起点）→ 候选，取最后一个即最近的
      var pos = range.compareBoundaryPoints(Range.START_TO_START,
        (function () { var r = document.createRange(); r.selectNode(h); return r; })());
      // pos > 0 表示选区起点在该标题之后
      if (pos >= 0) best = h;
    }
    return best;
  }

  function headingText(h) {
    if (!h) return "";
    var t = (h.textContent || "").replace(/\s+/g, " ").trim();
    return "§" + t;
  }

  // ---- 组装复制文本 ----
  function buildPayload(sel) {
    var text = sel.toString().trim();
    if (!text) return null;
    var range = sel.getRangeAt(0);
    var head = headingText(nearestHeading(range));
    var header = "[note: " + notePath() + "]" + (head ? " " + head : "");
    return header + "\n\n" + text;
  }

  // ---- 复制（优先 clipboard API，fallback execCommand）----
  function copyText(str) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(str);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = str;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error("execCommand copy failed"));
    });
  }

  // ---- 选区变化 → 定位按钮 ----
  function positionBtn() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      btn.style.display = "none";
      return;
    }
    var rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      btn.style.display = "none";
      return;
    }
    // 放在选区右上角，避免超出视口
    var top = Math.max(8, rect.top - 40);
    var left = Math.min(window.innerWidth - 110, rect.right - 20);
    btn.style.top = top + "px";
    btn.style.left = Math.max(8, left) + "px";
    btn.style.display = "inline-flex";
  }

  document.addEventListener("mouseup", function () {
    // 延迟一拍，等浏览器更新 selection
    setTimeout(positionBtn, 0);
  });
  document.addEventListener("selectionchange", function () {
    if (window.getSelection().isCollapsed) btn.style.display = "none";
  });
  window.addEventListener("scroll", function () {
    if (btn.style.display !== "none") positionBtn();
  }, true);

  // ---- 点击按钮 → 复制 ----
  btn.addEventListener("mousedown", function (e) {
    // 阻止 mousedown 清掉选区
    e.preventDefault();
  });
  btn.addEventListener("click", function () {
    var sel = window.getSelection();
    var payload = buildPayload(sel);
    if (!payload) { showToast("没选中内容", false); return; }
    copyText(payload).then(function () {
      showToast("已复制 ✓ 直接粘给 Claude");
      btn.style.display = "none";
    }).catch(function () {
      showToast("复制失败，请手动复制", false);
    });
  });
})();
