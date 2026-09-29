'use strict';

// Codex 专线（如 cliproxyapi 的 codex 渠道）按 Codex Responses Lite 契约校验
// 请求：缺少 x-openai-internal-codex-responses-lite 身份头会被路由到普通渠道
// 并返回 503。这里对齐 AnyBridge codex-unlock 与 Codex CLI 抓包结果。

const crypto = require('node:crypto');

const CODEX_INSTALLATION_ID = crypto.randomUUID();
const CODEX_SESSION_ID = generateUUIDv7();
const CODEX_DESKTOP_USER_AGENT = 'Codex Desktop/0.142.0-alpha.1 (Windows 10.0.26200; x86_64)';
const CODEX_CACHE_KEYS = new Map();

function generateUUIDv7() {
  const bytes = crypto.randomBytes(16);
  const ts = BigInt(Date.now());
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isCodex(provider) { return provider?.unlockKind === 'codex'; }

function codexInputCacheSeed(input) {
  if (Array.isArray(input)) {
    const firstUser = input.find(item => item?.role === 'user');
    if (firstUser) return JSON.stringify(firstUser).slice(0, 8192);
  }
  return JSON.stringify(input || '').slice(0, 8192);
}

// prompt_cache_key 与 Codex CLI 一致：同一会话内保持稳定（按首条 user 输入派生），
// 让上游的 prompt 缓存与会话亲和能命中；随机 UUID 会让每轮都换缓存键。
function buildCodexPromptCacheKey(input) {
  const seed = codexInputCacheSeed(input);
  if (!seed) return CODEX_SESSION_ID;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  let key = CODEX_CACHE_KEYS.get(hash);
  if (!key) {
    key = generateUUIDv7();
    CODEX_CACHE_KEYS.set(hash, key);
  }
  return key;
}

// Codex Responses 必需字段：include 固定为 reasoning.encrypted_content，
// store:false 避免上游持久化（部分第三方网关开启 store 会触盘/报错）。
// Responses Lite 契约另外要求 reasoning.context=all_turns 与
// parallel_tool_calls=false，缺失会被上游按 400 拒绝；context 与已有
// effort/summary 合并，不覆盖档位。
function applyCodexRequiredFields(body) {
  body.include = ['reasoning.encrypted_content'];
  body.prompt_cache_key = buildCodexPromptCacheKey(body.input);
  body.store = false;
  body.parallel_tool_calls = false;
  body.reasoning = { ...(body.reasoning ?? {}), context: 'all_turns' };
  return body;
}

function buildCodexClientMetadata(sessionId = CODEX_SESSION_ID) {
  const turnId = generateUUIDv7();
  const windowId = `${sessionId}:0`;
  return {
    session_id: sessionId,
    thread_id: sessionId,
    turn_id: turnId,
    'x-codex-window-id': windowId,
    'x-codex-turn-metadata': JSON.stringify({
      installation_id: CODEX_INSTALLATION_ID,
      session_id: sessionId,
      thread_id: sessionId,
      turn_id: turnId,
      window_id: windowId,
      request_kind: 'turn',
      sandbox: 'none',
      turn_started_at_unix_ms: Date.now(),
      workspace_kind: 'project',
    }),
  };
}

// 身份头对齐 Codex CLI 真实抓包；session/thread/client-request-id 与会话级
// prompt_cache_key 对齐，供上游会话亲和与审计。
function codexHeaders(provider, sessionId = CODEX_SESSION_ID) {
  const meta = buildCodexClientMetadata(sessionId);
  return {
    ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    originator: 'Codex Desktop',
    'user-agent': CODEX_DESKTOP_USER_AGENT,
    'session-id': meta.session_id,
    'thread-id': meta.thread_id,
    'x-client-request-id': meta.session_id,
    'x-codex-window-id': meta['x-codex-window-id'],
    'x-codex-turn-metadata': meta['x-codex-turn-metadata'],
    'x-openai-internal-codex-responses-lite': 'true',
  };
}

module.exports = { isCodex, applyCodexRequiredFields, buildCodexPromptCacheKey, codexHeaders, generateUUIDv7 };
