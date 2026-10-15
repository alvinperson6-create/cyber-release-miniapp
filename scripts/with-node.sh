#!/usr/bin/env bash
# 赛博放生 · Node 引导器
#
# 解决的问题：better-sqlite3 是原生模块，编译时的 Node ABI 必须与运行时的
# Node 一致。本仓库的模块按某个 Node 版本编译，若 npm 用它自带的另一版本
# 启动，会抛 ERR_DLOPEN_FAILED——而且错误信息指向模块内部，看不出是版本问题。
#
# 这个脚本挑一个**能加载 better-sqlite3**的 Node 来执行后续命令。
# 挑选顺序：
#   1. 当前已经是可用的 Node → 直接用（多数情况）
#   2. 否则在常见安装位置里找一个 ABI 匹配的
#   3. 都找不到 → 给出可执行的修复命令（而不是 cryptic 的加载错误）
#
# 用法：
#   scripts/with-node.sh npm start
#   scripts/with-node.sh npm run check
#
# npm scripts 里已经接了它，所以正常情况下直接 npm start 即可，
# 这个脚本是给"想手动指定"和排查用的。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 判断某个 node 能否**真正使用**本仓库的原生模块。
# 注意：必须实际 new 一个数据库并执行一条语句——better-sqlite3 的
# .node 是惰性加载的，只 require 不报错，不代表能用。
node_works() {
  local bin="$1"
  [ -x "$bin" ] || return 1
  "$bin" -e '
    const D = require("better-sqlite3");
    const db = new D(":memory:");
    db.exec("CREATE TABLE t(x)");
    db.prepare("INSERT INTO t VALUES(?)").run(1);
    db.close();
  ' >/dev/null 2>&1
}

pick_node() {
  # 1. 当前的 node
  if command -v node >/dev/null 2>&1 && node_works "$(command -v node)"; then
    command -v node; return 0
  fi

  # 2. 常见安装位置（版本从新到旧，覆盖 brew / nvm / fnm / volta / 官方安装包）
  local candidates=(
    /opt/homebrew/bin/node
    /usr/local/bin/node
    /opt/homebrew/opt/node/bin/node
    "$HOME/.volta/bin/node"
    "$HOME/.nvm/current/bin/node"
  )
  # nvm / fnm 的带版本目录
  for base in "$HOME/.nvm/versions/node"/*/bin "$HOME/.local/share/fnm/node-versions"/*/installation/bin; do
    [ -x "$base/node" ] && candidates+=("$base/node")
  done

  for bin in "${candidates[@]}"; do
    if node_works "$bin"; then
      echo "$bin"; return 0
    fi
  done
  return 1
}

NODE_BIN="$(pick_node || true)"

if [ -z "$NODE_BIN" ]; then
  cat >&2 <<'MSG'
找不到能加载 better-sqlite3 的 Node。

原因：better-sqlite3 是原生模块，编译时的 Node ABI（NODE_MODULE_VERSION）
必须与运行时的 Node 一致。当前 node 与该模块不匹配。

修复（二选一）：
  1. 用能跑的 Node 重新编译模块：
       npm rebuild better-sqlite3
     注意：这样编译出的模块只适配当前这个 Node 版本。
  2. 换一个已装好的 Node 来运行（better-sqlite3 12.x 支持 Node 20–26）：
       node -v                      # 确认版本
       node scripts/with-node.sh npm start
MSG
  echo "" >&2
  echo "当前 node：$(command -v node || echo '(未找到)') $(node -v 2>/dev/null || '')" >&2
  exit 1
fi

# 需要切换时说明一下；不切换就静默，避免每次都刷屏
CURRENT="$(command -v node || true)"
if [ -n "$CURRENT" ] && [ "$(cd "$(dirname "$CURRENT")" && pwd)/$(basename "$CURRENT")" != "$NODE_BIN" ]; then
  echo "[with-node] 当前 node 与原生模块不匹配，改用 $NODE_BIN ($("$NODE_BIN" -v))" >&2
fi

if [ "$#" -eq 0 ]; then
  exec "$NODE_BIN" -e 'console.log(process.version, process.execPath)'
fi

exec "$NODE_BIN" "$@"
