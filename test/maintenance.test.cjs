'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const maintenance = require('../src/runtime/maintenance.cjs');

function dir(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function seedCli(t) {
  const cli = dir(t, 'maint-cli-');
  for (const name of ['session_locks', 'logs', 'summaries', 'transcripts']) fs.mkdirSync(path.join(cli, name), { recursive: true });
  return cli;
}
function touchOld(file, daysAgo) {
  const time = (Date.now() - daysAgo * 86400000) / 1000;
  fs.utimesSync(file, time, time);
}
function seedDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL);
    CREATE TABLE message_nodes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, chat_message TEXT NOT NULL);
    CREATE TABLE prompt_history (session_id TEXT NOT NULL);`);
  return db;
}
const aliveOf = live => pid => live.has(pid);

test('dead session locks are removed while live ones stay', t => {
  const cli = seedCli(t);
  fs.writeFileSync(path.join(cli, 'session_locks', 'dead-one.lock'), '999999999\n');
  fs.writeFileSync(path.join(cli, 'session_locks', 'live-one.lock'), '888888888\n');
  const live = aliveOf(new Set([888888888]));
  assert.equal(maintenance.cleanSessionLocks(cli, live), 1);
  assert.deepEqual([...maintenance.liveSessionIds(cli, live)], ['live-one']);
  assert.equal(fs.existsSync(path.join(cli, 'session_locks', 'dead-one.lock')), false);
});

test('non-devin pid reuse makes a lock dead', () => {
  const alive = () => true;
  const containerd = () => Buffer.from('/usr/bin/containerd\0');
  const devin = () => Buffer.from('/opt/devin/bin/devin\0acp\0');
  assert.equal(maintenance.isDevinProcessAlive(43268, alive, containerd), false);
  assert.equal(maintenance.isDevinProcessAlive(43268, alive, devin), true);
  assert.equal(maintenance.isDevinProcessAlive(999999, () => false, devin), false);
  assert.equal(maintenance.isDevinProcessAlive(43268, alive, () => { throw new Error('EPERM'); }), true);
});

test('old CLI versions are pruned except the current target', t => {
  const cli = seedCli(t);
  const versions = path.join(cli, '_versions');
  for (const v of ['3000.12.32', '3000.12.57', '3000.14.1']) fs.mkdirSync(path.join(versions, v), { recursive: true });
  fs.symlinkSync('3000.14.1', path.join(versions, 'current'));
  fs.mkdirSync(path.join(versions, '_download'));
  assert.equal(maintenance.cleanOldVersions(cli), 2);
  assert.equal(fs.existsSync(path.join(versions, '3000.14.1')), true);
  assert.equal(fs.existsSync(path.join(versions, '3000.12.32')), false);
});

test('old aux files are removed by mtime, fresh ones kept', t => {
  const cli = seedCli(t);
  const oldLog = path.join(cli, 'logs', 'devin_old.log');
  const newLog = path.join(cli, 'logs', 'devin_new.log');
  fs.writeFileSync(oldLog, 'x'); fs.writeFileSync(newLog, 'x');
  touchOld(oldLog, 10);
  const report = maintenance.runMaintenance({ cliDir: cli, retentionDays: 3, now: () => Date.now(), log: () => {} });
  assert.equal(fs.existsSync(oldLog), false);
  assert.equal(fs.existsSync(newLog), true);
  assert.equal(report.oldLogsRemoved, 1);
});

test('over-cap sessions.db drops oldest sessions but keeps locked and recent ones', t => {
  const cli = seedCli(t);
  const dbFile = path.join(cli, 'sessions.db');
  const db = seedDb(dbFile);
  const nowSec = 2000000000;
  const insert = (id, ageDays, bytes) => {
    db.prepare('INSERT INTO sessions (id, created_at, last_activity_at) VALUES (?, ?, ?)')
      .run(id, nowSec - ageDays * 86400, nowSec - ageDays * 86400);
    db.prepare('INSERT INTO message_nodes (id, session_id, chat_message) VALUES (?, ?, ?)')
      .run(id + '-m', id, 'x'.repeat(bytes));
  };
  insert('ancient', 30, 900 * 1024);
  insert('old', 10, 900 * 1024);
  insert('recent', 1, 900 * 1024);
  insert('locked', 60, 900 * 1024);
  db.close();
  // 放大文件体积触发清理路径：补一个大 blob 让文件 > maxBytes。
  const pad = new DatabaseSync(dbFile);
  pad.exec('CREATE TABLE pad (b BLOB)');
  pad.prepare('INSERT INTO pad (b) VALUES (?)').run(Buffer.alloc(900 * 1024));
  pad.close();
  fs.writeFileSync(path.join(cli, 'session_locks', 'locked.lock'), '42\n');
  const live = aliveOf(new Set([42]));
  const report = maintenance.runMaintenance({ cliDir: cli, retentionDays: 3, maxDbBytes: 1024 * 1024,
    lockAlive: live, log: () => {}, now: () => nowSec * 1000 });
  const check = new DatabaseSync(dbFile);
  const remaining = new Set(check.prepare('SELECT id FROM sessions').all().map(r => r.id));
  const nodes = check.prepare('SELECT COUNT(*) AS n FROM message_nodes').get().n;
  check.close();
  assert.equal(remaining.has('ancient'), false, 'oldest session removed');
  assert.equal(remaining.has('locked'), true, 'live-locked session preserved');
  assert.equal(remaining.has('recent'), true, 'recent session preserved');
  assert.ok(report.sessionDb.sessionsRemoved >= 1);
  assert.ok(nodes <= 2, 'message rows deleted with their sessions');
});

test('BYOK leftovers: dead goal locks, orphan caps and reports removed at startup', t => {
  const storeRoot = dir(t, 'maint-store-');
  const store = require('../src/runtime/goal-store.cjs');
  const goal = {
    schemaVersion: 1, id: 'a'.repeat(32), sessionId: 'session-x', revision: 1,
    objective: 'o', criteria: 'c', status: 'active', runsStarted: 1, maxRuns: 10,
    activeRun: '11111111-2222-4333-8444-555555555555', reason: null, evidence: [], missingRuns: 0,
    lastEvidence: null, repeatCount: 0, createdAt: 1000, updatedAt: 1000, archivedAt: null
  };
  store.writeGoal(storeRoot, goal);
  const goalDir = store.goalRoot(storeRoot);
  const lockDir = store.locksDirectory(storeRoot), capDir = store.capabilitiesDirectory(storeRoot),
    reportDir = store.reportsDirectory(storeRoot);
  for (const d of [lockDir, capDir, reportDir]) fs.mkdirSync(d, { recursive: true });
  // 死锁、损坏锁删除；活锁保留
  fs.writeFileSync(path.join(lockDir, 'dead.lock'), JSON.stringify({ pid: 999999999 }));
  fs.writeFileSync(path.join(lockDir, 'live.lock'), JSON.stringify({ pid: 888888888 }));
  fs.writeFileSync(path.join(lockDir, 'corrupt.lock'), 'not-json');
  // 孤儿 cap（goal 不存在）删除；指向现存 goal 的保留
  const orphanCap = path.join(capDir, 'orphan.json'), liveCap = path.join(capDir, 'live.json');
  fs.writeFileSync(orphanCap, JSON.stringify({ id: 'b'.repeat(32), issuedAt: Date.now() - 4 * 86400000 }));
  fs.writeFileSync(liveCap, JSON.stringify({ id: goal.id, issuedAt: Date.now() }));
  touchOld(orphanCap, 4);
  // 未被 activeRun 引用的旧 report 删除；被引用的保留
  const orphanReport = path.join(reportDir, '99999999-9999-4999-8999-999999999999.json');
  const staleReport = path.join(reportDir, '88888888-8888-4888-8888-888888888888.json');
  const liveReport = path.join(reportDir, goal.activeRun + '.json');
  fs.writeFileSync(orphanReport, '{}'); fs.writeFileSync(staleReport, '{}'); fs.writeFileSync(liveReport, '{}');
  touchOld(orphanReport, 4);
  const twoHoursAgo = (Date.now() - 2 * 3600000) / 1000;
  fs.utimesSync(staleReport, twoHoursAgo, twoHoursAgo);
  // runtime-control 临时文件：旧的删，新的留
  const tempOld = path.join(storeRoot, 'runtime-control.json.old-inst');
  const tempNew = path.join(storeRoot, 'runtime-control.json.new-inst');
  fs.writeFileSync(tempOld, '{}'); fs.writeFileSync(tempNew, '{}');
  touchOld(tempOld, 4);
  const report = maintenance.runMaintenance({ cliDir: seedCli(t), storeRoot, retentionDays: 3,
    lockAlive: aliveOf(new Set([888888888])), alive: aliveOf(new Set([888888888])),
    log: () => {}, now: () => Date.now() });
  assert.equal(fs.existsSync(path.join(lockDir, 'dead.lock')), false);
  assert.equal(fs.existsSync(path.join(lockDir, 'corrupt.lock')), false);
  assert.equal(fs.existsSync(path.join(lockDir, 'live.lock')), true);
  assert.equal(fs.existsSync(orphanCap), false);
  assert.equal(fs.existsSync(liveCap), true);
  assert.equal(fs.existsSync(orphanReport), false);
  assert.equal(fs.existsSync(staleReport), false, 'unreferenced report past grace removed even within retention');
  assert.equal(fs.existsSync(liveReport), true);
  assert.equal(fs.existsSync(tempOld), false);
  assert.equal(fs.existsSync(tempNew), true);
  assert.equal(report.goalArtifacts.locksRemoved, 2);
  assert.equal(report.goalArtifacts.capabilitiesRemoved, 1);
  assert.equal(report.goalArtifacts.reportsRemoved, 2);
  assert.equal(report.runtimeTempsRemoved, 1);
});

test('maintenance never deletes sessions inside the retention window', t => {
  const cli = seedCli(t);
  const dbFile = path.join(cli, 'sessions.db');
  const db = seedDb(dbFile);
  const nowSec = 2000000000;
  db.prepare('INSERT INTO sessions (id, created_at, last_activity_at) VALUES (?, ?, ?)').run('fresh', nowSec - 3600, nowSec - 3600);
  db.prepare('INSERT INTO message_nodes (id, session_id, chat_message) VALUES (?, ?, ?)').run('fresh-m', 'fresh', 'x'.repeat(10));
  db.close();
  const report = maintenance.runMaintenance({ cliDir: cli, retentionDays: 3, maxDbBytes: 1,
    alive: () => false, log: () => {}, now: () => nowSec * 1000 });
  assert.equal(report.sessionDb.sessionsRemoved, 0);
});
