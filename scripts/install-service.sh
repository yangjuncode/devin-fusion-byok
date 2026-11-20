#!/usr/bin/env bash
# install-service.sh — 在已装 Devin Desktop / Windsurf 插件的机器上补装常驻后端服务，
# 让终端里的 devin CLI 与桌面版共用同一条 BYOK 链路（127.0.0.1:39842）。
#
# 用法（无参数即 install）：
#   ./install-service.sh              # 装启动器 + systemd 用户服务 + 环境变量
#   ./install-service.sh status       # 查看服务与后端状态
#   ./install-service.sh uninstall    # 停用服务、移除环境变量与启动器
#
# 前提：已在 Devin Desktop / Windsurf 的扩展面板中安装 devin-fusion-byok 插件。
# 未检测到插件会直接报错退出——请先装插件。插件文件与配置（含 API 密钥）都由
# 桌面端/控制面板管理，本脚本与 uninstall 均不触碰。
#
# 做的事：
#   1. 在 ~/.devin/extensions（或 ~/.windsurf/extensions）下找到插件已装版本，
#      生成 ~/.local/bin/devin-fusion-byok 启动器（每次运行自动选最高版本）；
#   2. 装 systemd --user 服务 devin-fusion-byok.service 常驻；
#      无 systemd 时回退 setsid 后台进程；
#   3. 向 shell rc 文件写入 export WINDSURF_API_SERVER_URL=http://127.0.0.1:39842；
#   4. 存储根目录缺失时写最小 config.json（正常情况下桌面端已建好，直接沿用）。
#
# 与 Desktop 共存：同端口、同存储根 → rootId 一致；桌面端扩展激活时比对
# version/sourceId/networkId，一致则复用本服务，不一致（如插件升级）则经控制
# 令牌优雅接管。被接管或端口被占时后端退出码 0，Restart=on-failure 不抢端口。
set -euo pipefail

PORT=39842
API_URL="http://127.0.0.1:${PORT}"
SERVICE="devin-fusion-byok.service"
MARK_BEGIN='# >>> devin-fusion-byok >>>'
MARK_END='# <<< devin-fusion-byok <<<'
EXT_ID="local.devin-fusion-byok"
LAUNCHER="${HOME}/.local/bin/devin-fusion-byok"
UNIT="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/${SERVICE}"
NODE_BIN=""

die() { echo "错误：$*" >&2; exit 1; }
info() { echo "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# 在桌面端的用户扩展目录里找插件后端，取最高版本；找不到返回空。
find_backend() {
  local best="" candidate
  for candidate in "${HOME}/.devin/extensions/${EXT_ID}"-*/src/runtime/backend.cjs \
                   "${HOME}/.windsurf/extensions/${EXT_ID}"-*/src/runtime/backend.cjs; do
    [ -f "$candidate" ] || continue
    if [ -z "$best" ] || [ "$(printf '%s\n%s\n' "$best" "$candidate" | sort -V | tail -n 1)" = "$candidate" ]; then
      best="$candidate"
    fi
  done
  printf '%s\n' "$best"
}

resolve_node() {
  local bin="${DEVIN_FUSION_BYOK_NODE:-}"
  [ -n "$bin" ] || bin="$(command -v node 2>/dev/null || true)"
  [ -n "$bin" ] && [ -x "$bin" ] || die "未找到 node。请先安装 Node.js >=18，或用 DEVIN_FUSION_BYOK_NODE=/path/to/node 指定。"
  printf '%s\n' "$bin"
}

storage_root() {
  if [ -n "${DEVIN_FUSION_BYOK_ROOT:-}" ]; then printf '%s\n' "$DEVIN_FUSION_BYOK_ROOT"; return; fi
  local cfg="${XDG_CONFIG_HOME:-${HOME}/.config}"
  if [ -d "${cfg}/Devin/User/globalStorage/${EXT_ID}" ]; then
    printf '%s\n' "${cfg}/Devin/User/globalStorage/${EXT_ID}"
  elif [ -d "${cfg}/Windsurf/User/globalStorage/${EXT_ID}" ]; then
    printf '%s\n' "${cfg}/Windsurf/User/globalStorage/${EXT_ID}"
  else
    printf '%s\n' "${cfg}/Devin/User/globalStorage/${EXT_ID}"
  fi
}

# 启动器：每次运行重新解析最高版本后端与存储根目录，
# 插件升级后无需改任何东西。node 路径安装时写死（兼容 nvm）。
write_launcher() {
  mkdir -p "$(dirname "$LAUNCHER")"
  cat > "$LAUNCHER" <<EOF
#!/bin/sh
# devin-fusion-byok standalone launcher（由 install-service.sh 生成）
set -eu
NODE_BIN="${DEVIN_FUSION_BYOK_NODE:-${NODE_BIN}}"
[ -x "\$NODE_BIN" ] || NODE_BIN="\$(command -v node || true)"
[ -n "\$NODE_BIN" ] && [ -x "\$NODE_BIN" ] || { echo "devin-fusion-byok: 未找到 node" >&2; exit 1; }
BACKEND="\${DEVIN_FUSION_BYOK_BACKEND:-}"
if [ -z "\$BACKEND" ]; then
  for candidate in "\$HOME/.devin/extensions/${EXT_ID}"-*/src/runtime/backend.cjs \\
                    "\$HOME/.windsurf/extensions/${EXT_ID}"-*/src/runtime/backend.cjs; do
    [ -f "\$candidate" ] || continue
    if [ -z "\$BACKEND" ] || [ "\$(printf '%s\n%s\n' "\$BACKEND" "\$candidate" | sort -V | tail -n 1)" = "\$candidate" ]; then
      BACKEND="\$candidate"
    fi
  done
fi
[ -n "\$BACKEND" ] && [ -f "\$BACKEND" ] || { echo "devin-fusion-byok: 未找到已安装的插件后端" >&2; exit 1; }
if [ -n "\${DEVIN_FUSION_BYOK_ROOT:-}" ]; then
  ROOT="\$DEVIN_FUSION_BYOK_ROOT"
elif [ -d "\$HOME/.config/Devin/User/globalStorage/${EXT_ID}" ]; then
  ROOT="\$HOME/.config/Devin/User/globalStorage/${EXT_ID}"
elif [ -d "\$HOME/.config/Windsurf/User/globalStorage/${EXT_ID}" ]; then
  ROOT="\$HOME/.config/Windsurf/User/globalStorage/${EXT_ID}"
else
  ROOT="\$HOME/.config/Devin/User/globalStorage/${EXT_ID}"
fi
exec "\$NODE_BIN" "\$BACKEND" "\$ROOT"
EOF
  chmod 755 "$LAUNCHER"
}

write_unit() {
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=Devin Fusion BYOK backend (${API_URL})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin
ExecStart=${LAUNCHER}
Restart=on-failure
RestartSec=2
# 被扩展优雅接管（/_runtime/shutdown）或端口被占用时后端以退出码 0 退出，
# 不能用 Restart=always，否则与 Devin Desktop 扩展拉起的后端循环抢端口。

[Install]
WantedBy=default.target
EOF
  chmod 644 "$UNIT"
}

systemd_usable() {
  have systemctl || return 1
  local out
  out="$(systemctl --user is-system-running 2>&1 || true)"
  ! printf '%s' "$out" | grep -qi 'not been booted\|Failed to connect to bus\|command not found'
}

rc_files() {
  printf '%s\n' "${HOME}/.profile" "${HOME}/.bashrc"
  for f in .bash_profile .zshrc .zprofile; do
    [ -f "${HOME}/${f}" ] && printf '%s\n' "${HOME}/${f}"
  done
  return 0
}

strip_rc_block() {
  local file="$1" tmp
  [ -f "$file" ] || return 0
  tmp="$(mktemp)"
  sed "/^# >>> devin-fusion-byok >>>\$/,/^# <<< devin-fusion-byok <<<\$/d" "$file" > "$tmp"
  cat "$tmp" > "$file" && rm -f "$tmp"
  chmod 600 "$file" 2>/dev/null || true
}

write_rc_block() {
  local file="$1"
  strip_rc_block "$file"
  {
    printf '%s\n' "$MARK_BEGIN"
    printf 'export WINDSURF_API_SERVER_URL=%s\n' "$API_URL"
    printf '%s\n' "$MARK_END"
  } >> "$file"
  chmod 600 "$file" 2>/dev/null || true
}

# 正常情况桌面端激活时已建好 config.json；万一缺失补一个最小配置，
# 之后用控制面板正常配置即可（后端每请求实时重读，无需重启）。
prepare_root() {
  local root="$1"
  mkdir -p "$root" && chmod 700 "$root"
  if [ ! -f "${root}/config.json" ]; then
    cat > "${root}/config.json" <<'EOF'
{
  "enabled": true,
  "providers": [],
  "sidekicks": [],
  "roleExclusions": { "lead": [], "sidekick": [] }
}
EOF
    chmod 600 "${root}/config.json"
    info "已写入最小配置（请到控制面板配置供应商）：${root}/config.json"
  fi
}

health_check() {
  "$NODE_BIN" -e '
    const url = "http://127.0.0.1:'"$PORT"'/health";
    let tries = 0;
    const probe = () => fetch(url).then(r => r.json())
      .then(j => { console.log("后端健康检查通过：" + JSON.stringify({ version: j.version, port: j.port || '"$PORT"' })); })
      .catch(() => { if (++tries < 10) setTimeout(probe, 500); else { console.log("健康检查未通过，可稍后运行 status 或查看日志。"); process.exitCode = 1; } });
    probe();' 2>/dev/null || true
}

# 优雅停机：优先 systemd，其次用控制令牌走 /_runtime/shutdown（有请求在处理会 409）。
stop_backend() {
  local root="$1"
  if systemd_usable && [ -f "$UNIT" ]; then
    systemctl --user disable --now "$SERVICE" >/dev/null 2>&1 && { info "服务已停用。"; return; }
  fi
  local control="${root}/runtime-control.json"
  [ -f "$control" ] || return 0
  "$NODE_BIN" -e '
    const fs = require("fs"), http = require("http");
    let token; try { token = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).token; } catch { process.exit(0); }
    const req = http.request({ host: "127.0.0.1", port: '"$PORT"', path: "/_runtime/shutdown", method: "POST",
      headers: { authorization: "Bearer " + token } }, res => {
      if (res.statusCode === 200) console.log("后端已优雅停机。");
      else if (res.statusCode === 409) console.log("后端仍有请求在处理，未强行中断（稍后可再试或手动结束进程）。");
      res.resume();
    });
    req.on("error", () => {});
    req.end();' "$control" 2>/dev/null || true
}

install() {
  local backend; backend="$(find_backend)"
  [ -n "$backend" ] || die "未检测到已安装的 devin-fusion-byok 插件。
  本脚本只负责补装常驻服务，请先在 Devin Desktop / Windsurf 的扩展面板中
  安装插件并完成配置，然后再运行本脚本。"
  NODE_BIN="$(resolve_node)"
  info "后端入口：$backend"
  info "node：$NODE_BIN"

  local root; root="$(storage_root)"
  prepare_root "$root"
  info "存储根目录：$root"

  write_launcher
  info "启动脚本：$LAUNCHER"

  if systemd_usable; then
    write_unit
    info "服务单元：$UNIT"
    systemctl --user daemon-reload
    systemctl --user enable --now "$SERVICE" >/dev/null
    info "systemd 用户服务已启用并启动。"
    if have loginctl; then
      local linger; linger="$(loginctl show-user "${USER:-$(id -un)}" -p Linger 2>/dev/null | cut -d= -f2 || true)"
      [ "$linger" = "yes" ] || info "提示：未开启 linger，退出登录后服务会被停止。需要常驻请执行：sudo loginctl enable-linger ${USER:-$(id -un)}"
    fi
  else
    info "提示：systemd 用户会话不可用，改用 setsid 后台方式启动（重启后需重新运行本脚本或手动启动 $LAUNCHER）。"
    if have setsid; then setsid "$LAUNCHER" >/dev/null 2>&1 < /dev/null &
    else nohup "$LAUNCHER" >/dev/null 2>&1 < /dev/null & fi
    disown 2>/dev/null || true
  fi

  local wrote=()
  while IFS= read -r f; do write_rc_block "$f"; wrote+=("$f"); done < <(rc_files)
  info "环境变量已写入：${wrote[*]}"

  sleep 0.5
  health_check

  cat <<EOF

安装完成。
  - 当前终端请先执行：export WINDSURF_API_SERVER_URL=${API_URL}
    （新开的终端会自动带上）
  - 插件配置由 Devin Desktop / Windsurf 控制面板管理，改完即生效，
    桌面端与本服务实时共享同一份 ${root}/config.json。
  - 桌面端运行时会占用同一端口：版本一致则复用本服务，不一致则优雅接管，
    两种情况下 devin CLI 都无感。若桌面端退出后服务未自动恢复，执行
    systemctl --user start ${SERVICE} 或重新登录即可。
  - 日志：${root}/runtime.log；健康检查：curl ${API_URL}/health
EOF
}

uninstall() {
  local root; root="$(storage_root)"

  stop_backend "$root"
  if [ -f "$UNIT" ]; then
    systemctl --user disable --now "$SERVICE" >/dev/null 2>&1 || true
    rm -f "$UNIT"; info "已移除：$UNIT"
    systemd_usable && systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  [ -f "$LAUNCHER" ] && { rm -f "$LAUNCHER"; info "已移除：$LAUNCHER"; }

  while IFS= read -r f; do strip_rc_block "$f"; info "环境变量已移除：$f"; done < <(rc_files)

  cat <<EOF

卸载完成。
  - 插件本体（~/.devin/extensions 等）与配置目录（含 API 密钥）均保留，
    它们由桌面端管理，本脚本从不触碰。
  - 由 Devin Desktop / Windsurf 扩展拉起的后端进程不受影响。
  - 当前终端请执行：unset WINDSURF_API_SERVER_URL（或新开终端）
EOF
}

status() {
  local root; root="$(storage_root)"
  NODE_BIN="$(command -v node 2>/dev/null || echo node)"
  info "启动脚本：$([ -f "$LAUNCHER" ] && echo "$LAUNCHER" || echo '未安装')"
  info "服务单元：$([ -f "$UNIT" ] && echo "$UNIT" || echo '未安装')"
  info "存储根目录：$root（$([ -f "${root}/config.json" ] && echo 'config.json 存在' || echo 'config.json 缺失'))"
  info "插件后端：$(find_backend | sed 's/^$/未安装（请先在桌面端安装插件）/')"
  if systemd_usable; then
    local active enabled
    active="$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)"; [ -n "$active" ] || active=unknown
    enabled="$(systemctl --user is-enabled "$SERVICE" 2>/dev/null || true)"; [ -n "$enabled" ] || enabled=unknown
    info "服务状态：${active} / 开机自启：${enabled}"
  else
    info "systemd 用户会话不可用"
  fi
  health_check
}

case "${1:-install}" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  *) sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
