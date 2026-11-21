#!/usr/bin/env bash
# import-config.sh — 在有 Devin Desktop 的机器上运行，把导出的配置导入扩展存储目录。
# 与 export-config.sh 互为逆操作；server-installer.sh 的 import_config 是同款逻辑的服务器版。
#
# 用法：
#   ./import-config.sh                          # 在当前目录依次找 fusion-byok-config.tar.gz / .json / config.json
#   ./import-config.sh /path/fusion-byok-config.tar.gz
#   ./import-config.sh -y /path/config.json     # 跳过覆盖确认
#
# 也支持 DEVIN_FUSION_BYOK_CONFIG 指定来源文件、DEVIN_FUSION_BYOK_ROOT 指定存储根目录。
#
# 接受的来源：
#   fusion-byok-config.tar.gz —— export-config.sh 产出（config.json + 可选 native-models.json）
#   *.json                    —— 控制面板「导出配置」产出的纯 JSON（等同 config.json）
#
# 行为：
#   - 先解到临时目录校验（合法 JSON 且含 providers 数组），再覆盖，不做半成品导入
#   - 已有 config.json 先备份为 config.json.bak-<时间戳>；终端交互时需确认，-y 跳过
#   - 导入 native-models.json（tar.gz 内如含）：官方角色预设在目录同步前即可解析
#   - 不导入 runtime-control.json、monitor.jsonl、goal/、settings-restore.json 等本机运行态
#
# 注意：config.json 含 API 密钥明文——导入的文件与备份权限均为 0600，
# 正在运行的 Devin 窗口会在约一秒内自动应用新配置，无需重启。
set -euo pipefail

YES=0
SRC=""
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1; shift ;;
    -h|--help) sed -n '2,/^set -/p' "$0" | sed 's/^#\s\?//; /^set -/d'; exit 0 ;;
    -*) echo "未知选项：$1" >&2; exit 2 ;;
    *) SRC="$1"; shift ;;
  esac
done

die() { echo "错误：$*" >&2; exit 1; }
info() { echo "$*"; }

# 与扩展 globalStorage 一致的候选根目录：优先已存在的目录，否则用 Devin 路径（可预置配置）。
find_root() {
  if [ -n "${DEVIN_FUSION_BYOK_ROOT:-}" ]; then printf '%s\n' "$DEVIN_FUSION_BYOK_ROOT"; return; fi
  local base="${XDG_CONFIG_HOME:-$HOME/.config}"
  for root in "${base}/Devin/User/globalStorage/local.devin-fusion-byok" \
              "${base}/Windsurf/User/globalStorage/local.devin-fusion-byok"; do
    [ -d "$root" ] && { printf '%s\n' "$root"; return; }
  done
  printf '%s\n' "${base}/Devin/User/globalStorage/local.devin-fusion-byok"
}

SRC="${SRC:-${DEVIN_FUSION_BYOK_CONFIG:-}}"
if [ -z "$SRC" ]; then
  for f in ./fusion-byok-config.tar.gz ./fusion-byok-config.json ./config.json; do
    [ -f "$f" ] && { SRC="$f"; break; }
  done
fi
[ -n "$SRC" ] || die "未找到配置来源。把 fusion-byok-config.tar.gz / fusion-byok-config.json / config.json 放到当前目录，或直接传文件路径。"
[ -f "$SRC" ] || die "来源文件不存在：$SRC"

ROOT="$(find_root)"
mkdir -p "$ROOT"; chmod 700 "$ROOT"
info "存储根目录：$ROOT"

# 合法 JSON 且 providers 为数组；node 优先，python3 兜底，都没有则跳过深度校验。
validate_config() {
  local file="$1"
  if command -v node >/dev/null 2>&1; then
    node - "$file" <<'JS' 2>/dev/null
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('顶层不是对象');
if (!Array.isArray(cfg.providers)) throw new Error('缺少 providers 数组');
JS
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$file" <<'PY' 2>/dev/null
import json, sys
cfg = json.load(open(sys.argv[1]))
assert isinstance(cfg, dict), '顶层不是对象'
assert isinstance(cfg.get('providers'), list), '缺少 providers 数组'
PY
  else
    info "警告：没有 node/python3，跳过配置结构校验。"; return 0
  fi
}

print_overview() {
  local file="$1"
  if command -v node >/dev/null 2>&1; then
    node - "$file" <<'JS' 2>/dev/null || true
const c = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const ps = (c.providers || []).filter(p => p.enabled !== false);
const ms = ps.reduce((n, p) => n + (p.models || []).filter(m => m.enabled !== false).length, 0);
console.log(`配置概览：启用供应商 ${ps.length} 个，启用模型 ${ms} 个，Fusion 预设 ${(c.fusionPresets || []).length} 个，autoByok=${c.autoByok ? '开' : '关'}，enabled=${c.enabled === false ? '关' : '开'}`);
JS
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$file" <<'PY' 2>/dev/null || true
import json, sys
c = json.load(open(sys.argv[1]))
ps = [p for p in c.get('providers', []) if p.get('enabled', True)]
ms = sum(len([m for m in p.get('models', []) if m.get('enabled', True)]) for p in ps)
print(f"配置概览：启用供应商 {len(ps)} 个，启用模型 {ms} 个，Fusion 预设 {len(c.get('fusionPresets', []))} 个，autoByok={'开' if c.get('autoByok') else '关'}，enabled={'关' if c.get('enabled') is False else '开'}")
PY
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 解来源到临时目录，先校验再落盘。
case "$SRC" in
  *.tar.gz|*.tgz)
    members="$(tar -tzf "$SRC" 2>/dev/null | grep -E '^\.?/?(config\.json|native-models\.json)$' | sed 's|^\./||' || true)"
    [ -n "$members" ] || die "配置包 $SRC 里没有 config.json / native-models.json。"
    # shellcheck disable=SC2086
    tar -xzf "$SRC" -C "$TMP" $members
    [ -f "$TMP/config.json" ] || die "配置包 $SRC 里没有 config.json。"
    ;;
  *)
    cp "$SRC" "$TMP/config.json"
    ;;
esac
validate_config "$TMP/config.json" || die "$SRC 不是有效的 Fusion BYOK 配置（需为含 providers 数组的 JSON）。"
print_overview "$TMP/config.json"

if [ -f "$ROOT/config.json" ] && [ "$YES" != "1" ] && [ -t 0 ]; then
  read -r -p "将覆盖现有配置（会先备份）。继续？[y/N] " reply
  case "$reply" in y|Y|yes|YES) ;; *) info "已取消。"; exit 0 ;; esac
fi
if [ -f "$ROOT/config.json" ]; then
  BAK="$ROOT/config.json.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$ROOT/config.json" "$BAK" && chmod 600 "$BAK"
  info "已有配置已备份：$BAK"
fi

for m in config.json native-models.json; do
  if [ -f "$TMP/$m" ]; then mv -f "$TMP/$m" "$ROOT/$m"; chmod 600 "$ROOT/$m"; fi
done
info "已导入：$SRC → $ROOT"
cat <<'EOF'

完成。正在运行的 Devin 窗口会在约一秒内自动读取新配置；尚未打开的窗口/机器安装扩展后直接生效。
提醒：config.json 含 API 密钥明文（已设权限 0600），请妥善保管来源文件与备份。
EOF
