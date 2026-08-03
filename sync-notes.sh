#!/usr/bin/env bash
# 从源仓库(codeFiles/LifelongLearning)同步学习笔记 html 到 public/notes/
# 读 notes-manifest.json：按 source 路径拷贝，自动修正 ../hwX/ 跨目录链接为同目录
#
# 用法：
#   NOTES_SRC=/path/to/LifelongLearning ./sync-notes.sh   # 指定源仓库根
#   ./sync-notes.sh                                        # 本地默认路径
set -euo pipefail

SITE_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="${NOTES_SRC:-/data00/home/huyongle/codeFiles}"
DEST="$SITE_DIR/public/notes"
MANIFEST="$SITE_DIR/notes-manifest.json"

mkdir -p "$DEST"
echo "源仓库: $SRC"
echo "目标:   $DEST"

# 用 python 读 manifest 并逐条拷贝 + 修链接
python3 - "$SRC" "$DEST" "$MANIFEST" <<'PY'
import json, os, re, sys
src_root, dest, manifest = sys.argv[1], sys.argv[2], sys.argv[3]
notes = json.load(open(manifest, encoding='utf-8'))
files = {n['file'] for n in notes}
count = 0
for n in notes:
    sp = os.path.join(src_root, n['source'])
    if not os.path.exists(sp):
        print(f"  ✗ 缺源文件: {sp}"); sys.exit(1)
    html = open(sp, encoding='utf-8').read()
    # 修正跨目录链接：把指向其它笔记的 ../hwX/xxx.html 改成同目录 xxx.html
    for f in files:
        html = re.sub(r'href="\.\./[^"/]+/' + re.escape(f), 'href="' + f, html)
    open(os.path.join(dest, n['file']), 'w', encoding='utf-8').write(html)
    print(f"  ✓ {n['source']} → notes/{n['file']}")
    count += 1
print(f"同步 {count} 篇笔记完成")
PY
