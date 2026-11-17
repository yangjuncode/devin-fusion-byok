#!/usr/bin/env bash
# export-config.sh — 在有 Devin Desktop（已装 Fusion BYOK 扩展、控制面板已配置好）的
# 机器上运行，把配置导出成 fusion-byok-config.tar.gz。
#
# 用法：
#   ./export-config.sh                     # 导出到当前目录 ./fusion-byok-config.tar.gz
#   ./export-config.sh -o /path/out.tar.gz # 指定输出路径
#
# 然后把输出文件传到服务器，与 server-installer.sh、devin-fusion-byok-*.vsix
# 放同一目录；server-installer.sh install 时会自动把它导入存储根目录。
#
# 导出内容：
#   config.json         —— 面板写出的完整配置（供应商、API 密钥、模型、Fusion 预设、开关）
#   native-models.json  —— 官方模型目录观察快照（如有）：服务器后端在收到官方目录前
#                          就能解析含官方角色的 Fusion 预设，不是必需但建议带上
# 不导出：runtime-control.json（本机运行令牌）、runtime.log*、monitor.jsonl、goal/、
#         settings-restore.json —— 均为本机运行态或体积过大，对服务器无意义。
#
# 注意：config.json 含有 API 密钥明文——输出文件权限设为 0600，请用 scp 等安全方式
# 传输，不要提交进 git，导入服务器后可删除该文件。
set -euo pipefail

OUT="./fusion-byok-config.tar.gz"
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output) OUT="${2:?-o 需要参数}"; shift 2 ;;
    *) echo "用法：$0 [-o 输出文件.tar.gz]" >&2; exit 2 ;;
  esac
done

die() { echo "错误：$*" >&2; exit 1; }

# 与扩展 globalStorage 及 standalone/launcher 一致的候选根目录；
# DEVIN_FUSION_BYOK_ROOT 可覆盖（对应手动指定的非常规存储位置）。
find_root() {
  if [ -n "${DEVIN_FUSION_BYOK_ROOT:-}" ]; then
    [ -f "${DEVIN_FUSION_BYOK_ROOT}/config.json" ] || die "DEVIN_FUSION_BYOK_ROOT 下没有 config.json：$DEVIN_FUSION_BYOK_ROOT"
    printf '%s\n' "$DEVIN_FUSION_BYOK_ROOT"; return
  fi
  for root in \
    "${XDG_CONFIG_HOME:-$HOME/.config}/Devin/User/globalStorage/local.devin-fusion-byok" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/Windsurf/User/globalStorage/local.devin-fusion-byok"; do
    [ -f "${root}/config.json" ] && { printf '%s\n' "$root"; return; }
  done
  return 1
}

ROOT="$(find_root)" || die "未找到已配置的存储目录。请先在 Devin Desktop 控制面板里配置供应商与模型（配置写在 ~/.config/Devin/User/globalStorage/local.devin-fusion-byok/config.json）。"
echo "存储根目录：$ROOT"

FILES="config.json"
[ -f "${ROOT}/native-models.json" ] && FILES="$FILES native-models.json"

tar -czf "$OUT" -C "$ROOT" $FILES
chmod 600 "$OUT"
echo "已导出：$OUT（包含：$FILES）"

# 顺手做个内容体检：统计供应商与模型数，让导出方确认拿到的是完整配置。
if command -v python3 >/dev/null 2>&1; then
  python3 - "$ROOT" <<'PY' 2>/dev/null || true
import json, sys
cfg = json.load(open(sys.argv[1] + "/config.json"))
ps = [p for p in cfg.get("providers", []) if p.get("enabled", True)]
ms = sum(len([m for m in p.get("models", []) if m.get("enabled", True)]) for p in ps)
print(f"配置概览：启用供应商 {len(ps)} 个，启用模型 {ms} 个，"
      f"Fusion 预设 {len(cfg.get('fusionPresets', []))} 个，"
      f"autoByok={'开' if cfg.get('autoByok') else '关'}")
PY
elif command -v node >/dev/null 2>&1; then
  node - "$ROOT" <<'JS' 2>/dev/null || true
const c = JSON.parse(require("fs").readFileSync(process.argv[1] + "/config.json", "utf8"));
const ps = (c.providers || []).filter(p => p.enabled !== false);
const ms = ps.reduce((n, p) => n + (p.models || []).filter(m => m.enabled !== false).length, 0);
console.log(`配置概览：启用供应商 ${ps.length} 个，启用模型 ${ms} 个，Fusion 预设 ${(c.fusionPresets || []).length} 个，autoByok=${c.autoByok ? "开" : "关"}`);
JS
fi

cat <<EOF

提醒：该文件包含 API 密钥明文（已设权限 0600）。
传到服务器：scp $OUT user@server:/path/to/install-dir/
在服务器上把它和 server-installer.sh、.vsix 放同一目录后运行 install 即可自动导入。
EOF
