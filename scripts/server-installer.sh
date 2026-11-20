#!/usr/bin/env bash
# server-installer.sh — 在只装了 Devin CLI（无 Devin Desktop）的服务器上安装 Fusion BYOK。
# 已装 Desktop 插件的机器请改用 scripts/install-service.sh（复用插件与配置，无需 vsix）。
#
# 用法：把本脚本与 devin-fusion-byok-<版本>.vsix 放在同一目录，然后：
#   ./server-installer.sh install                 # 解包 vsix、装后端服务、写入环境变量
#   ./server-installer.sh install /path/x.vsix    # 显式指定 vsix
#   ./server-installer.sh status                  # 查看服务与后端状态
#   ./server-installer.sh uninstall               # 停用服务、移除环境变量与扩展文件（保留配置）
#   ./server-installer.sh uninstall --purge       # 同上，并删除配置目录（含 API 密钥，不可恢复）
#
# 配置来源：在没有 Devin Desktop 的服务器上无法使用控制面板。请在有 Desktop 的
# 机器上运行 scripts/export-config.sh 导出 fusion-byok-config.tar.gz，把它放到
# 本脚本同目录再 install —— 会自动导入其中的 config.json（和 native-models.json）。
# 也接受同目录下的 fusion-byok-config.json 或 config.json（纯 JSON 形式）。
# 显式指定文件：DEVIN_FUSION_BYOK_CONFIG=/path/to/file ./server-installer.sh install
# 若存储根目录已有 config.json，导入前会先备份为 config.json.bak-<时间戳>。
#
# 安装后做的事（与 Desktop 扩展等价的最小链路）：
#   1. vsix 解到 ~/.devin/extensions/<publisher>.<name>-<version>/ —— 与 Desktop 用户扩展目录同构；
#   2. 生成 ~/.local/bin/devin-fusion-byok 启动器：每次运行自动解析最高版本的
#      src/runtime/backend.cjs 并以 node 启动（127.0.0.1:39842）；
#   3. 装 systemd --user 服务 devin-fusion-byok.service 常驻；
#      无 systemd 时回退为 setsid 后台进程并给出提示；
#   4. 向 ~/.profile、~/.bashrc（及已存在的 ~/.bash_profile、~/.zshrc、~/.zprofile）
#      写入 export WINDSURF_API_SERVER_URL=http://127.0.0.1:39842，
#      Devin CLI 进程读该变量决定 API 端点，从而接入本机 BYOK 后端；
#   5. 后端把除 BYOK 外的全部 RPC 透传到 https://server.codeium.com，
#      所以服务器必须能访问该地址，Devin 账号认证完全不变。
#
# 细节约定：
#   - 后端端口固定 39842，只绑回环；同机 Desktop 扩展可经控制令牌优雅接管，不抢端口。
#   - 配置在 ~/.config/Devin/User/globalStorage/<publisher>.<name>/config.json，
#     后端每请求实时重读，改配置无需重启；建议在有 Desktop 的机器上配好后用
#     export-config.sh 导出再导入（见上），或直接手工编辑。
#   - node 路径在安装时解析并写死进启动器（兼容 nvm 等非标准安装位置），
#     可用 DEVIN_FUSION_BYOK_NODE 覆盖；后端入口可用 DEVIN_FUSION_BYOK_BACKEND 覆盖，
#     存储根目录可用 DEVIN_FUSION_BYOK_ROOT 覆盖（注意：systemd 服务读不到 shell 的
#     环境变量，这些覆盖只对前台/手动运行启动器时生效）。
#   - 无头服务器若希望服务开机自启、退出登录后仍存活，需要：
#       sudo loginctl enable-linger "$USER"
#
# 依赖：bash、node（>=18，后端运行时需要）、unzip 或 python3 或 bsdtar 或 7z 之一。
set -euo pipefail

PORT=39842
API_URL="http://127.0.0.1:${PORT}"
SERVICE="devin-fusion-byok.service"
MARK_BEGIN='# >>> devin-fusion-byok >>>'
MARK_END='# <<< devin-fusion-byok <<<'
LAUNCHER="${HOME}/.local/bin/devin-fusion-byok"
UNIT="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/${SERVICE}"
EXT_HOME="${HOME}/.devin/extensions"

die() { echo "错误：$*" >&2; exit 1; }
info() { echo "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

script_dir() { cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd; }

pick_vsix() {
  if [ -n "${1:-}" ]; then
    [ -f "$1" ] || die "指定的 vsix 不存在：$1"
    printf '%s\n' "$1"; return
  fi
  local dir; dir="$(script_dir)"
  local found
  found="$(find "$dir" -maxdepth 1 -name '*.vsix' -type f 2>/dev/null | sort -V | tail -n 1)"
  [ -n "$found" ] || die "未在脚本同目录找到 .vsix；请把 devin-fusion-byok-*.vsix 与本脚本放在一起，或用参数指定路径。"
  printf '%s\n' "$found"
}

resolve_node() {
  local bin="${DEVIN_FUSION_BYOK_NODE:-}"
  [ -n "$bin" ] || bin="$(command -v node 2>/dev/null || true)"
  [ -n "$bin" ] && [ -x "$bin" ] || die "未找到 node。请先安装 Node.js >=18（后端运行时需要），或用 DEVIN_FUSION_BYOK_NODE=/path/to/node 指定。"
  printf '%s\n' "$bin"
}

# 解包 vsix（本质是 zip）到给定目录；按可用性依次尝试 unzip / python3 / bsdtar / 7z。
extract_vsix() {
  local vsix="$1" dest="$2"
  if have unzip; then unzip -qo "$vsix" -d "$dest";
  elif have python3; then python3 -m zipfile -e "$vsix" "$dest";
  elif have bsdtar; then bsdtar -xf "$vsix" -C "$dest";
  elif have 7z; then 7z x -y -o"$dest" "$vsix" >/dev/null;
  else die "没有可用的解压工具（需要 unzip、python3、bsdtar 或 7z 之一）。"; fi
}

# 用 node 读 package.json，输出两行：<publisher>.<name> 与 <version>。
pkg_identity() {
  "$NODE_BIN" -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((p.publisher||"local")+"."+p.name);console.log(p.version)' "$1"
}

storage_root() {
  if [ -n "${DEVIN_FUSION_BYOK_ROOT:-}" ]; then printf '%s\n' "$DEVIN_FUSION_BYOK_ROOT"; return; fi
  printf '%s\n' "${XDG_CONFIG_HOME:-${HOME}/.config}/Devin/User/globalStorage/${EXT_ID:-local.devin-fusion-byok}"
}

# 启动器：与 scripts/standalone.cjs 同款逻辑——每次启动解析最高版本后端，
# 升级只需重新 install 新版本 vsix，无需改任何配置。node 路径安装时写死。
write_launcher() {
  mkdir -p "$(dirname "$LAUNCHER")"
  cat > "$LAUNCHER" <<EOF
#!/bin/sh
# devin-fusion-byok standalone launcher（由 server-installer.sh 生成）
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
    info "已写入最小配置（尚未配置供应商）：${root}/config.json"
  fi
  if [ ! -f "${root}/config.example.json" ]; then
    cat > "${root}/config.example.json" <<'EOF'
{
  "_note": "完整配置示例；最有效率的做法是在装了 Devin Desktop 的机器上用控制面板配好后，把本目录的 config.json 直接拷过来。字段说明见 README。",
  "enabled": true,
  "providers": [
    {
      "id": "provider-1",
      "name": "我的供应商",
      "baseUrl": "https://example.com/v1",
      "apiFormat": "openai-responses",
      "apiKey": "sk-...",
      "enabled": true,
      "models": [
        { "id": "gpt-5.6-sol", "label": "gpt-5.6-sol", "efforts": [],
          "contextWindow": 272000, "maxOutputTokens": 32768, "enabled": true }
      ]
    }
  ],
  "fusionPresets": [
    {
      "id": "preset-1", "name": "我的组合",
      "lead":     { "providerId": "provider-1", "model": "gpt-5.6-sol", "effort": "high" },
      "sidekick": { "providerId": "provider-1", "model": "swe-2-max",  "effort": null }
    }
  ],
  "roleExclusions": { "lead": [], "sidekick": [] },
  "autoByok": false,
  "upstreamRetries": 20,
  "_optional": "provider 可加 \"unlockKind\": \"codex\" 走 Codex 专线；另有 autoContinueOnProviderError、autoContinueUntilPlanComplete、autoContinueMaxCount、monitorRetentionDays、contextWindowCaps、hiddenNativeModelUids、fusionUidFilter 等字段。"
}
EOF
    chmod 600 "${root}/config.example.json"
  fi
}

# 导入配置：优先 DEVIN_FUSION_BYOK_CONFIG 显式指定，否则在脚本同目录找
# export-config.sh 产出的 fusion-byok-config.tar.gz，或纯 JSON 形式的
# fusion-byok-config.json / config.json。已有 config.json 时先备份再覆盖。
import_config() {
  local root="$1" dir src=""
  dir="$(script_dir)"
  src="${DEVIN_FUSION_BYOK_CONFIG:-}"
  if [ -z "$src" ]; then
    for f in "${dir}/fusion-byok-config.tar.gz" "${dir}/fusion-byok-config.json" "${dir}/config.json"; do
      [ -f "$f" ] && { src="$f"; break; }
    done
  fi
  [ -n "$src" ] || { info "未发现导出的配置文件（fusion-byok-config.tar.gz 等），使用最小配置。"; return 0; }
  [ -f "$src" ] || die "DEVIN_FUSION_BYOK_CONFIG 指定的文件不存在：$src"
  if [ -f "${root}/config.json" ] && [ "${HAD_CONFIG:-0}" = "1" ]; then
    local bak="${root}/config.json.bak-$(date +%Y%m%d-%H%M%S)"
    cp "${root}/config.json" "$bak" && chmod 600 "$bak"
    info "已有配置已备份：$bak"
  fi
  case "$src" in
    *.tar.gz|*.tgz)
      local members
      members="$(tar -tzf "$src" 2>/dev/null | grep -E '^\.?/?(config\.json|native-models\.json)$' | sed 's|^\./||' || true)"
      [ -n "$members" ] || die "配置包 ${src} 里没有 config.json / native-models.json。"
      # shellcheck disable=SC2086
      tar -xzf "$src" -C "$root" $members
      for m in config.json native-models.json; do [ -f "${root}/$m" ] && chmod 600 "${root}/$m"; done
      info "已从配置包导入：$(printf '%s' "$members" | tr '\n' ' ') ← $src"
      ;;
    *)
      cp "$src" "${root}/config.json"; chmod 600 "${root}/config.json"
      info "已导入配置：$src → ${root}/config.json"
      ;;
  esac
  "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "${root}/config.json" \
    || die "导入后的 ${root}/config.json 不是合法 JSON，请检查导出文件。"
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
  local vsix; vsix="$(pick_vsix "${1:-}")"
  NODE_BIN="$(resolve_node)"
  info "vsix：$vsix"
  info "node：$NODE_BIN"

  local stage; stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' RETURN
  extract_vsix "$vsix" "$stage"
  [ -f "${stage}/extension/package.json" ] || die "vsix 结构异常：缺少 extension/package.json"

  local id_lines; id_lines="$(pkg_identity "${stage}/extension/package.json")"
  EXT_ID="$(printf '%s\n' "$id_lines" | sed -n 1p)"
  local version; version="$(printf '%s\n' "$id_lines" | sed -n 2p)"
  [ -n "$EXT_ID" ] && [ -n "$version" ] || die "无法从 package.json 解析扩展标识。"
  local ext_dir="${EXT_HOME}/${EXT_ID}-${version}"

  mkdir -p "$EXT_HOME"
  # 同版本直接覆盖；旧版本目录保留（启动器总是选最高版本），如需清理可手动删除。
  rm -rf "$ext_dir"
  mv "${stage}/extension" "$ext_dir"
  info "扩展文件：$ext_dir"

  local root; root="$(storage_root)"
  HAD_CONFIG=0; [ -f "${root}/config.json" ] && HAD_CONFIG=1
  prepare_root "$root"
  import_config "$root"
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
      [ "$linger" = "yes" ] || info "提示：未开启 linger，退出登录后服务会被停止、开机也不会自启。需要常驻请执行：sudo loginctl enable-linger ${USER:-$(id -un)}"
    fi
  else
    info "提示：systemd 用户会话不可用，改用 setsid 后台方式启动（重启后需重新运行 install 或手动启动 $LAUNCHER）。"
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
  - 配置供应商：编辑 ${root}/config.json（参考同目录 config.example.json），
    或直接从有 Devin Desktop 的机器拷贝整个 ${root##*/} 目录；改完即生效，无需重启。
  - 然后运行 devin，/model 中会出现 BYOK 模型与"我的 Fusion"预设。
  - 日志：${root}/runtime.log；健康检查：curl ${API_URL}/health
EOF
}

uninstall() {
  local purge=0
  [ "${1:-}" = "--purge" ] && purge=1
  local root; root="$(storage_root)"

  stop_backend "$root"
  if [ -f "$UNIT" ]; then
    systemctl --user disable --now "$SERVICE" >/dev/null 2>&1 || true
    rm -f "$UNIT"; info "已移除：$UNIT"
    systemd_usable && systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  [ -f "$LAUNCHER" ] && { rm -f "$LAUNCHER"; info "已移除：$LAUNCHER"; }

  while IFS= read -r f; do strip_rc_block "$f"; info "环境变量已移除：$f"; done < <(rc_files)

  local removed=0 d
  for d in "${EXT_HOME}/"*devin-fusion-byok-*; do
    [ -d "$d" ] || continue
    rm -rf "$d"; info "已移除扩展目录：$d"; removed=1
  done
  [ "$removed" = 0 ] && info "未发现已安装的扩展目录。"

  if [ "$purge" = 1 ]; then
    rm -rf "$root"; info "已删除配置目录（含密钥）：$root"
  else
    info "配置目录保留：$root（含 API 密钥；如需删除请运行 uninstall --purge）"
  fi

  cat <<EOF

卸载完成。
  - 当前终端请执行：unset WINDSURF_API_SERVER_URL（或新开终端）
  - 已启动的 devin 会话沿用启动时的环境，请新建会话使用原生配置。
EOF
}

status() {
  local root; root="$(storage_root)"
  NODE_BIN="$(command -v node 2>/dev/null || echo node)"
  info "启动脚本：$([ -f "$LAUNCHER" ] && echo "$LAUNCHER" || echo '未安装')"
  info "服务单元：$([ -f "$UNIT" ] && echo "$UNIT" || echo '未安装')"
  info "存储根目录：$root（$([ -f "${root}/config.json" ] && echo 'config.json 存在' || echo 'config.json 缺失'))"
  info "扩展目录：$(ls -d "${EXT_HOME}/"*devin-fusion-byok-* 2>/dev/null | tail -n 1 || echo '未安装')"
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

case "${1:-}" in
  install) install "${2:-}" ;;
  uninstall) uninstall "${2:-}" ;;
  status) status ;;
  *) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
