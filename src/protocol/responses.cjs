'use strict';

const { randomUUID } = require('node:crypto');
const { frame } = require('./wire.cjs');
const { textChunk, thinkingChunk, toolChunk, stopChunk } = require('./chat.cjs');
const { isCodex, applyCodexRequiredFields, codexHeaders } = require('./codex.cjs');
const { createTracker, usageOf } = require('../runtime/monitor.cjs');
const MAX_SSE_BUFFER = 64 * 1024 * 1024;

function isChatFormat(format = '') { return /chat[-_\/]?completions|^(?:chat|openai)$/.test(format); }
// Codex 解锁目标始终走 Responses 契约（wireApi），不能按 apiFormat 分发到
// chat/completions——那会丢掉 unlock 必需字段，被网关 503。
function useChat(provider) { return !isCodex(provider) && isChatFormat(provider.apiFormat); }
function endpoint(provider) {
  const url = new URL(provider.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid provider URL');
  const chat = useChat(provider);
  url.pathname = url.pathname.replace(/\/(responses|chat\/completions)\/?$/, '').replace(/\/$/, '') + (chat ? '/chat/completions' : '/responses');
  url.search = '';
  url.hash = '';
  return { url, chat };
}

function contentOf(message, chat) {
  if (!message.images?.length) return message.content;
  const parts = [];
  if (message.content !== '') parts.push(chat ? { type: 'text', text: message.content } : { type: 'input_text', text: message.content });
  for (const image of message.images) {
    const url = `data:${image.mimeType};base64,${image.base64}`;
    parts.push(chat ? { type: 'image_url', image_url: { url } } : { type: 'input_image', image_url: url });
    if (image.caption) parts.push(chat ? { type: 'text', text: image.caption } : { type: 'input_text', text: image.caption });
  }
  return parts;
}

function buildRequestBody(request, route, provider) {
  const chat = useChat(provider);
  const messages = [];
  if (request.systemPrompt !== '') messages.push({ role: chat ? 'system' : 'developer', content: request.systemPrompt });
  for (const message of request.messages) {
    if (message.role === 'tool') {
      messages.push(chat ? { role: 'tool', tool_call_id: message.toolCallId, content: message.content } : { type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      continue;
    }
    const content = contentOf(message, chat);
    if (chat) {
      const item = { role: message.role, content };
      if (message.toolCalls?.length) item.tool_calls = message.toolCalls.map(tool => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }));
      messages.push(item);
    } else {
      // A native message stores text before its repeated tool calls. Preserve
      // that sequence and keep every system message at its original position.
      if (content !== '' || !message.toolCalls?.length) messages.push({ role: message.role === 'system' ? 'developer' : message.role, content });
      for (const tool of message.toolCalls || []) messages.push({ type: 'function_call', call_id: tool.id, name: tool.name, arguments: tool.arguments });
    }
  }
  const body = { model: route.model, [chat ? 'messages' : 'input']: messages, stream: true };
  if (chat) body.stream_options = { include_usage: true };
  const maxTokens = request.maxTokens ?? route.maxOutputTokens ?? route.maxTokens ?? provider.maxOutputTokens ?? provider.maxTokens;
  // Codex CLI 不发送 max_output_tokens，Responses Lite 契约同样不带。
  if (!isCodex(provider) && Number.isSafeInteger(maxTokens) && maxTokens > 0) body[chat ? 'max_completion_tokens' : 'max_output_tokens'] = maxTokens;
  if (route.effort) {
    if (chat) body.reasoning_effort = route.effort;
    else body.reasoning = { effort: route.effort, ...(route.effort === 'none' ? {} : { summary: 'auto' }) };
  }
  if (request.tools?.length) {
    body.tools = request.tools.map(tool => chat ? { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } } : { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters });
    const choice = request.toolChoice;
    if (choice?.name) body.tool_choice = chat ? { type: 'function', function: { name: choice.name } } : { type: 'function', name: choice.name };
    else if (choice) {
      const type = typeof choice === 'string' ? choice : choice.type;
      if (['auto', 'none', 'required', 'any'].includes(type)) body.tool_choice = type === 'any' ? 'required' : type;
    }
  }
  // Codex 专线渠道校验 Responses Lite 契约字段，缺省会被网关 503。
  if (isCodex(provider)) applyCodexRequiredFields(body);
  return body;
}

function parseEvent(raw) {
  let event = '';
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  const joined = data.join('\n');
  if (joined.trim() === '[DONE]') return { type: 'done' };
  let value;
  try {
    value = JSON.parse(joined);
  } catch {
    const err = new Error('Invalid SSE event JSON');
    err.code = 'upstream_invalid_json';
    throw err;
  }
  return { type: value.type || event, data: value };
}

async function* events(body) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > MAX_SSE_BUFFER) {
      const err = new Error('SSE frame too large');
      err.code = 'upstream_content_type';
      throw err;
    }
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const event = parseEvent(raw);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const event = parseEvent(buffer); if (event) yield event; }
}

function processor(id, uid, chat, emit) {
  const calls = new Map();
  const itemIndexes = new Map();
  const texts = new Map();
  let terminal = false;
  let reason = 2;
  let finished = false;
  let usage = null;
  const getCall = (index, itemId) => {
    const key = index ?? itemIndexes.get(itemId) ?? itemId;
    if (key === undefined) {
      const err = new Error('Tool call has no index');
      err.code = 'upstream_invalid_tool';
      throw err;
    }
    if (itemId) itemIndexes.set(itemId, key);
    if (!calls.has(key)) calls.set(key, { id: '', name: '', arguments: '', complete: undefined });
    return calls.get(key);
  };
  const text = async (key, value, complete = false, thinking = false) => {
    if (typeof value !== 'string') return;
    const previous = texts.get(key) || '';
    if (complete && !value.startsWith(previous)) {
      const err = new Error('Inconsistent completed text');
      err.code = 'upstream_invalid_json';
      throw err;
    }
    const delta = complete ? value.slice(previous.length) : value;
    texts.set(key, complete ? value : previous + value);
    if (delta) await emit(thinking ? thinkingChunk(id, delta) : textChunk(id, delta), thinking);
  };
  const item = async (value, index, done) => {
    if (value.type === 'function_call') {
      const call = getCall(index, value.id);
      if (value.call_id || value.id) call.id = value.call_id || value.id;
      if (value.name) call.name = value.name;
      if (typeof value.arguments === 'string' && (done || value.arguments)) {
        if (done) call.complete = value.arguments;
        else call.arguments = value.arguments;
      }
    } else if (done && value.type === 'message') {
      for (const [contentIndex, part] of (value.content || []).entries()) {
        if (part.type === 'output_text') await text(`${index}:${contentIndex}`, part.text, true);
      }
    }
  };
  return {
    get terminal() { return terminal; },
    async event(event) {
      if (finished) return;
      const data = event.data;
      if (event.type === 'done') {
        if (!terminal && chat) terminal = true;
        return;
      }
      if (!data || data.error) {
        const err = new Error('Upstream stream error');
        err.code = 'upstream_stream_error';
        const status = streamErrorStatus(data);
        if (status) err.upstreamStatus = status;
        throw err;
      }
      const next = usageOf(data, chat);
      if (next) usage = next;
      if (chat) {
        for (const choice of data.choices || []) {
          if ((choice.index ?? 0) !== 0) continue;
          const delta = choice.delta || choice.message || {};
          if (delta.content) await text('chat', delta.content);
          if (delta.reasoning_content || delta.reasoning) await text('reasoning', delta.reasoning_content || delta.reasoning, false, true);
          for (const tool of delta.tool_calls || []) {
            const call = getCall(tool.index ?? 0);
            if (tool.id) call.id += tool.id;
            if (tool.function?.name) call.name += tool.function.name;
            if (typeof tool.function?.arguments === 'string') call.arguments += tool.function.arguments;
          }
          if (choice.finish_reason) {
            terminal = true;
            reason = choice.finish_reason === 'length' ? 3 : choice.finish_reason === 'content_filter' ? 11 : 2;
          }
        }
        return;
      }
      switch (event.type) {
        case 'response.output_item.added': await item(data.item, data.output_index, false); break;
        case 'response.output_item.done': await item(data.item, data.output_index, true); break;
        case 'response.function_call_arguments.delta': getCall(data.output_index, data.item_id).arguments += data.delta || ''; break;
        case 'response.function_call_arguments.done': getCall(data.output_index, data.item_id).complete = data.arguments; break;
        case 'response.output_text.delta': await text(`${data.output_index ?? 0}:${data.content_index ?? 0}`, data.delta); break;
        case 'response.output_text.done': await text(`${data.output_index ?? 0}:${data.content_index ?? 0}`, data.text, true); break;
        case 'response.reasoning.delta':
        case 'response.reasoning_summary_text.delta': await text(`reasoning:${data.output_index ?? 0}:${data.summary_index ?? 0}`, data.delta, false, true); break;
        case 'response.completed':
          if (data.response?.status && data.response.status !== 'completed') {
            const err = new Error('Unexpected completion status');
            err.code = 'upstream_stream_error';
            const status = streamErrorStatus(data);
            if (status) err.upstreamStatus = status;
            throw err;
          }
          for (const [index, value] of (data.response?.output || []).entries()) await item(value, index, true);
          terminal = true;
          break;
        case 'response.incomplete': terminal = true; reason = 3; break;
        case 'response.failed':
        case 'error': {
          const err = new Error('Upstream response failed');
          err.code = 'upstream_stream_error';
          const status = streamErrorStatus(data);
          if (status) err.upstreamStatus = status;
          throw err;
        }
      }
    },
    async finish() {
      if (finished) return [];
      if (!terminal) {
        const err = new Error('Upstream stream ended without completion');
        err.code = 'upstream_stream_incomplete';
        throw err;
      }
      const tools = [];
      const orderedCalls = [...calls.entries()].sort(([left], [right]) => typeof left === 'number' && typeof right === 'number' ? left - right : 0);
      if (reason === 2) for (const [, call] of orderedCalls) {
        const args = call.complete ?? call.arguments;
        if (!call.name || !call.id || typeof args !== 'string') {
          const err = new Error('Incomplete tool call');
          err.code = 'upstream_invalid_tool';
          throw err;
        }
        try {
          JSON.parse(args); // Validate once, then forward the original JSON bytes.
        } catch {
          const err = new Error('Invalid tool call JSON');
          err.code = 'upstream_invalid_tool';
          throw err;
        }
        tools.push({ id: call.id, name: call.name, arguments: args });
      }
      if (tools.length) await emit(toolChunk(id, tools));
      await emit(stopChunk(id, tools.length ? 10 : reason, uid, usage));
      finished = true;
      return tools.map(tool => tool.name);
    },
  };
}

// 上游临时错误的可重试判定：与 auto-continue 的 TRANSIENT_HTTP_RE 口径一致，
// 4xx 中只有 408/429 值得重试，其余视为确定性失败。
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);
// 网关把上游失败塞进 SSE error 事件时，HTTP 状态常被替换成字符串错误码
// （CLIProxyAPI 的 upstream_error、OpenAI 的 rate_limit_exceeded 等）。
// 数字字段直接采信，字符串错误码映射回代表性状态，让流内错误与真实
// HTTP 状态走同一套重试/终止判定。
const STREAM_ERROR_NUMERIC_KEYS = ['status', 'statusCode', 'status_code', 'http_status', 'httpStatus', 'code'];
const STREAM_ERROR_STATUS_RE = /(?:status|http|code)[^0-9]{0,12}([45]\d{2})\b/i;
const STREAM_ERROR_STATUSES = new Map([
  ['request_timeout', 408],
  ['rate_limit_exceeded', 429], ['rate_limit_error', 429], ['too_many_requests', 429],
  ['internal_server_error', 500], ['server_error', 500], ['api_error', 500], ['internal_error', 500],
  ['upstream_error', 502], ['bad_gateway', 502], ['bad_gateway_error', 502],
  ['service_unavailable', 503], ['overloaded', 503], ['overloaded_error', 503],
  ['gateway_timeout', 504],
  ['invalid_request_error', 400], ['invalid_request', 400], ['billing_error', 400],
  ['invalid_api_key', 401], ['authentication_error', 401], ['unauthorized', 401], ['unauthenticated', 401],
  ['insufficient_quota', 403], ['permission_error', 403], ['permission_denied', 403], ['forbidden', 403],
  ['model_not_found', 404], ['not_found', 404], ['not_found_error', 404],
  ['request_too_large', 413]
]);
// 依次检查 error 对象、response.error、事件本体；数值状态 > message 文本
// 里的 status/http 数字 > code/type 字符串映射。返回 0 表示识别不出。
function streamErrorStatus(data) {
  for (const detail of [data?.error, data?.response?.error, data]) {
    if (!detail || typeof detail !== 'object') continue;
    for (const key of STREAM_ERROR_NUMERIC_KEYS) {
      const value = detail[key];
      const status = typeof value === 'number' ? value
        : typeof value === 'string' && /^\s*[45]\d{2}\s*$/.test(value) ? Number(value) : NaN;
      if (status >= 400 && status <= 599) return status;
    }
    const message = typeof detail.message === 'string' ? detail.message.match(STREAM_ERROR_STATUS_RE) : null;
    if (message) return Number(message[1]);
    for (const key of ['code', 'type']) {
      const mapped = STREAM_ERROR_STATUSES.get(detail[key]);
      if (mapped) return mapped;
    }
  }
  return 0;
}
const RETRYABLE_CODES = new Set([
  'upstream_network', 'upstream_timeout', 'upstream_content_type',
  'upstream_stream_error', 'upstream_stream_incomplete',
  'upstream_invalid_json', 'upstream_invalid_tool'
]);
// 重试间隔（秒）：1,1,2,2,3,3,5,5,8,8,13,13,21,21，之后固定 30。
const RETRY_BACKOFF_SECONDS = [1, 1, 2, 2, 3, 3, 5, 5, 8, 8, 13, 13, 21, 21];
function retryBackoffMs(attempt) {
  const seconds = attempt <= RETRY_BACKOFF_SECONDS.length ? RETRY_BACKOFF_SECONDS[attempt - 1] : 30;
  return seconds * 1000;
}

async function serveChat({ request, route, provider, res, signal, log = () => {}, timeouts = {}, retries = 0, retryDelayMs = null, onMetrics = () => {} }) {
  const id = randomUUID();
  let metrics = createTracker({ id, request, route, provider });
  let outcome = 'error', outcomeCode = null;
  let upstreamController = new AbortController();
  const abort = () => upstreamController.abort();
  const close = () => { if (!res.writableEnded) upstreamController.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  res.on('close', close);
  if (signal?.aborted) upstreamController.abort();
  const write = async chunk => {
    if (signal?.aborted || res.destroyed || res.writableEnded) throw new Error('Client closed');
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/connect+proto', 'cache-control': 'no-store' });
    if (!res.write(frame(chunk))) await new Promise((resolve, reject) => {
      const clean = () => { res.off('drain', drained); res.off('close', closed); signal?.removeEventListener('abort', closed); };
      const drained = () => { clean(); resolve(); };
      const closed = () => { clean(); reject(new Error('Client closed')); };
      res.once('drain', drained); res.once('close', closed); signal?.addEventListener('abort', closed, { once: true });
    });
  };
  let status = 0;
  let classifiedCode = 'upstream_network';
  // messageId 是发给客户端的消息 id：中途断流重发时换新，已输出的片段
  // 原样保留（以错误终止帧封闭）。id 只作 requestId 贯穿日志与指标。
  let messageId = id;
  let attemptEmitted = false;
  const record = event => { try { log(event); } catch { /* Diagnostics cannot fail a model request. */ } };

  const firstResponseLimit = Number.isSafeInteger(timeouts?.firstResponseMs) && timeouts.firstResponseMs > 0
    ? Math.min(timeouts.firstResponseMs, 2147483647) : 120000;
  const idleLimit = Number.isSafeInteger(timeouts?.idleMs) && timeouts.idleMs > 0
    ? Math.min(timeouts.idleMs, 2147483647) : 120000;
  const maxRetries = Number.isSafeInteger(retries) && retries > 0 ? Math.min(retries, 100) : 0;
  // retryDelayMs 为内部覆盖项（测试用），缺省时按 RETRY_BACKOFF 递增间隔。
  const fixedRetryWait = Number.isSafeInteger(retryDelayMs) && retryDelayMs >= 0 ? Math.min(retryDelayMs, 60000) : null;

  let activeTimer = null;
  const clearTimer = () => { if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; } };
  const armTimer = (ms, code) => {
    clearTimer();
    activeTimer = setTimeout(() => {
      classifiedCode = code;
      upstreamController.abort();
    }, ms);
  };
  const pause = ms => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); res.off('close', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    res.once('close', finish);
  });
  // 已向客户端输出内容后无法原样重发（会拼接重复输出），但流式阶段只可能
  // 输出过文本/思考片段——工具调用只在 finish 时整块发出，断流重发永远不会
  // 重复执行工具。因此已输出时也可重试：旧消息以 13 终止，换新 id 重来。
  const canRetry = () => classifiedCode === 'upstream_http'
    ? RETRYABLE_HTTP_STATUS.has(status) : RETRYABLE_CODES.has(classifiedCode);

  const emitCancelled = () => {
    outcome = 'cancelled';
    outcomeCode = 'client_cancelled';
    record({ event: 'chat-aborted', model: route.model, status });
    if (!res.destroyed && !res.writableEnded) res.destroy();
    return { status, aborted: true };
  };
  const emitFailure = async attempts => {
    let errorText = 'Provider response could not be completed.';
    if (classifiedCode === 'upstream_http' && status >= 400) {
      errorText = `Provider returned HTTP ${status}.`;
    } else if (classifiedCode === 'upstream_content_type' || classifiedCode === 'upstream_invalid_json' || classifiedCode === 'upstream_invalid_tool') {
      errorText = 'Provider response format is invalid.';
    }

    try {
      await write(textChunk(messageId, errorText));
      await write(stopChunk(messageId, 13, route.uid || request.modelUid));
      res.end(frame(Buffer.from('{}'), 2));
    } catch {
      if (!res.destroyed && !res.writableEnded) res.destroy();
    }
    outcomeCode = classifiedCode;
    record({ event: 'chat-error', model: route.model, status, code: classifiedCode, requestId: id, ...(attempts > 0 ? { attempts } : {}) });
    return { status, error: true, code: classifiedCode, requestId: id };
  };

  try {
    const { url, chat } = endpoint(provider);
    const body = buildRequestBody(request, route, provider);

    let attempts = 0;
    for (;;) {
      upstreamController = new AbortController();
      if (signal?.aborted) upstreamController.abort();
      status = 0;
      classifiedCode = 'upstream_network';
      metrics = createTracker({ id, request, route, provider });
      try {
        armTimer(firstResponseLimit, 'upstream_timeout');
        const upstream = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            // Codex 网关依据 responses-lite 身份头识别契约；session-id 与
            // prompt_cache_key 对齐做会话亲和。chat/completions 同样需要该头。
            ...(isCodex(provider)
              ? codexHeaders(provider, body.prompt_cache_key)
              : (provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}))
          },
          body: JSON.stringify(body),
          signal: upstreamController.signal
        });
        clearTimer();

        status = upstream.status;
        if (!upstream.ok) {
          classifiedCode = 'upstream_http';
          await upstream.body?.cancel();
          throw new Error('Upstream HTTP error');
        }
        const contentType = upstream.headers.get('content-type') || '';
        if (!upstream.body || !contentType.toLowerCase().includes('text/event-stream')) {
          classifiedCode = 'upstream_content_type';
          await upstream.body?.cancel();
          throw new Error('Upstream did not return SSE');
        }

        async function* rawChunksWithTimeout(bodyStream) {
          const reader = bodyStream.getReader();
          try {
            while (true) {
              armTimer(idleLimit, 'upstream_timeout');
              let res;
              try {
                res = await reader.read();
              } catch (err) {
                if (classifiedCode !== 'upstream_timeout') classifiedCode = 'upstream_stream_error';
                throw err;
              } finally {
                clearTimer();
              }
              if (res.done) break;
              yield res.value;
            }
          } finally {
            reader.releaseLock();
          }
        }

        attemptEmitted = false;
        const stream = processor(messageId, route.uid || request.modelUid, chat, async chunk => {
          attemptEmitted = true;
          return write(chunk);
        });
        try {
          for await (const event of events(rawChunksWithTimeout(upstream.body))) {
            metrics.event(event, chat);
            await stream.event(event);
            if (event.type === 'done' || (!chat && stream.terminal)) break;
          }
        } catch (err) {
          if (classifiedCode !== 'upstream_timeout') {
            const upstreamStatus = Number.isSafeInteger(err?.upstreamStatus) ? err.upstreamStatus : 0;
            if (upstreamStatus >= 400 && upstreamStatus <= 599) {
              classifiedCode = 'upstream_http';
              status = upstreamStatus;
            } else {
              const allowedCodes = new Set([
                'upstream_timeout', 'upstream_http', 'upstream_content_type',
                'upstream_stream_error', 'upstream_stream_incomplete',
                'upstream_invalid_tool', 'upstream_invalid_json', 'upstream_network'
              ]);
              classifiedCode = allowedCodes.has(err?.code) ? err.code : 'upstream_stream_error';
            }
          }
          throw err;
        }

        let toolNames;
        try {
          toolNames = await stream.finish();
        } catch (err) {
          classifiedCode = err?.code === 'upstream_invalid_tool' ? 'upstream_invalid_tool' : 'upstream_stream_incomplete';
          throw err;
        }

        res.end(frame(Buffer.from('{}'), 2));
        outcome = 'success';
        record({ event: 'chat-complete', model: route.model, status, toolNames, requestId: id, ...(attempts > 0 ? { attempts } : {}) });
        return { status, toolNames, requestId: id };
      } catch (err) {
        clearTimer();
        if (signal?.aborted || res.destroyed || res.writableEnded) return emitCancelled();
        if (attempts < maxRetries && canRetry()) {
          attempts++;
          upstreamController.abort();
          const delay = fixedRetryWait ?? retryBackoffMs(attempts);
          record({ event: 'chat-retry', model: route.model, status, code: classifiedCode, attempts, delay, requestId: id });
          if (attemptEmitted) {
            try { await write(stopChunk(messageId, 13, route.uid || request.modelUid)); }
            catch { return emitCancelled(); }
            messageId = randomUUID();
            attemptEmitted = false;
          }
          await pause(delay);
          continue;
        }
        return await emitFailure(attempts);
      }
    }
  } catch (err) {
    clearTimer();
    if (signal?.aborted || res.destroyed || res.writableEnded) return emitCancelled();
    return await emitFailure(0);
  } finally {
    try { onMetrics(metrics.finish(outcome, status, outcomeCode)); } catch {}
    clearTimer();
    upstreamController.abort();
    signal?.removeEventListener('abort', abort);
    res.off('close', close);
  }
}

module.exports = { serveChat, buildRequestBody, parseEvent, retryBackoffMs };
