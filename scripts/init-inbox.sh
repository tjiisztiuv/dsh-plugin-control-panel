#!/usr/bin/env bash
#
# 建好控制面板的消息目录。
#
#   scripts/init-inbox.sh                  建 ~/.dsh-control-panel（设了 DSH_CONTROL_PANEL_DIR 就建它）
#   scripts/init-inbox.sh <目录>            建在指定目录
#   scripts/init-inbox.sh --test [<目录>]   建好后投一条测试消息
#
# 可以重复运行：已有的目录、权限和消息都不会被改动。
set -euo pipefail

send_test=0
dir=""
for arg in "$@"; do
  case "$arg" in
    --test) send_test=1 ;;
    -h | --help)
      sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "未知选项：$arg（用 --help 看用法）" >&2
      exit 2
      ;;
    *)
      if [ -n "$dir" ]; then
        echo "只能给一个目录" >&2
        exit 2
      fi
      dir="$arg"
      ;;
  esac
done

default_dir="$HOME/.dsh-control-panel"
dir="${dir:-${DSH_CONTROL_PANEL_DIR:-$default_dir}}"
case "$dir" in
  "~") dir="$HOME" ;;
  "~/"*) dir="$HOME/${dir#\~/}" ;;
esac

# 消息里可能有命令输出，新建的目录只给自己读写。-m 只作用于这次新建的目录。
mkdir -p -m 700 "$dir"
dir="$(cd "$dir" && pwd)"
inbox="$dir/inbox.jsonl"
touch "$inbox"

if [ "$send_test" -eq 1 ]; then
  id="ms_$(date +%s)000_$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # 一次 printf 写出整行；标题和正文是固定文字，不需要 JSON 转义。
  printf '{"id":"%s","source":"init-inbox","title":"测试消息","body":"消息目录已经建好。看到这条，说明投递是通的。","ts":"%s","level":"success","ref":{}}\n' \
    "$id" "$ts" >> "$inbox"
  echo "已投递一条测试消息，开着的面板 30 秒内会显示。"
fi

echo "消息目录：$dir"
echo "消息文件：$inbox"

if [ "$dir" != "$default_dir" ]; then
  cat <<NOTE

这不是默认目录（$default_dir）。要让插件读它，二选一：

  1. 在 profile 的 cordis.patch.yml 里加：

       - id: dsh-plugin-control-panel
         config:
           inboxDir: $dir

  2. 启动 dsh 之前设置环境变量：

       export DSH_CONTROL_PANEL_DIR="$dir"
NOTE
fi
