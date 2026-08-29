#!/usr/bin/env bash
# 从源仓库(codeFiles/LifelongLearning)同步学习笔记 html 到 public/notes/
#
# 全自动：扫描 cmu-dlsys/homework/**/*derivation.html，读每篇 <body> 后的
#   <!-- @note title="..." course="..." desc="..." tags="a,b,c" -->
# 注释，自动：① 拷贝 html 到 public/notes/ 并修正跨目录链接
#            ② 生成 notes-manifest.json（供站点 notes/index.astro 渲染卡片）
# 加新笔记：只需在新 html 里写好 @note 注释，无需手改任何配置。
#
# 用法：
#   NOTES_SRC=/path/to/LifelongLearning ./sync-notes.sh   # CI：指定源仓库根
#   ./sync-notes.sh                                        # 本地默认路径
set -euo pipefail

SITE_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="${NOTES_SRC:-/data00/home/huyongle/codeFiles}"
DEST="$SITE_DIR/public/notes"
MANIFEST="$SITE_DIR/notes-manifest.json"
SCAN_DIR="cmu-dlsys/homework"   # 相对 SRC，扫描此目录下的 *derivation.html

mkdir -p "$DEST"
echo "源仓库: $SRC"
echo "扫描:   $SRC/$SCAN_DIR/**/*derivation.html"
echo "目标:   $DEST"

python3 - "$SRC" "$DEST" "$MANIFEST" "$SCAN_DIR" <<'PY'
import json, os, re, sys, glob

src_root, dest, manifest, scan_dir = sys.argv[1:5]

# 1. 扫描所有笔记 html
pattern = os.path.join(src_root, scan_dir, "**", "*derivation.html")
paths = sorted(glob.glob(pattern, recursive=True))
if not paths:
    print(f"  ✗ 未扫到任何笔记: {pattern}"); sys.exit(1)

note_re = re.compile(
    r'<!--\s*@note\s+(.*?)-->', re.S)
attr_re = re.compile(r'(\w+)="([^"]*)"')

records = []
for sp in paths:
    rel = os.path.relpath(sp, src_root)
    fname = os.path.basename(sp)
    html = open(sp, encoding='utf-8').read()
    m = note_re.search(html)
    if not m:
        print(f"  ✗ {rel} 缺少 <!-- @note ... --> 元信息注释，跳过"); sys.exit(1)
    attrs = dict(attr_re.findall(m.group(1)))
    tags = [t.strip() for t in attrs.get('tags', '').split(',') if t.strip()]
    records.append({
        "file": fname,
        "source": rel,
        "title": attrs.get('title', fname),
        "course": attrs.get('course', ''),
        "desc": attrs.get('desc', ''),
        "tags": tags,
    })

# 已知的笔记文件名集合，用于修正跨目录链接
files = {r["file"] for r in records}

# 按 course 里的 Lecture 号排序（Lec2→Lec3→Lec4），抽不到则排最后
def lec_key(r):
    m = re.search(r'Lecture\s*(\d+)', r["course"])
    return (int(m.group(1)) if m else 999, r["file"])
records.sort(key=lec_key)

# 2. 拷贝 + 修链接
for r in records:
    sp = os.path.join(src_root, r["source"])
    html = open(sp, encoding='utf-8').read()
    for f in files:
        html = re.sub(r'href="\.\./[^"/]+/' + re.escape(f), 'href="' + f, html)
    open(os.path.join(dest, r["file"]), 'w', encoding='utf-8').write(html)
    print(f"  ✓ {r['source']} → notes/{r['file']}  [{r['title']}]")

# 2b. 拷贝共用辅助脚本
#     assist.js        — 旧「选中即问」，笔记已不再引用，保留兼容
#     notes-comment.js — 「选中评论」侧栏；无 token 时完全静默，公开访客无感知
import shutil
for helper in ("assist.js", "notes-comment.js"):
    hp = os.path.join(src_root, "cmu-dlsys", "homework", helper)
    if os.path.exists(hp):
        shutil.copy2(hp, os.path.join(dest, helper))
        print(f"  ✓ cmu-dlsys/homework/{helper} → notes/{helper}")
    else:
        print(f"  ⚠ {helper} 未找到 {hp}，跳过")

# 3. 生成 manifest（去掉 source 字段，站点只需展示用信息；保留 file/title/course/desc/tags）
out = [{k: v for k, v in r.items() if k != "source"} for r in records]
with open(manifest, 'w', encoding='utf-8') as fh:
    json.dump(out, fh, ensure_ascii=False, indent=2)
    fh.write('\n')
print(f"生成 manifest：{len(records)} 篇笔记")
PY
