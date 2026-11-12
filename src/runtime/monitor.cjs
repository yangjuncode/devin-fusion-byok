'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const wire = require('../protocol/wire.cjs');
const LIMIT = 5000;
const token = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const timing = value => Number.isFinite(value) && value >= 0 ? value : null;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value) ? value : null;

function usageOf(data, chat) {
  const u = chat ? data?.usage : data?.response?.usage;
  if (!u || typeof u !== 'object') return null;
  return {
    inputTokens: token(chat ? u.prompt_tokens : u.input_tokens),
    outputTokens: token(chat ? u.completion_tokens : u.output_tokens),
    cachedTokens: token((chat ? u.prompt_tokens_details : u.input_tokens_details)?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens),
    cacheWriteTokens: token(u.cache_creation_input_tokens ?? u.prompt_cache_write_tokens ?? (chat ? u.prompt_tokens_details : u.input_tokens_details)?.cache_write_tokens),
    reasoningTokens: token((chat ? u.completion_tokens_details : u.output_tokens_details)?.reasoning_tokens)
  };
}
function semanticOutput(event, chat) {
  const d = event.data;
  if (!d) return { output: false, text: false };
  if (chat) {
    const delta = (d.choices || []).find(c => (c.index ?? 0) === 0)?.delta;
    const text = typeof delta?.content === 'string' && delta.content.length > 0;
    const thinking = [delta?.reasoning_content, delta?.reasoning].some(v => typeof v === 'string' && v.length > 0);
    const tool = delta?.tool_calls?.some(v => v.function?.name || v.function?.arguments);
    return { output: Boolean(text || thinking || tool), text };
  }
  const items = event.type === 'response.completed' ? d.response?.output || [] : event.type === 'response.output_item.done' ? [d.item] : [];
  const text = (event.type === 'response.output_text.delta' && typeof d.delta === 'string' && d.delta.length > 0) ||
    (event.type === 'response.output_text.done' && typeof d.text === 'string' && d.text.length > 0) ||
    items.some(item => item?.type === 'message' && item.content?.some(part => part.type === 'output_text' && part.text));
  const delta = ['response.reasoning.delta', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta'].includes(event.type) && typeof d.delta === 'string' && d.delta.length > 0;
  const tool = (event.type === 'response.output_item.added' && d.item?.type === 'function_call' && Boolean(d.item.name || d.item.arguments)) ||
    items.some(item => item?.type === 'function_call' && (item.name || item.arguments));
  return { output: Boolean(text || delta || tool), text: Boolean(text) };
}
function createTracker({ id, route, provider, now = () => performance.now(), startedAt = new Date().toISOString() }) {
  const start = now();
  let firstOutput = null, firstText = null, firstResponse = null, lastOutput = null, usage = null, complete = false;
  let hasTools = false, hasReasoning = false, terminalAt = null;
  return {
    event(event, chat) {
      const elapsed = now() - start;
      const data = event.data;
      if (data && event.type !== 'done') firstResponse ??= elapsed;
      const choices = chat ? data?.choices || [] : [];
      const choice = choices.find(c => (c.index ?? 0) === 0);
      const delta = choice?.delta;
      const items = chat ? [] : data?.response?.output || (data?.item ? [data.item] : []);
      if (delta?.tool_calls?.length || items.some(item => item?.type === 'function_call') || event.type?.startsWith('response.function_call_arguments.')) hasTools = true;
      if (delta?.reasoning_content || delta?.reasoning || event.type?.startsWith('response.reasoning')) hasReasoning = true;
      if (choice?.finish_reason || ['response.completed', 'response.incomplete'].includes(event.type)) terminalAt ??= elapsed;
      const semantic = semanticOutput(event, chat);
      if (semantic.output) { firstOutput ??= elapsed; lastOutput = elapsed; }
      const textDelta = chat ? typeof delta?.content === 'string' && delta.content.length > 0 : event.type === 'response.output_text.delta' && typeof data?.delta === 'string' && data.delta.length > 0;
      if (textDelta) firstText ??= elapsed;
      const next = usageOf(event.data, chat);
      if (next) {
        usage = next;
        complete = usage.inputTokens !== null && usage.outputTokens !== null;
      }
    },
    finish(status, httpStatus, code = null) {
      const durationMs = Math.max(0, now() - start);
      const visibleTokens = usage?.outputTokens != null && (!hasReasoning || usage?.reasoningTokens != null)
        ? usage.outputTokens - (usage.reasoningTokens ?? 0) : null;
      const decodeMs = firstText !== null && terminalAt > firstText ? terminalAt - firstText : null;
      const tps = status === 'success' && !hasTools && visibleTokens > 0 && decodeMs > 0 ? visibleTokens * 1000 / decodeMs : null;
      return { schemaVersion: 3, firstResponseMs: firstResponse, id, startedAt, model: route.model, providerId: provider.id || route.providerId || '', effort: route.effort || null,
        status, code, httpStatus, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
        cachedTokens: usage?.cachedTokens ?? null, cacheWriteTokens: usage?.cacheWriteTokens ?? null,
        reasoningTokens: usage?.reasoningTokens ?? null,
        firstOutputMs: firstOutput, firstTextMs: firstText, durationMs,
        outputSpanMs: firstOutput !== null && lastOutput > firstOutput ? lastOutput - firstOutput : null,
        tps, decodeMs, visibleTokens, hasTools, hasReasoning,
        throughputTps: status === 'success' && complete && durationMs > 0 ? usage.outputTokens * 1000 / durationMs : null,
        usageComplete: complete };
    }
  };
}
function normalize(record) {
  if (!identifier(record?.id) || !['success', 'error', 'cancelled'].includes(record.status) || !Number.isFinite(Date.parse(record.startedAt))) return null;
  const result = { id: record.id, startedAt: record.startedAt, model: identifier(record.model) || 'unknown',
    providerId: identifier(record.providerId) || '', effort: identifier(record.effort), status: record.status,
    code: identifier(record.code), httpStatus: token(record.httpStatus) ?? 0 };
  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'cacheWriteTokens', 'reasoningTokens']) result[key] = token(record[key]);
  for (const key of ['firstOutputMs', 'firstTextMs', 'durationMs', 'outputSpanMs']) result[key] = timing(record[key]);
  result.schemaVersion = [2, 3].includes(record.schemaVersion) ? record.schemaVersion : 1;
  result.hasTools = result.schemaVersion >= 2 ? record.hasTools === true : null;
  result.hasReasoning = result.schemaVersion >= 2 ? record.hasReasoning === true : null;
  result.decodeMs = result.schemaVersion >= 2 ? timing(record.decodeMs) : null;
  result.visibleTokens = result.schemaVersion >= 2 ? token(record.visibleTokens) : null;
  result.tps = result.schemaVersion >= 2 && result.status === 'success' && result.hasTools === false && result.visibleTokens > 0 && result.decodeMs > 0 ? result.visibleTokens * 1000 / result.decodeMs : null;
  result.throughputTps = result.outputTokens !== null && result.durationMs > 0 ? result.outputTokens * 1000 / result.durationMs : null;
  result.firstResponseMs = result.schemaVersion >= 3 ? timing(record.firstResponseMs) : null;
  const inconsistent = (result.cachedTokens !== null && result.inputTokens !== null && result.cachedTokens > result.inputTokens) ||
    (result.reasoningTokens !== null && result.outputTokens !== null && result.reasoningTokens > result.outputTokens);
  result.usageState = inconsistent ? 'inconsistent' : result.inputTokens !== null && result.outputTokens !== null ? 'complete' :
    ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens'].some(key => result[key] !== null) ? 'partial' : 'missing';
  result.usageComplete = result.usageState === 'complete';
  result.gatewayTps = !inconsistent && result.outputTokens > 0 && result.firstResponseMs !== null && result.durationMs > result.firstResponseMs
    ? result.outputTokens * 1000 / (result.durationMs - result.firstResponseMs) : null;
  if (inconsistent) result.tps = null;
  return result;
}
function summarize(records) {
  const result = { requests: records.length, success: 0, error: 0, cancelled: 0 };
  for (const record of records) result[record.status]++;
  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens']) {
    const values = records.map(r => r[key]).filter(v => v !== null);
    result[key] = { value: values.length ? values.reduce((a, b) => a + b, 0) : null, reported: values.length };
  }
  for (const [key, field] of [['ttftMs', 'firstOutputMs'], ['textTtftMs', 'firstTextMs']]) {
    const values = records.filter(r => r.status === 'success' && r.schemaVersion >= 2).map(r => r[field]).filter(v => v !== null);
    result[key] = { value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, samples: values.length };
  }
  const eligible = records.filter(r => r.schemaVersion >= 2 && r.status === 'success' && timing(r.tps) !== null);
  const latest = eligible.reduce((a, b) => !a || Date.parse(b.startedAt) >= Date.parse(a.startedAt) ? b : a, null);
  result.tps = { value: latest?.tps ?? null, samples: eligible.length };
  const firstResponses = records.map(r => r.firstResponseMs).filter(v => timing(v) !== null);
  result.firstResponseMs = { value: firstResponses.length ? firstResponses.reduce((a, b) => a + b, 0) / firstResponses.length : null, samples: firstResponses.length };
  const gateway = records.filter(r => timing(r.gatewayTps) !== null && r.durationMs > r.firstResponseMs);
  const gatewayDuration = gateway.reduce((n, r) => n + r.durationMs - r.firstResponseMs, 0);
  result.gatewayTps = { value: gatewayDuration > 0 ? gateway.reduce((n, r) => n + r.outputTokens, 0) * 1000 / gatewayDuration : null, samples: gateway.length };
  const throughput = records.filter(r => r.outputTokens !== null && r.durationMs > 0);
  const duration = throughput.reduce((n, r) => n + r.durationMs, 0);
  result.throughputTps = { value: duration > 0 ? throughput.reduce((n, r) => n + r.outputTokens, 0) * 1000 / duration : null, samples: throughput.length };
  return result;
}
const NATIVE_STREAM_MAX = 64 * 1024 * 1024;
// 官方 GetChatMessage 转发请求的被动观测器：不改动任何字节，增量解析
// Connect 帧中公开的字段（1=消息 id，3=正文，4=输出 token，5=结束原因，6=工具调用，
// 7=用量元数据 ModelUsageStats，9=推理，20/23=模型 uid）。
function createNativeTracker({ requestHeaders, requestBody, upstream, modelUid = '', t0, startedAt, now = () => performance.now(), onFinish } = {}) {
  const start = Number.isFinite(t0) ? t0 : now();
  const fallbackId = crypto.randomUUID();
  const contentType = String(upstream?.headers?.['content-type'] || '').toLowerCase();
  const framed = contentType.includes('connect+') || contentType.includes('grpc');
  const gzChunks = /gzip/.test(String(upstream?.headers?.['content-encoding'] || '').toLowerCase()) ? [] : null;
  let pending = Buffer.alloc(0);
  let firstResponse = null, firstText = null, firstOutput = null, lastOutput = null, terminalAt = null;
  let messageId = '', responseModelUid = '', trailerCode = null;
  let hasTools = false, hasReasoning = false, finished = false;
  let metaUsage = null;
  let topLevelOutputTokens = null;

  let uid = identifier(modelUid) || '';
  if (!uid && requestBody) {
    try {
      const format = wire.decode(requestBody, requestHeaders);
      if (Buffer.isBuffer(format.data)) uid = identifier(wire.str(format.data, 21)) || '';
      else if (format.data && typeof format.data === 'object') {
        uid = identifier(format.data.chatModelUid ?? format.data.chat_model_uid ?? format.data.modelUid ?? format.data.model_uid) || '';
      }
    } catch { /* 解析不出模型名时仍记录这次官方调用。 */ }
  }

  function message(buffer) {
    let fields;
    try { fields = wire.parseFields(buffer); } catch { return; }
    const elapsed = now() - start;
    for (const field of fields) {
      if (field.wire === 0) {
        // 顶层 4=delta_tokens 仅为降级口径：BYOK 约定其携带末块输出总量，
        // 官方若逐块增量上报则低估，最终以 7 号 ModelUsageStats 为准。
        if (field.number === 4) {
          const ot = token(field.value);
          if (ot !== null) topLevelOutputTokens = ot;
        }
        continue;
      }
      if (field.wire !== 2) continue;
      if (field.number === 1) { if (!messageId) messageId = identifier(field.value.toString('utf8')) || ''; }
      else if (field.number === 3 && field.value.length) { firstText ??= elapsed; firstOutput ??= elapsed; lastOutput = elapsed; }
      else if (field.number === 9 && field.value.length) { hasReasoning = true; firstOutput ??= elapsed; lastOutput = elapsed; }
      else if (field.number === 6) {
        hasTools = true; firstOutput ??= elapsed; lastOutput = elapsed;
      } else if (field.number === 20 || field.number === 23) {
        responseModelUid = identifier(field.value.toString('utf8')) || responseModelUid;
      } else if (field.number === 7) {
        try {
          // ModelUsageStats 按子字段逐项合并而非整包覆盖：中间帧可能只带
          // 部分计数（如仅 input），末帧补 output 时不能丢掉已读到的值。
          const mf = wire.parseFields(field.value);
          for (const sub of mf) {
            if (sub.wire === 0) {
              const val = token(sub.value);
              if (val === null) continue;
              const key = sub.number === 2 ? 'rawInput' : sub.number === 3 ? 'rawOutput' :
                sub.number === 4 ? 'rawCacheWrite' : sub.number === 5 ? 'rawCached' : null;
              if (key) (metaUsage ||= {})[key] = val;
            } else if (sub.wire === 2 && sub.number === 9) {
              const m = identifier(sub.value.toString('utf8'));
              if (m) responseModelUid = m;
            }
          }
        } catch { /* 忽略损坏的 metadata */ }
      }
    }
  }

  function drain() {
    while (pending.length >= 5) {
      const length = pending.readUInt32BE(1);
      if (pending.length < 5 + length) return;
      const flags = pending[0];
      const part = pending.subarray(5, 5 + length);
      pending = pending.subarray(5 + length);
      if (flags & 2) {
        try { const code = JSON.parse(part.toString('utf8'))?.error?.code; if (identifier(code)) trailerCode = code; } catch {}
        continue;
      }
      let body = part;
      if (flags & 1) { try { body = zlib.gunzipSync(body, { maxOutputLength: NATIVE_STREAM_MAX }); } catch { continue; } }
      message(body);
    }
  }

  function data(chunk) {
    if (finished) return;
    if (firstResponse === null) firstResponse = now() - start;
    if (gzChunks) { gzChunks.push(Buffer.from(chunk)); return; }
    if (!framed) return;
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    if (pending.length > NATIVE_STREAM_MAX) { pending = Buffer.alloc(0); return; }
    drain();
  }

  function finish(state, httpStatus) {
    if (finished) return null;
    finished = true;
    terminalAt = now() - start;
    if (gzChunks?.length) {
      try {
        pending = zlib.gunzipSync(Buffer.concat(gzChunks), { maxOutputLength: NATIVE_STREAM_MAX });
        if (framed) drain(); else message(pending);
      } catch { /* 解压失败只丢失字段解析，不影响状态与耗时。 */ }
    }
    const status = state === 'abort' ? 'cancelled' : state === 'end' && (httpStatus || 200) < 400 ? 'success' : 'error';
    const code = status === 'success' ? null : state === 'abort' ? 'client_cancelled' : trailerCode || (httpStatus >= 400 ? 'official_http' : 'upstream_stream');
    const durationMs = Math.max(0, terminalAt);

    const cachedTokens = metaUsage?.rawCached ?? null;
    const cacheWriteTokens = metaUsage?.rawCacheWrite ?? null;
    let inputTokens = null;
    if (metaUsage?.rawInput !== null && metaUsage?.rawInput !== undefined) {
      inputTokens = metaUsage.rawInput + (cachedTokens ?? 0);
    } else if (cachedTokens !== null) {
      inputTokens = cachedTokens;
    }
    const outputTokens = metaUsage?.rawOutput ?? topLevelOutputTokens ?? null;
    const reasoningTokens = null;
    const visibleTokens = outputTokens !== null && !hasReasoning ? outputTokens : null;
    const decodeMs = firstText !== null && terminalAt > firstText ? terminalAt - firstText : null;
    const tps = status === 'success' && !hasTools && visibleTokens > 0 && decodeMs > 0 ? visibleTokens * 1000 / decodeMs : null;
    const throughputTps = status === 'success' && outputTokens !== null && durationMs > 0 ? outputTokens * 1000 / durationMs : null;
    const usageComplete = inputTokens !== null && outputTokens !== null;

    const record = { schemaVersion: 3, id: messageId || fallbackId, startedAt: startedAt || new Date().toISOString(),
      model: uid || responseModelUid || 'official', providerId: 'official', effort: null,
      status, code, httpStatus: httpStatus || 0, firstResponseMs: firstResponse, firstOutputMs: firstOutput, firstTextMs: firstText,
      durationMs,
      outputSpanMs: firstOutput !== null && lastOutput > firstOutput ? lastOutput - firstOutput : null,
      inputTokens, outputTokens, cachedTokens, cacheWriteTokens, reasoningTokens,
      tps, decodeMs, visibleTokens, throughputTps, usageComplete,
      hasTools, hasReasoning };
    try { onFinish?.(record); } catch { /* 统计失败不影响转发。 */ }
    return record;
  }
  return { data, finish };
}

// 会话归属查询已移除：sessions.db / acp-messages 的全表扫描在历史数据量大时
// 会打满 CPU，且面板不再按会话筛选。记录统一记为未归属，用量统计不受影响。
function createMonitor({ root, retentionDays } = {}) {
  const file = path.join(root, 'monitor.jsonl');
  const instanceNonce = crypto.randomBytes(4).toString('hex');
  // 历史保留期（天）：默认 7 天。retentionDays 可以是函数，快照时重新解析，
  // 面板里改配置无需重启后端即生效；非法值回退默认。
  const resolveDays = typeof retentionDays === 'function' ? retentionDays : () => retentionDays;
  const normalizeDays = value => { const days = Number(value); return Number.isFinite(days) && days > 0 ? days : 7; };
  let retentionDayCount = normalizeDays(resolveDays());
  const rewriteAll = list => {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, list.map(r => JSON.stringify(r)).join('\n') + (list.length ? '\n' : ''), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  };
  let records = [], storageError = false, pending = null, cached = null, cachedAt = 0, revision = 0;
  // 按当前保留期裁剪记录并重写文件；有记录被裁掉时递增 revision 使快照缓存失效。
  const purgeExpired = () => {
    const cutoff = Date.now() - retentionDayCount * 86400 * 1000;
    const kept = records.filter(r => Date.parse(r.startedAt) >= cutoff);
    if (kept.length === records.length) return;
    records = kept; revision++;
    try { rewriteAll(records); } catch { storageError = true; }
  };
  try {
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('monitor_size');
      let dirty = false;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try { const record = normalize(JSON.parse(line)); if (record) records.push(record); else dirty = true; } catch { dirty = true; }
      }
      records = [...new Map(records.map(r => [r.id, r])).values()].slice(-LIMIT);
      // 启动时按保留期裁剪历史并顺带清除无法解析的行，避免 monitor.jsonl 无限增长。
      purgeExpired();
      if (dirty) { try { rewriteAll(records); } catch { storageError = true; } }
    }
    // 旧版本的会话归属缓存已随归属查询一并移除。
    fs.rmSync(path.join(root, 'monitor-sessions.json'), { force: true });
  } catch { storageError = true; }
  function record(data) {
    const value = normalize(data);
    if (!value || records.some(r => r.id === value.id)) return;
    records.push(value); records = records.slice(-LIMIT); revision++;
    try {
      if (records.length === LIMIT) rewriteAll(records);
      else { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.appendFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 }); }
    } catch { storageError = true; }
  }
  async function snapshot() {
    // 保留天数支持动态配置：每次快照重新解析，改动后自动裁剪并使缓存失效。
    const days = normalizeDays(resolveDays());
    if (days !== retentionDayCount) { retentionDayCount = days; purgeExpired(); }
    if (pending) return pending;
    if (cached && Date.now() - cachedAt < 15000 && cached.revision === revision) return cached.value;
    const current = records.slice(), currentRevision = revision;
    pending = (async () => {
      const value = { version: 1, status: storageError ? 'degraded' : 'ready', storageError,
        retentionLimit: LIMIT, retentionDays: retentionDayCount, revision: currentRevision + ':' + instanceNonce,
        records: current.slice().reverse(), summary: null };
      value.summary = summarize(value.records);
      cached = { revision: currentRevision, value }; cachedAt = Date.now(); return value;
    })().finally(() => { pending = null; });
    return pending;
  }
  return { record, snapshot, close() {} };
}
module.exports = { createMonitor, createTracker, createNativeTracker, usageOf, summarize };
