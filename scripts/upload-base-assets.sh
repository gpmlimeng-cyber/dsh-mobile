#!/usr/bin/env sh
# upload-base-assets.sh — 把快照底座归档上传到 GitHub Release，供 build-apk CI 下载。
#
# 背景（issue #2）：base/ 下三个底座文件在仓库里是 Git LFS 指针，但 LFS 对象在服务器上不存在
# （`Object does not exist on the server: [404]`），导致任何 lfs: true 的检出在 checkout 阶段即失败。
# 现改为从 Release 取真身：本脚本负责上传，workflow 负责下载。
#
# 用法（在**持有底座归档的机器**上运行；需要 gh CLI 且已登录、对该仓库有写权限）：
#   sh scripts/upload-base-assets.sh <底座目录> [tag]
#
#   <底座目录> 需含三个文件：
#       base-usr-arm64.tar.xz   base-usr-x86_64.tar.xz   base-dsh.tar.xz
#   [tag]      默认 base-assets（与 build-apk.yml 的 base_release 输入默认值一致）
#
# 若本机只有一个 ABI 的底座，可先只上传它：workflow 的下载步骤按文件逐个取，
# 缺哪个就报哪个（不会因为只缺 x86_64 就把 arm64 的构建也拖死——两 ABI 是独立 job）。
set -eu

DIR="${1:?用法: sh scripts/upload-base-assets.sh <底座目录> [tag]}"
TAG="${2:-base-assets}"
REPO="${DSH_REPO:-gpmlimeng-cyber/dsh-mobile}"

FILES="base-usr-arm64.tar.xz base-usr-x86_64.tar.xz base-dsh.tar.xz"

# 1. 前置检查：三个文件在场，且不是 LFS 指针（指针只有 ~133 字节）
for f in $FILES; do
  [ -f "$DIR/$f" ] || { echo "缺文件: $DIR/$f" >&2; exit 1; }
  sz=$(wc -c < "$DIR/$f")
  if [ "$sz" -lt 1000000 ]; then
    echo "拒绝上传 $f：只有 $sz 字节，看起来是 Git LFS 指针而不是真身。" >&2
    echo "  先在持有底座的机器上跑： git lfs pull        （或 git lfs fetch --all）" >&2
    exit 1
  fi
  printf '%s: %s bytes\n' "$f" "$sz"
done

# 2. 确保 Release 存在（不存在则建一个；已存在则复用）
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Release '$TAG' 已存在，复用"
else
  echo "创建 Release '$TAG'"
  gh release create "$TAG" --repo "$REPO" \
    --title "$TAG" \
    --notes "dsh-mobile 快照底座归档（替代已失效的 Git LFS，见 issue #2）。由 scripts/upload-base-assets.sh 上传。"
fi

# 3. 上传（--clobber 允许覆盖重传）
echo "上传到 $REPO@$TAG …"
# shellcheck disable=SC2086
gh release upload "$TAG" --repo "$REPO" --clobber \
  "$DIR/base-usr-arm64.tar.xz" "$DIR/base-usr-x86_64.tar.xz" "$DIR/base-dsh.tar.xz"

# 4. 回读确认
echo "== 当前 Release 资产 =="
gh release view "$TAG" --repo "$REPO" --json assets \
  --jq '.assets[] | "\(.name)\t\(.size) bytes"'

echo
echo "完成。现在可以触发 build-apk："
echo "  gh workflow run build-apk.yml --repo $REPO -f base_release=$TAG"
