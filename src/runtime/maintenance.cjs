'use strict';
// 存储维护：清理 devin-cli 数据目录与本插件 globalStorage 中的过期数据。
// 由后台 backend 进程在启动时和每隔数小时运行一次。
//  - session_locks/*.lock：持有者进程已死的锁直接删（同 goal 锁的死锁判定）
//  - logs/、summaries/、transcripts/：按 mtime 删除超过保留期的文件
//  - sessions.db：超过容量上限时按最后活跃时间从旧到新删整个会话，
//    活锁会话与保留期内的会话永不删；删除后无活锁时尝试 VACUUM 收缩文件
//  - goal/history：超过保留期的归档目标记录一并删除
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_RETENTION_DAYS = 3;
const DEFAULT_MAX_DB_BYTES = 2 * 1024 * 1024 * 1024;
const KEEP_FRACTION = 0.85;
const DAY_MS = 86400000;

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

// 防 PID 复用误判：锁持有者必须活着且是 devin 进程（命令行含 'devin'）。
// /proc 不可读时按活着处理，宁可保留也不误删真实持有者。
function isDevinProcessAlive(pid, alive = isProcessAlive, readCmdline = p => fs.readFileSync(`/proc/${p}/cmdline`)) {
  if (!alive(pid)) return false;
  try { return Buffer.from(readCmdline(pid)).includes('devin'); }
  catch { return true; }
}

function liveSessionIds(cliDir, alive = isProcessAlive) {
  const live = new Set();
  let entries;
  try { entries = fs.readdirSync(path.join(cliDir, 'session_locks')); } catch { return live; }
  for (const entry of entries) {
    if (!entry.endsWith('.lock')) continue;
    let pid = NaN;
    try { pid = Number(fs.readFileSync(path.join(cliDir, 'session_locks', entry), 'utf8').trim()); } catch {}
    if (alive(pid)) live.add(entry.slice(0, -'.lock'.length));
  }
  return live;
}

function cleanSessionLocks(cliDir, alive = isProcessAlive) {
  let removed = 0;
  let entries;
  try { entries = fs.readdirSync(path.join(cliDir, 'session_locks')); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.endsWith('.lock')) continue;
    const file = path.join(cliDir, 'session_locks', entry);
    let pid = NaN;
    try { pid = Number(fs.readFileSync(file, 'utf8').trim()); } catch {}
    if (alive(pid)) continue;
    try { fs.unlinkSync(file); removed++; } catch {}
  }
  return removed;
}

function cleanOldFiles(directory, cutoffMs, { keep } = {}) {
  let removed = 0;
  let entries;
  try { entries = fs.readdirSync(directory); } catch { return removed; }
  for (const entry of entries) {
    const file = path.join(directory, entry);
    let stat;
    try { stat = fs.lstatSync(file); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    if (stat.mtimeMs >= cutoffMs) continue;
    if (typeof keep === 'function' && keep(entry)) continue;
    try { fs.unlinkSync(file); removed++; } catch {}
  }
  return removed;
}

// sessions.db 收缩：node:sqlite 在本扩展运行环境（Electron Node ≥ 22.13）中可用；
// 不可用时整段跳过，不降级到外部 sqlite3（缺 FTS5 会触发不了联动触发器）。
function openDatabase(file) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout=5000');
    return db;
  } catch { return null; }
}

function tablesWithSession(db) {
  const names = ['subagent_heads', 'tool_call_state', 'prompt_history', 'live_row_times', 'rendered_commits'];
  const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map(r => r.name));
  return ['message_nodes', ...names.filter(name => present.has(name))];
}

function capSessionDb(dbFile, { maxBytes = DEFAULT_MAX_DB_BYTES, cutoffSeconds, keepIds = new Set(), vacuum = true, log = () => {} } = {}) {
  const report = { skipped: null, sessionsRemoved: 0, bytesBefore: 0, bytesAfter: 0, vacuumed: false };
  let stat;
  try { stat = fs.statSync(dbFile); } catch { report.skipped = 'missing'; return report; }
  report.bytesBefore = stat.size;
  if (stat.size <= maxBytes) { report.bytesAfter = stat.size; report.skipped = 'under-cap'; return report; }
  const db = openDatabase(dbFile);
  if (!db) { report.skipped = 'sqlite-unavailable'; return report; }
  try {
    const sessionTables = tablesWithSession(db);
    const sizeOf = db.prepare('SELECT SUM(LENGTH(chat_message)) AS b FROM message_nodes WHERE session_id = ?');
    const rows = db.prepare('SELECT id, last_activity_at FROM sessions ORDER BY last_activity_at DESC').all();
    let totalLength = 0;
    const sized = rows.map(row => {
      const bytes = sizeOf.get(row.id)?.b || 0;
      totalLength += bytes;
      return { id: row.id, lastActivityAt: row.last_activity_at, bytes };
    });
    // 索引与全文搜索影子表会把文本再存一遍，按整库比例放大每会话估值。
    const scale = totalLength > 0 ? Math.max(1, stat.size / totalLength) : 1;
    const budget = maxBytes * KEEP_FRACTION;
    let projected = stat.size;
    const doomed = [];
    for (const row of [...sized].reverse()) { // 最旧的先删
      if (projected <= budget) break;
      if (keepIds.has(row.id)) continue;
      if (Number.isSafeInteger(cutoffSeconds) && row.lastActivityAt > cutoffSeconds) continue;
      doomed.push(row);
      projected -= row.bytes * scale;
    }
    for (const row of doomed) {
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const table of sessionTables) db.prepare(`DELETE FROM "${table}" WHERE session_id = ?`).run(row.id);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
        db.exec('COMMIT');
        report.sessionsRemoved++;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        log('maintenance-session-delete-failed', { code: error?.code || error?.message });
      }
    }
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    try { report.bytesAfter = fs.statSync(dbFile).size; } catch {}
    if (vacuum && keepIds.size === 0 && report.bytesAfter > maxBytes) {
      try { db.exec('VACUUM'); report.vacuumed = true; } catch { log('maintenance-vacuum-skipped', {}); }
      try { report.bytesAfter = fs.statSync(dbFile).size; } catch {}
    }
    try { report.survived = db.prepare('SELECT id FROM sessions').all().map(r => r.id); } catch {}
  } finally { try { db.close(); } catch {} }
  return report;
}

function cliDataDirectory(env = process.env) {
  const base = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'devin', 'cli');
}

// _versions 下每个旧 CLI 二进制 ~200M：仅保留 current 指向的版本；
// 旧会话若需老版本，devin 会经 _download 重新拉取。
function cleanOldVersions(cliDir) {
  const rootDir = path.join(cliDir, '_versions');
  let removed = 0, current = '';
  try { current = fs.readlinkSync(path.join(rootDir, 'current')); } catch {}
  let entries;
  try { entries = fs.readdirSync(rootDir); } catch { return removed; }
  for (const entry of entries) {
    if (entry === 'current' || entry === '_download' || entry === '_update.lock' || entry === current) continue;
    const target = path.join(rootDir, entry);
    try { if (!fs.statSync(target).isDirectory()) continue; } catch { continue; }
    try { fs.rmSync(target, { recursive: true, force: true }); removed++; } catch {}
  }
  return removed;
}

const ORPHAN_GRACE_MS = 3600000;
const TEMP_GRACE_MS = 60000;

// BYOK 自身存储清理（启动时执行）：
//  - goal/locks：持有者进程已死或文件损坏的锁直接删除（正常接管走 acquireOwnership）
//  - goal/capabilities：目标记录已不存在的授权即孤儿，超过宽限期删除；超过保留期一律删
//  - goal/reports：未被任何 activeRun 引用的报告超过宽限期删除；超过保留期一律删
//  - runtime-control.json.*：backend 启动改名失败后残留的临时文件
// 目标记录（goals/）是用户数据，不在此删除，生命周期由 goal-state/settle 管理。
function cleanGoalArtifacts(storeRoot, cutoffMs, { alive = isProcessAlive, now = Date.now } = {}) {
  const counts = { locksRemoved: 0, capabilitiesRemoved: 0, reportsRemoved: 0 };
  let store;
  try { store = require('./goal-store.cjs'); } catch { return counts; }
  const goalIds = new Set(), activeRuns = new Set();
  for (const goal of store.scanGoals(storeRoot).goals) {
    goalIds.add(goal.id);
    if (typeof goal.activeRun === 'string') activeRuns.add(goal.activeRun);
  }
  const locks = store.locksDirectory(storeRoot);
  for (const entry of store.listDirectory(locks)) {
    if (!entry.endsWith('.lock')) continue;
    const file = path.join(locks, entry);
    let dead = false;
    try {
      const record = store.readJsonFile(file);
      dead = !record || !alive(record.pid);
    } catch { dead = true; }
    if (!dead) continue;
    try { fs.unlinkSync(file); counts.locksRemoved++; } catch {}
  }
  const capabilities = store.capabilitiesDirectory(storeRoot);
  for (const entry of store.listDirectory(capabilities)) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(capabilities, entry);
    let record = null, stat;
    try { record = store.readJsonFile(file); } catch {}
    try { stat = fs.statSync(file); } catch { continue; }
    const expired = stat.mtimeMs < cutoffMs;
    const orphaned = (!record || !goalIds.has(record.id)) && stat.mtimeMs < now() - ORPHAN_GRACE_MS;
    if (!(expired || orphaned)) continue;
    try { fs.unlinkSync(file); counts.capabilitiesRemoved++; } catch {}
  }
  const reports = store.reportsDirectory(storeRoot);
  for (const entry of store.listDirectory(reports)) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(reports, entry);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const expired = stat.mtimeMs < cutoffMs;
    const orphaned = !activeRuns.has(entry.slice(0, -'.json'.length)) && stat.mtimeMs < now() - ORPHAN_GRACE_MS;
    if (!(expired || orphaned)) continue;
    try { fs.unlinkSync(file); counts.reportsRemoved++; } catch {}
  }
  return counts;
}

function cleanRuntimeTemps(storeRoot, nowMs) {
  let removed = 0;
  let entries;
  try { entries = fs.readdirSync(storeRoot); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.startsWith('runtime-control.json.')) continue;
    const file = path.join(storeRoot, entry);
    let stat;
    try { stat = fs.lstatSync(file); } catch { continue; }
    if (!stat.isFile() || stat.mtimeMs >= nowMs - TEMP_GRACE_MS) continue;
    try { fs.unlinkSync(file); removed++; } catch {}
  }
  return removed;
}

function cleanGoalHistory(storeRoot, cutoffMs) {
  let removed = 0;
  try {
    const store = require('./goal-store.cjs');
    for (const record of store.scanHistory(storeRoot).goals) {
      if (!Number.isFinite(record.archivedAt) || record.archivedAt >= cutoffMs) continue;
      if (store.removeHistory(storeRoot, record.id)) removed++;
    }
  } catch {}
  return removed;
}

function runMaintenance({ cliDir = cliDataDirectory(), storeRoot, retentionDays = DEFAULT_RETENTION_DAYS,
  maxDbBytes = DEFAULT_MAX_DB_BYTES, alive = isProcessAlive, lockAlive, log = () => {}, now = Date.now } = {}) {
  const report = {};
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : DEFAULT_RETENTION_DAYS;
  const cutoffMs = now() - days * DAY_MS;
  lockAlive = lockAlive || (pid => isDevinProcessAlive(pid, alive));
  report.locksRemoved = cleanSessionLocks(cliDir, lockAlive);
  const live = liveSessionIds(cliDir, lockAlive);
  report.oldLogsRemoved = cleanOldFiles(path.join(cliDir, 'logs'), cutoffMs);
  report.sessionDb = capSessionDb(path.join(cliDir, 'sessions.db'), {
    maxBytes: maxDbBytes, cutoffSeconds: Math.floor(cutoffMs / 1000), keepIds: live,
    vacuum: live.size === 0, log
  });
  // transcripts/summaries 关联 sessions.db 中幸存的会话：孤儿文件直接清，
  // 幸存会话的转录保留（会话还能恢复）；summaries 无会话映射，仍按时间删。
  const survivors = new Set([...(report.sessionDb.survived || []), ...live]);
  report.transcriptsRemoved = cleanOldFiles(path.join(cliDir, 'transcripts'), cutoffMs,
    { keep: entry => survivors.has(entry.replace(/\.json$/u, '')) });
  report.summariesRemoved = cleanOldFiles(path.join(cliDir, 'summaries'), cutoffMs);
  report.versionsRemoved = cleanOldVersions(cliDir);
  if (storeRoot) {
    report.goalArtifacts = cleanGoalArtifacts(storeRoot, cutoffMs, { alive, now });
    report.goalHistoryRemoved = cleanGoalHistory(storeRoot, cutoffMs);
    report.runtimeTempsRemoved = cleanRuntimeTemps(storeRoot, now());
  }
  log('maintenance', report);
  return report;
}

module.exports = { runMaintenance, cleanSessionLocks, cleanOldFiles, cleanOldVersions, capSessionDb,
  liveSessionIds, cliDataDirectory, isProcessAlive, isDevinProcessAlive, DEFAULT_RETENTION_DAYS, DEFAULT_MAX_DB_BYTES };
