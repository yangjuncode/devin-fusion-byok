'use strict';

// /models commonly reports IDs only. Keep provider-specific overrides explicit;
// use the standard GPT/o reasoning controls only for recognizable base IDs.
function modelEfforts(model) {
  if (model.effortMode === 'none') return [null];
  if (Array.isArray(model.efforts) && model.efforts.length) return [...new Set(model.efforts)];
  if (model.effortMode === 'manual') return [null];
  const id = String(model.id || '').split('/').at(-1);
  if (/^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/i.test(id) &&
      !/(?:^|-)(?:none|minimal|low|medium|high|xhigh|max|ultra)(?:-|$)/i.test(id)) {
    // The null variant retains previously saved UIDs and provider-default behavior.
    return [null, 'low', 'medium', 'high', 'xhigh'];
  }
  return [null];
}

function modelSupportsImages(model) {
  return true;
}

// 返回给 Devin 的上下文窗口封顶：config 的 gptContextWindowCap / contextWindowCap
// 为 0 或未设置时沿用模型原配置（不封顶），大于 0 时压到该值。
// 官方 fusion uid 取 Lead 段判定，避免 Sidekick 是 gpt 时误压 Lead 的窗口。
function isGptIdentity(identity) {
  let id = String(identity || '');
  if (id.startsWith('fusion-')) {
    const marker = id.lastIndexOf('-sidekick-');
    id = marker > 'fusion-'.length ? id.slice('fusion-'.length, marker) : id.slice('fusion-'.length);
  }
  return /gpt/i.test(id.split('/').at(-1));
}
function contextWindowCaps(config = {}) {
  const pick = value => Number.isSafeInteger(value) && value > 0 ? value : Infinity;
  return { gpt: pick(config.gptContextWindowCap), other: pick(config.contextWindowCap) };
}
function contextWindowCap(identity, caps) {
  const resolved = caps || contextWindowCaps();
  return isGptIdentity(identity) ? resolved.gpt : resolved.other;
}
function capContextWindow(identity, value, caps) { return Math.min(value, contextWindowCap(identity, caps)); }

module.exports = { modelEfforts, modelSupportsImages, isGptIdentity, contextWindowCaps, contextWindowCap, capContextWindow };
