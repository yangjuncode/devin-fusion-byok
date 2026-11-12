'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wire = require('../src/protocol/wire.cjs');
const { createMonitor, createTracker, createNativeTracker, usageOf, summarize } = require('../src/runtime/monitor.cjs');
function tracker() {
  let clock = 0;
  const value = createTracker({ id: 'response-1', route: { model: 'test' }, provider: { id: 'p', apiKey: 'SECRET' }, now: () => clock });
  return { value, at: n => { clock = n; } };
}
test('usage separates subset counters, zero and missing; never accumulates repeated usage', () => {
  assert.deepEqual(usageOf({ usage: { prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 80 } } }, true), { inputTokens: 100, outputTokens: 0, cachedTokens: 80, cacheWriteTokens: null, reasoningTokens: null });
  assert.equal(usageOf({}, true), null);
  const t = tracker();
  t.at(100); t.value.event({ data: { choices: [{ delta: { reasoning_content: 'think' } }] } }, true);
  t.at(500); t.value.event({ data: { choices: [{ delta: { content: 'hello' } }] } }, true);
  const event = { type: 'response.completed', data: { response: { usage: { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 10 } } } } };
  t.at(1000); t.value.event(event, false); t.value.event(event, false);
  t.at(1000); const record = t.value.finish('success', 200);
  assert.equal(record.firstOutputMs, 100); assert.equal(record.firstTextMs, 500);
  assert.equal(record.tps, 20); assert.equal(record.outputTokens, 20);
  assert.equal(record.reasoningTokens, 10); assert.equal(record.usageComplete, true);
  assert.ok(!JSON.stringify(record).includes('SECRET')); assert.ok(!JSON.stringify(record).includes('PRIVATE'));
});
test('empty events do not count as output; tool-only and cancellation are explicit', () => {
  const t = tracker(); t.at(10); t.value.event({ data: { choices: [{ delta: { role: 'assistant', content: '' } }] } }, true);
  t.at(20); t.value.event({ type: 'response.function_call_arguments.delta', data: { delta: '{}' } }, false);
  t.at(30); const record = t.value.finish('cancelled', 200);
  assert.equal(record.firstOutputMs, 20); assert.equal(record.firstTextMs, null);
  assert.equal(record.tps, null); assert.equal(record.inputTokens, null); assert.equal(record.usageComplete, false);
});
test('aggregate TPS is ratio of sums and unknown counts are not zeros', () => {
  const base = tracker().value.finish('success', 200);
  const summary = summarize([{ ...base, outputTokens: 10, durationMs: 1000, tps: 10 }, { ...base, outputTokens: 90, durationMs: 3000, tps: 30 }, { ...base, status: 'cancelled' }]);
  assert.deepEqual(summary.tps, { value: 30, samples: 2 });
  assert.deepEqual(summary.throughputTps, { value: 25, samples: 2 });
  assert.deepEqual(summary.outputTokens, { value: 100, reported: 2 });
  assert.deepEqual(summary.inputTokens, { value: null, reported: 0 });
  assert.equal(summary.requests, 3); assert.equal(summary.cancelled, 1);
});
test('DeepSeek cache alias, tool-bearing output, done-only text and failed samples stay honest', () => {
  assert.equal(usageOf({ usage: { prompt_cache_hit_tokens: 80 } }, true).cachedTokens, 80);
  const t = tracker();
  t.at(100); t.value.event({ type: 'response.output_text.delta', data: { delta: 'hello' } }, false);
  t.at(200); t.value.event({ type: 'response.output_item.added', data: { item: { type: 'function_call', call_id: 'tool-1', name: 'exec' } } }, false);
  t.at(1000); t.value.event({ type: 'response.completed', data: { response: { usage: { input_tokens: 20, output_tokens: 30 } } } }, false);
  const record = t.value.finish('success', 200);
  assert.equal(record.tps, null); assert.equal(record.throughputTps, 30);
  const doneOnly = tracker(); doneOnly.at(500);
  doneOnly.value.event({ type: 'response.completed', data: { response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }], usage: { output_tokens: 5 } } } }, false);
  assert.equal(doneOnly.value.finish('success', 200).tps, null);
  assert.equal(doneOnly.value.finish('success', 200).firstTextMs, null);
  const summary = summarize([{ ...record, status: 'cancelled' }]);
  assert.equal(summary.textTtftMs.value, null); assert.equal(summary.ttftMs.samples, 0);
});

test('gateway timing includes metadata, tools and canceled usage; snapshots replace rather than merge', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-metrics-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tracked = tracker();
  tracked.at(50); tracked.value.event({ type: 'done' }, true);
  tracked.at(100); tracked.value.event({ data: { choices: [{ delta: { role: 'assistant' } }] } }, true);
  tracked.at(200); tracked.value.event({ data: { choices: [{ delta: { tool_calls: [{ id: 'call-a', function: { name: 'exec', arguments: '{}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 80 } } } }, true);
  tracked.at(500); tracked.value.event({ data: { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } } }, true);
  tracked.at(1100);
  const monitor = createMonitor({ root });
  monitor.record(tracked.value.finish('cancelled', 200));
  const snapshot = await monitor.snapshot();
  const r = snapshot.records[0];
  assert.equal(r.firstResponseMs, 100); assert.equal(r.firstOutputMs, 200);
  assert.equal(r.gatewayTps, 20); assert.equal(r.tps, null);
  assert.equal(r.usageState, 'complete'); assert.equal(r.cachedTokens, null);
  assert.equal(r.status, 'cancelled'); assert.equal(snapshot.summary.gatewayTps.value, 20);
  assert.equal(snapshot.summary.firstResponseMs.value, 100);
  monitor.record({ ...r, id: 'legacy', schemaVersion: 2 });
  monitor.record({ ...r, id: 'bad', cachedTokens: 200 });
  const next = await monitor.snapshot();
  assert.equal(next.records.find(v => v.id === 'legacy').gatewayTps, null);
  assert.equal(next.records.find(v => v.id === 'legacy').firstResponseMs, null);
  assert.equal(next.records.find(v => v.id === 'bad').usageState, 'inconsistent');
  assert.equal(next.records.find(v => v.id === 'bad').gatewayTps, null);
});

test('persists private-safe records and survives restart without session lookup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-monitor-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const monitor = createMonitor({ root });
  const record = tracker().value.finish('success', 200);
  monitor.record({ ...record, secret: 'SECRET' }); monitor.record(record);
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].id, 'response-1');
  assert.ok(!('sessionId' in snapshot.records[0]) && !('attribution' in snapshot.records[0]));
  assert.ok(!JSON.stringify(snapshot).includes('messageIds'));
  const file = path.join(root, 'monitor.jsonl');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.ok(!fs.readFileSync(file, 'utf8').includes('SECRET'));
  const restarted = await createMonitor({ root }).snapshot();
  assert.equal(restarted.records.length, 1);
  assert.equal(restarted.records[0].id, 'response-1');
});

test('startup retention drops records older than the configured window', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-monitor-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'monitor.jsonl');
  const old = { ...tracker().value.finish('success', 200), id: 'old-record', startedAt: new Date(Date.now() - 10 * 86400 * 1000).toISOString() };
  const recent = { ...tracker().value.finish('success', 200), id: 'recent-record' };
  fs.writeFileSync(file, [old, recent].map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  const monitor = createMonitor({ root });
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].id, 'recent-record');
  assert.equal(snapshot.retentionDays, 7);
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l).id), ['recent-record'],
    'monitor.jsonl 被重写为仅保留窗口内记录');
  // 自定义保留期：1 天窗口同样裁掉 10 天前的记录；非法值回退默认 7 天。
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-monitor-test-'));
  t.after(() => fs.rmSync(root2, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root2, 'monitor.jsonl'), [old, recent].map(r => JSON.stringify(r)).join('\n') + '\n');
  const custom = await createMonitor({ root: root2, retentionDays: 1 }).snapshot();
  assert.equal(custom.retentionDays, 1);
  assert.equal(custom.records.length, 1);
  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-monitor-test-'));
  t.after(() => fs.rmSync(root3, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root3, 'monitor.jsonl'), JSON.stringify(old) + '\n');
  const fallback = await createMonitor({ root: root3, retentionDays: 'forever' }).snapshot();
  assert.equal(fallback.retentionDays, 7);
  assert.equal(fallback.records.length, 0, '非法保留期按默认 7 天处理并清理');
  // 动态保留期：getter 返回值变化后，下一次快照按新窗口裁剪并重写文件。
  const root4 = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-monitor-test-'));
  t.after(() => fs.rmSync(root4, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root4, 'monitor.jsonl'), [old, recent].map(r => JSON.stringify(r)).join('\n') + '\n');
  let days = 30;
  const dynamic = createMonitor({ root: root4, retentionDays: () => days });
  assert.equal((await dynamic.snapshot()).records.length, 2, '30 天窗口保留两条');
  days = 1;
  const shrunk = await dynamic.snapshot();
  assert.equal(shrunk.retentionDays, 1);
  assert.equal(shrunk.records.length, 1);
  assert.equal(shrunk.records[0].id, 'recent-record');
  assert.deepEqual(fs.readFileSync(path.join(root4, 'monitor.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).id), ['recent-record'],
    '缩短保留期后文件同步重写');
});

test('native tracker parses forwarded chat frames and keeps the response message id', () => {
  const { textChunk, toolChunk, stopChunk } = require('../src/protocol/chat.cjs');
  let record = null;
  const tracker = createNativeTracker({
    upstream: { statusCode: 200, headers: { 'content-type': 'application/connect+proto' } },
    requestHeaders: { 'content-type': 'application/proto' },
    requestBody: wire.s(21, 'swe-2-max'),
    onFinish: r => { record = r; },
  });
  const stream = Buffer.concat([
    wire.frame(textChunk('msg-9', 'hello')),
    wire.frame(toolChunk('msg-9', [{ id: 'call-1', name: 'exec', arguments: '{}' }])),
    wire.frame(stopChunk('msg-9', 10, 'swe-2-max', { inputTokens: 165141, outputTokens: 1348, cachedTokens: 164864 })),
    wire.frame(Buffer.from('{}'), 2),
  ]);
  tracker.data(stream.subarray(0, 3));
  tracker.data(stream.subarray(3, 20));
  tracker.data(stream.subarray(20));
  const result = tracker.finish('end', 200);
  assert.equal(record, result);
  assert.equal(result.id, 'msg-9');
  assert.equal(result.model, 'swe-2-max');
  assert.equal(result.providerId, 'official');
  assert.equal(result.status, 'success');
  assert.equal(result.hasTools, true);
  assert.equal(result.httpStatus, 200);
  // field 7 ModelUsageStats 解码回来：面板口径输入含缓存（input+cache_read）
  assert.equal(result.inputTokens, 165141);
  assert.equal(result.outputTokens, 1348);
  assert.equal(result.cachedTokens, 164864);
  assert.ok(result.durationMs >= 0 && result.firstResponseMs !== null && result.firstTextMs !== null);
});


test('native tracker parses official token usage (input, output, cache read/write) from Connect-RPC stream', async t => {
  const { textChunk, stopChunk } = require('../src/protocol/chat.cjs');
  let clock = 1000;
  const now = () => clock;
  const tracker = createNativeTracker({
    upstream: { statusCode: 200, headers: { 'content-type': 'application/connect+proto' } },
    now,
    t0: 1000,
  });

  clock = 1100;
  tracker.data(wire.frame(textChunk('msg-official-1', 'Hello user')));

  clock = 1300;
  // stopChunk encodes Tag 7 ModelUsageStats with:
  // freshInput = inputTokens - cachedTokens = 1500 - 300 = 1200
  // completion = outputTokens = 150
  // cacheWrite = cacheWriteTokens = 80
  // cacheRead = cachedTokens = 300
  const stop = stopChunk('msg-official-1', 2, 'claude-3-7-sonnet', {
    inputTokens: 1500,
    outputTokens: 150,
    cachedTokens: 300,
    cacheWriteTokens: 80,
  });
  tracker.data(wire.frame(stop));

  clock = 1500;
  const result = tracker.finish('end', 200);
  assert.equal(result.id, 'msg-official-1');
  assert.equal(result.model, 'claude-3-7-sonnet');
  assert.equal(result.providerId, 'official');
  assert.equal(result.status, 'success');
  assert.equal(result.inputTokens, 1500);
  assert.equal(result.outputTokens, 150);
  assert.equal(result.cachedTokens, 300);
  assert.equal(result.cacheWriteTokens, 80);
  assert.equal(result.usageComplete, true);
  assert.equal(result.reasoningTokens, null);
  assert.equal(result.visibleTokens, 150);
  assert.equal(result.firstResponseMs, 100);
  assert.equal(result.firstTextMs, 100);
  assert.equal(result.durationMs, 500);
  assert.equal(result.throughputTps, 300); // 150 tokens / 0.5s = 300 TPS

  // Normalization through createMonitor
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'official-monitor-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const monitor = createMonitor({ root });
  monitor.record(result);
  const snap = await monitor.snapshot();
  assert.equal(snap.records.length, 1);
  const rec = snap.records[0];
  assert.equal(rec.inputTokens, 1500);
  assert.equal(rec.outputTokens, 150);
  assert.equal(rec.cachedTokens, 300);
  assert.equal(rec.usageState, 'complete');
  assert.equal(rec.usageComplete, true);
  // gatewayTps = 150 * 1000 / (500 - 100) = 375
  assert.equal(rec.gatewayTps, 375);
  assert.equal(snap.summary.inputTokens.value, 1500);
  assert.equal(snap.summary.outputTokens.value, 150);
  assert.equal(snap.summary.cachedTokens.value, 300);
});

test('native tracker parses official usage with fresh prompt only (no cached tokens) and fallback output tokens', () => {
  // Construct raw Protobuf GetChatMessageResponse chunk:
  // Tag 1 (msg id) = "msg-direct"
  // Tag 4 (varint delta_tokens) = 42
  // Tag 7 (metadata sub-message) with tag 2 (input=250), tag 3 (output=42), tag 9 (model="gpt-5-max")
  const stats = Buffer.concat([
    wire.v(2, 250),
    wire.v(3, 42),
    wire.s(9, 'gpt-5-max'),
  ]);
  const chunk = Buffer.concat([
    wire.s(1, 'msg-direct'),
    wire.v(4, 42),
    wire.m(7, stats),
  ]);
  const tracker = createNativeTracker({
    upstream: { statusCode: 200, headers: { 'content-type': 'application/connect+proto' } },
  });
  tracker.data(wire.frame(chunk));
  const result = tracker.finish('end', 200);
  assert.equal(result.id, 'msg-direct');
  assert.equal(result.model, 'gpt-5-max');
  assert.equal(result.inputTokens, 250);
  assert.equal(result.outputTokens, 42);
  assert.equal(result.cachedTokens, null);
  assert.equal(result.usageComplete, true);
});

test('native tracker falls back to top-level delta_tokens when field 7 is absent', () => {
  // 只有顶层 Tag 4 (delta_tokens)、没有 Tag 7 元数据的帧：输出量应降级取顶层值，
  // 输入缺失则 usageComplete 为 false（用量记为 partial/missing，而非编造输入）。
  const chunk = Buffer.concat([wire.s(1, 'msg-delta-only'), wire.v(4, 33)]);
  const tracker = createNativeTracker({
    upstream: { statusCode: 200, headers: { 'content-type': 'application/connect+proto' } },
  });
  tracker.data(wire.frame(chunk));
  const result = tracker.finish('end', 200);
  assert.equal(result.id, 'msg-delta-only');
  assert.equal(result.outputTokens, 33);
  assert.equal(result.inputTokens, null);
  assert.equal(result.cachedTokens, null);
  assert.equal(result.usageComplete, false);
});

test('native tracker merges ModelUsageStats subfields across frames instead of replacing', () => {
  // 中间帧的 #7 只带 input，末帧的 #7 只带 output 与缓存读：逐字段合并应
  // 保留 input，而不是被后一个不含 input 的 #7 整包覆盖。
  const tracker = createNativeTracker({
    upstream: { statusCode: 200, headers: { 'content-type': 'application/connect+proto' } },
  });
  tracker.data(wire.frame(Buffer.concat([
    wire.s(1, 'msg-merged'),
    wire.m(7, wire.v(2, 500)),
  ])));
  tracker.data(wire.frame(Buffer.concat([
    wire.s(1, 'msg-merged'),
    wire.m(7, Buffer.concat([wire.v(3, 60), wire.v(5, 20)])),
  ])));
  const result = tracker.finish('end', 200);
  assert.equal(result.id, 'msg-merged');
  assert.equal(result.inputTokens, 520);   // fresh 500 + cache_read 20
  assert.equal(result.outputTokens, 60);
  assert.equal(result.cachedTokens, 20);
  assert.equal(result.usageComplete, true);
});

test('native tracker falls back to stream uid and marks aborts cancelled', () => {
  const { stopChunk } = require('../src/protocol/chat.cjs');
  const tracker = createNativeTracker({
    upstream: { statusCode: 200, headers: { 'content-type': 'application/connect+proto' } },
  });
  tracker.data(wire.frame(stopChunk('m2', 2, 'gpt-5-6-sol-high')));
  const aborted = tracker.finish('abort', 200);
  assert.equal(aborted.status, 'cancelled');
  assert.equal(aborted.code, 'client_cancelled');
  assert.equal(aborted.model, 'gpt-5-6-sol-high');
  const tracker2 = createNativeTracker({ upstream: { statusCode: 429, headers: {} } });
  const failed = tracker2.finish('end', 429);
  assert.equal(failed.status, 'error');
  assert.equal(failed.code, 'official_http');
  assert.equal(failed.model, 'official');
});
