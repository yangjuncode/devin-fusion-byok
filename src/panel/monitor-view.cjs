'use strict';
const { summarize } = require('../runtime/monitor.cjs');
function monitorMarkup() {
  return `<details id="usage-monitor" class="card fusion-card" open aria-labelledby="monitor-heading"><summary class="card-head"><h2 id="monitor-heading">用量与性能</h2><span class="chevron" aria-hidden="true">▸</span></summary><div class="card-content"><div class="toolbar"><select id="monitor-session" aria-label="选择监控会话"><option value="all">全部会话</option></select><select id="monitor-range" aria-label="统计时间范围"><option value="1h">最近 1 小时</option><option value="24h" selected>最近 24 小时</option><option value="7d">最近 7 天</option><option value="all">全部</option></select><button id="monitor-refresh" type="button">刷新统计</button></div><p id="monitor-status" class="hint" role="status">正在读取监控…</p><details id="monitor-meta" class="monitor-fold space-top"><summary class="hint">汇总指标与统计说明</summary><div id="monitor-summary" class="space-top"></div><p class="hint space-top">统计安装监控后经过本插件连接的最近 5,000 次请求，含 BYOK 与标记“官方”的转发请求。官方转发的 token 用量协议未上报，只记录模型、状态与耗时。网关指标为主：首响应是从请求开始到收到上游第一段已解析 SSE 数据（可能是元数据或错误，不是 HTTP 响应头，也不算心跳空行）；输出 TPS（网关）用已上报输出 token ÷（总耗时 − 首响应），包含推理与工具调用。正文指标为辅：正文 TPS 按首段正文到模型完成计时，扣除已上报推理 token，含工具调用的请求不计算。缓存与推理是输出／输入的子项，不重复计入。角色尚未可靠识别，不猜测 Lead／Sidekick。上方时间范围同时过滤列表与汇总，默认最近 24 小时。</p><p class="hint space-top">未提供 ≠ 0。汇总显示已上报用量及覆盖请求数；失败或取消可能缺少最终用量。只按输出消息或本次工具调用 ID 确认会话，不再猜测历史消息归属；有歧义或无法确认的请求留在未归属。旧版记录保留 token 用量，但没有首响应与网关时序，显示“未提供”，也不补算正文 TPS。用量与请求状态分开显示：状态说明请求成败，用量说明上报是否完整。</p></details><div class="monitor-table-wrap space-top"><table class="monitor-table"><thead><tr><th>开始时间</th><th>模型／档位</th><th>状态</th><th>用量</th><th>首响应 ms</th><th>输出 TPS（网关）</th><th>输入</th><th>输出</th><th>缓存命中</th><th>推理</th><th>首输出 ms</th><th>正文首字 ms</th><th>正文 TPS</th><th>请求吞吐 TPS</th><th>总耗时 ms</th><th>会话关联</th></tr></thead><tbody id="monitor-requests"></tbody></table></div></div></details>`;
}
function monitorScript() {
  return `
  (() => {
    let snapshot = null;
    let lastMessageAt = Date.now();
    const selector = document.getElementById('monitor-session');
    const range = document.getElementById('monitor-range');
    const status = document.getElementById('monitor-status');
    const summary = document.getElementById('monitor-summary');
    const rows = document.getElementById('monitor-requests');
    const timing = value => Number.isFinite(value) && value >= 0 ? value : null;
    const summarize = ${summarize.toString()};
    const format = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '未提供';
    // 记录里的 startedAt 是 UTC ISO 串，列表按浏览器本地时区显示；无法解析时原样展示。
    const localTime = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value ?? '未提供') : date.toLocaleString('zh-CN', { hour12: false }); };
    const attribution = value => ({ 'response-id': '输出 ID 确认', 'tool-id': '本次工具 ID 确认', ambiguous: '存在歧义', unassigned: '未归属' }[value] || '未知');
    const stateName = value => ({ success: '成功', error: '失败', cancelled: '已取消' }[value] || '未知');
    const usageName = value => ({ complete: '完整', partial: '不完整', missing: '未上报', inconsistent: '数据异常（缓存或推理超过总数）' }[value] || '未提供');
    const METRICS = [['firstResponseMs','平均首响应 ms'],['gatewayTps','网关输出 TPS（含推理与工具）'],['inputTokens','输入 token'],['outputTokens','输出 token'],['cachedTokens','缓存命中 token'],['reasoningTokens','推理 token'],['ttftMs','平均首输出 ms'],['textTtftMs','平均正文首字 ms'],['tps','最近有效正文 TPS（不含工具调用）'],['throughputTps','请求吞吐（含等待）']];
    const FIELDS = ['firstResponseMs','gatewayTps','inputTokens','outputTokens','cachedTokens','reasoningTokens','firstOutputMs','firstTextMs','tps','throughputTps','durationMs'];
    const RANGES = { '1h': 3600000, '24h': 86400000, '7d': 604800000, all: null };
    const persisted = (() => { try { return vscode.getState() || {}; } catch { return {}; } })();
    const persist = patch => { try { vscode.setState({ ...(vscode.getState() || {}), ...patch }); } catch { /* webview 状态不可用时忽略记忆。 */ } };
    if (RANGES[persisted.monitorRange] !== undefined) range.value = persisted.monitorRange;
    let folds = persisted.folds && typeof persisted.folds === 'object' ? { ...persisted.folds } : {};
    for (const [id, open] of Object.entries(folds)) {
      const node = document.getElementById(id);
      if (node && typeof node.open === 'boolean') node.open = open === true;
    }
    for (const id of ['usage-monitor', 'monitor-meta', 'models-card', 'fusion-card', 'native-card']) {
      const node = document.getElementById(id);
      if (node) node.addEventListener('toggle', () => { folds = { ...folds, [id]: node.open }; persist({ folds }); });
    }
    function render() {
      summary.replaceChildren(); rows.replaceChildren();
      if (!snapshot) return;
      const selected = selector.value === 'all' ? snapshot : snapshot.sessions.find(s => (s.sessionId || '__unassigned__') === selector.value);
      if (!selected) return;
      const pool = selected.records || [];
      const span = RANGES[range.value] ?? null;
      const cutoff = span === null ? null : Date.now() - span;
      const records = cutoff === null ? pool : pool.filter(r => { const at = Date.parse(r.startedAt); return Number.isNaN(at) || at >= cutoff; });
      const s = summarize(records);
      const count = document.createElement('p');
      const officialCount = records.filter(r => r.providerId === 'official').length;
      count.textContent = '请求 ' + s.requests + (officialCount ? '（其中官方 ' + officialCount + '）' : '') + ' · 成功 ' + s.success + ' · 失败 ' + s.error + ' · 取消 ' + s.cancelled + (records.length !== pool.length ? ' · 范围外另有 ' + (pool.length - records.length) + ' 条' : '');
      summary.append(count);
      for (const [key, label] of METRICS) {
        const metric = s[key]; const item = document.createElement('span');
        item.className = 'monitor-metric';
        item.textContent = label + '：' + format(metric?.value) + '（' + (metric?.reported ?? metric?.samples ?? 0) + '/' + s.requests + ' 次）';
        summary.append(item);
      }
      for (const r of records) {
        const row = document.createElement('tr');
        const values = [localTime(r.startedAt), (r.providerId === 'official' ? '官方 · ' : '') + r.model + (r.effort ? ' / ' + r.effort : ''), stateName(r.status), usageName(r.usageState), ...FIELDS.map(k => format(r[k])), attribution(r.attribution)];
        for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
        row.title = '请求 ID：' + r.id + (r.code ? ' · ' + r.code : ''); rows.append(row);
      }
    }
    selector.addEventListener('change', render);
    range.addEventListener('change', () => { persist({ monitorRange: range.value }); render(); });
    document.getElementById('monitor-refresh').addEventListener('click', () => vscode.postMessage({ id: 'monitor-refresh', type: 'monitor.refresh' }));
    window.addEventListener('message', event => {
      if (event.data?.type !== 'monitor-state') return;
      lastMessageAt = Date.now();
      const result = event.data.result;
      snapshot = result?.snapshot || null;
      status.textContent = !snapshot ? (result?.status === 'unsupported' ? '当前服务尚未启用监控；新版服务会在请求空闲后接替。' : '监控暂时不可用，请稍后刷新。') : snapshot.storageError ? '监控存储异常，统计可能不完整。' : snapshot.sessionStatus !== 'ready' ? '会话库暂时无法读取；请求用量仍保留，归属待确认。' : '每 5 秒刷新。会话以 ID 显示；未采集聊天正文。';
      const previous = selector.value; selector.replaceChildren();
      const all = document.createElement('option'); all.value = 'all'; all.textContent = '全部会话'; selector.append(all);
      for (const session of snapshot?.sessions || []) { const option = document.createElement('option'); option.value = session.sessionId || '__unassigned__'; option.textContent = session.sessionId ? session.sessionId + ' · ' + attribution(session.attribution) : '未归属／有歧义'; selector.append(option); }
      if ([...selector.options].some(o => o.value === previous)) selector.value = previous;
      render();
    });
    // 扩展宿主崩溃或重启后，面板 DOM 仍残留但不会再收到 monitor-state：
    // 超过 20 秒无消息时把状态行换成断线提示，避免列表静默定格旧数据。
    setInterval(() => {
      if (Date.now() - lastMessageAt > 20000) status.textContent = '连接已断开，请关闭面板后重新打开。';
    }, 5000);
  })();`;
}
module.exports = { monitorMarkup, monitorScript };
