#!/bin/sh
# 整理：只用本地数据重建文档 → 原子发布 → 打包 → 校验
# 全程不联网；失败时保留上一版，不会把目标目录清空
set -eu
NC_ROOT="${NC_ROOT:-$(pwd)}"
NC_DEST="${NC_DEST:-$NC_ROOT/导出}"
export NC_ROOT NC_DEST
cd "$NC_ROOT"

TMP="${NC_DEST}.new"
ZIP="${NC_DEST}.zip"
ZIP_TMP="${TMP}.zip"

echo "== 1/4 生成文档（本地数据）"
node merge.mjs

echo "== 2/4 写入临时目录"
rm -rf "$TMP" "$ZIP_TMP"
mkdir -p "$TMP"
for d in 00_自建歌单索引.md 01_数据处理说明.md 02_歌单可见性清单.md 03_整理报告.md 歌单 专项 收藏 排行与收藏 表格; do
  if [ -e "out2/$d" ]; then cp -r "out2/$d" "$TMP"/; else echo "  缺少 out2/$d"; fi
done

echo "== 3/4 打包"
NC_SRC="$TMP" NC_OUT="$ZIP_TMP" python3 - <<'PY'
import zipfile, os
src = os.environ['NC_SRC']; dst = os.environ['NC_OUT']
n = 0
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(src):
        dirs.sort(); files.sort()
        for f in files:
            p = os.path.join(root, f)
            z.write(p, os.path.join(os.path.basename(src), os.path.relpath(p, src)))
            n += 1
print('   zip 条目', n, '| %.2f MB' % (os.path.getsize(dst) / 1048576))
PY

echo "== 4/4 校验并发布"
if ! node check.mjs; then
  echo "!! 校验未通过，保留上一版，临时目录留在 $TMP"
  exit 1
fi

# 发布目录一致性：临时目录文件数应等于 out2 中的发布项
EXPECT=$(find "$TMP" -type f | wc -l)
if [ "$EXPECT" -lt 200 ]; then
  echo "!! 文件数异常（$EXPECT），放弃发布"
  exit 1
fi

rm -rf "${NC_DEST}.bak"
[ -d "$NC_DEST" ] && mv "$NC_DEST" "${NC_DEST}.bak"
mv "$TMP" "$NC_DEST"
[ -f "$ZIP" ] && mv "$ZIP" "${ZIP}.bak"
mv "$ZIP_TMP" "$ZIP"
rm -rf "${NC_DEST}.bak" "${ZIP}.bak"

echo "BUILD_OK｜$EXPECT 个文件已发布到 $NC_DEST"
