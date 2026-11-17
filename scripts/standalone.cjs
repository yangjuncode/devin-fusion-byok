'use strict';
// 独立守护安装器：把 127.0.0.1:39842 后端交给 systemd --user 常驻，
// 让 devin CLI 与 Devin Desktop 共用同一条 BYOK 链路。
//   node scripts/standalone.cjs install | uninstall | status
//
// 与 Desktop 共处的关键：
// - 存储根目录与扩展 globalStorage 相同，rootId 一致；扩展的 ensureBackend
//   按 version/sourceId/networkId 比对，不匹配时经控制令牌优雅接管。
// - 接管或端口冲突时后端退出码为 0，unit 用 Restart=on-failure，绝不与扩展
//   拉起的进程循环抢端口；被接管后 CLI 继续打同一端口，无感切换。
// - 启动脚本每次运行都解析当前安装的最新版本 backend.cjs，升级扩展后
//   systemd 重启或扩展接管都会自动跟上新版本，不写死任何版本号。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const home = os.homedir();
const PORT = 39842;
const URL = 'http://127.0.0.1:' + PORT;
const SERVICE = 'devin-fusion-byok.service';
const LAUNCHER = path.join(home, '.local/bin/devin-fusion-byok');
const UNIT = path.join(home, '.config/systemd/user', SERVICE);
const EXTENSION_DIRS = [path.join(home, '.devin/extensions'), path.join(home, '.windsurf/extensions')];
const ROOT_CANDIDATES = [
  path.join(home, '.config/Devin/User/globalStorage/local.devin-fusion-byok'),
  path.join(home, '.config/Windsurf/User/globalStorage/local.devin-fusion-byok'),
];
const MARK_BEGIN = '# >>> devin-fusion-byok >>>';
const MARK_END = '# <<< devin-fusion-byok <<<';
const ENV_BLOCK = MARK_BEGIN + '\nexport WINDSURF_API_SERVER_URL=' + URL + '\n' + MARK_END + '\n';
const MARK_RE = new RegExp('\\n?' + MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n[\\s\\S]*?' +
  MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?', 'g');

function compareVersion(left, right) {
  const a = String(left).split('.').map(Number), b = String(right).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}
function backendCandidates() {
  const found = [];
  for (const dir of EXTENSION_DIRS) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const match = /^local\.devin-fusion-byok-(.+)$/.exec(entry);
      if (!match) continue;
      const file = path.join(dir, entry, 'src/runtime/backend.cjs');
      if (fs.existsSync(file)) found.push({ version: match[1], file });
    }
  }
  return found.sort((a, b) => compareVersion(a.version, b.version));
}
function latestBackend() {
  if (process.env.DEVIN_FUSION_BYOK_BACKEND) return process.env.DEVIN_FUSION_BYOK_BACKEND;
  const list = backendCandidates();
  return list.length ? list[list.length - 1].file : '';
}
function storageRoot() {
  if (process.env.DEVIN_FUSION_BYOK_ROOT) return process.env.DEVIN_FUSION_BYOK_ROOT;
  return ROOT_CANDIDATES.find(dir => fs.existsSync(dir)) || ROOT_CANDIDATES[0];
}

const launcherScript = `#!/bin/sh
# devin-fusion-byok standalone launcher（由 standalone.cjs install 生成）
# 每次启动都解析最新安装的扩展版本，升级插件后无需改任何配置。
set -eu
BACKEND="\${DEVIN_FUSION_BYOK_BACKEND:-}"
if [ -z "$BACKEND" ]; then
  for candidate in "$HOME"/.devin/extensions/local.devin-fusion-byok-*/src/runtime/backend.cjs \\
                    "$HOME"/.windsurf/extensions/local.devin-fusion-byok-*/src/runtime/backend.cjs; do
    [ -f "$candidate" ] || continue
    if [ -z "$BACKEND" ] || [ "$(printf '%s\\n%s\\n' "$BACKEND" "$candidate" | sort -V | tail -n 1)" = "$candidate" ]; then
      BACKEND="$candidate"
    fi
  done
fi
[ -n "$BACKEND" ] && [ -f "$BACKEND" ] || { echo "devin-fusion-byok: 未找到已安装的插件后端" >&2; exit 1; }
if [ -n "\${DEVIN_FUSION_BYOK_ROOT:-}" ]; then
  ROOT="$DEVIN_FUSION_BYOK_ROOT"
elif [ -d "$HOME/.config/Devin/User/globalStorage/local.devin-fusion-byok" ]; then
  ROOT="$HOME/.config/Devin/User/globalStorage/local.devin-fusion-byok"
elif [ -d "$HOME/.config/Windsurf/User/globalStorage/local.devin-fusion-byok" ]; then
  ROOT="$HOME/.config/Windsurf/User/globalStorage/local.devin-fusion-byok"
else
  ROOT="$HOME/.config/Devin/User/globalStorage/local.devin-fusion-byok"
fi
exec node "$BACKEND" "$ROOT"
`;

const unitFile = `[Unit]
Description=Devin Fusion BYOK backend (${URL})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=${LAUNCHER}
Restart=on-failure
RestartSec=2
# 被扩展优雅接管（/_runtime/shutdown）或端口被扩展占用时退出码为 0，
# 不能用 Restart=always，否则与扩展拉起的后端循环抢端口。

[Install]
WantedBy=default.target
`;

function rcFiles() {
  const files = [path.join(home, '.profile'), path.join(home, '.bashrc')];
  for (const extra of ['.bash_profile', '.zshrc', '.zprofile']) {
    const file = path.join(home, extra);
    if (fs.existsSync(file)) files.push(file);
  }
  return files;
}
function updateRcFile(file, install) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { if (!install) return; }
  const stripped = text.replace(MARK_RE, '').replace(/\n{3,}/g, '\n\n');
  const next = install ? (stripped && !stripped.endsWith('\n') ? stripped + '\n' : stripped) + ENV_BLOCK : stripped;
  if (next === text) return false;
  fs.writeFileSync(file, next, { mode: 0o600 });
  return true;
}
function systemctl(...args) {
  const result = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  return { ok: result.status === 0, output: (result.stdout || '') + (result.stderr || ''), error: result.error };
}
function checkSystemdUser() {
  const probe = systemctl('is-system-running');
  if (probe.error?.code === 'ENOENT') throw new Error('未找到 systemctl，无法安装用户服务。');
  if (probe.error) throw probe.error;
  if (/command not found|System has not been booted/i.test(probe.output)) throw new Error('systemd 用户会话不可用，无法安装常驻服务。');
}

function install() {
  checkSystemdUser();
  const backend = latestBackend();
  if (!backend) console.log('警告：当前未找到已安装的插件（local.devin-fusion-byok-*），服务会等插件安装后才能启动。');
  else console.log('后端入口：' + backend);
  console.log('存储根目录：' + storageRoot());
  fs.mkdirSync(path.dirname(LAUNCHER), { recursive: true });
  fs.writeFileSync(LAUNCHER, launcherScript, { mode: 0o755 });
  console.log('启动脚本：' + LAUNCHER);
  fs.mkdirSync(path.dirname(UNIT), { recursive: true });
  fs.writeFileSync(UNIT, unitFile, { mode: 0o644 });
  console.log('服务单元：' + UNIT);
  const reload = systemctl('daemon-reload');
  if (!reload.ok) throw new Error('systemctl daemon-reload 失败：' + reload.output.trim());
  const enable = systemctl('enable', '--now', SERVICE);
  if (!enable.ok) throw new Error('systemctl enable --now 失败：' + enable.output.trim());
  for (const file of rcFiles()) if (updateRcFile(file, true)) console.log('环境变量已写入：' + file);
  console.log('\n安装完成。新开的终端会带上 WINDSURF_API_SERVER_URL=' + URL + '，' +
    '当前终端可先执行 export 该变量后运行 devin。若使用图形登录，重新登录后生效。');
}

function uninstall() {
  const disable = systemctl('disable', '--now', SERVICE);
  if (disable.ok || /No such file|not loaded|does not exist/i.test(disable.output)) {
    console.log('服务已停用。');
  } else if (!disable.error) {
    console.log('停用服务输出：' + disable.output.trim());
  }
  try { fs.unlinkSync(UNIT); console.log('已移除：' + UNIT); } catch {}
  systemctl('daemon-reload');
  try { fs.unlinkSync(LAUNCHER); console.log('已移除：' + LAUNCHER); } catch {}
  for (const file of rcFiles()) if (updateRcFile(file, false)) console.log('环境变量已移除：' + file);
  console.log('\n卸载完成。由 Devin Desktop 扩展拉起的后端进程不受影响；重新登录后环境变量完全移除。');
}

function status() {
  console.log('启动脚本：' + (fs.existsSync(LAUNCHER) ? LAUNCHER : '未安装'));
  console.log('服务单元：' + (fs.existsSync(UNIT) ? UNIT : '未安装'));
  console.log('后端入口：' + (latestBackend() || '未找到已安装插件'));
  console.log('存储根目录：' + storageRoot());
  const state = systemctl('is-active', SERVICE);
  console.log('服务状态：' + (state.error ? 'systemctl 不可用' : state.output.trim() || 'unknown'));
  const enabled = systemctl('is-enabled', SERVICE);
  console.log('开机自启：' + (enabled.error ? '未知' : enabled.output.trim() || 'unknown'));
}

const command = process.argv[2];
if (command === 'install') install();
else if (command === 'uninstall') uninstall();
else if (command === 'status') status();
else {
  console.error('用法：node scripts/standalone.cjs install | uninstall | status');
  process.exit(2);
}
