'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { renderPanel } = require('../src/panel/view.cjs');
const { monitorScript } = require('../src/panel/monitor-view.cjs');
const { createPanelController } = require('../src/panel/controller.cjs');
test('monitor browser script compiles, uses text nodes, and preserves zero versus missing', () => {
  class Element {
    constructor() { this.children = []; this.value = ''; this.textContent = ''; this.listeners = {}; this.style = {}; }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    get options() { return this.children; }
  }
  const elements = new Map();
  const byId = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  byId('monitor-session').value = 'all';
  let receive;
  vm.runInNewContext(monitorScript(), { document: { getElementById: byId, createElement: () => new Element() }, window: { addEventListener: (_, fn) => { receive = fn; } }, vscode: { postMessage() {} }, setInterval: () => 0 });
  const record = { id: 'id', startedAt: 'now', model: '<img onerror=alert(1)>', status: 'success', inputTokens: 0, outputTokens: null, usageComplete: false, attribution: 'unassigned' };
  const timed = { id: 'id2', startedAt: '2026-09-24T00:00:00.000Z', model: 'm', status: 'success', attribution: 'unassigned' };
  receive({ data: { type: 'monitor-state', result: { snapshot: { summary: { requests: 2, success: 2, error: 0, cancelled: 0 }, records: [record, timed], sessions: [], sessionStatus: 'ready' } } } });
  const cells = byId('monitor-requests').children[0].children;
  assert.equal(cells[0].textContent, 'now', '无法解析的时间原样显示');
  const timedCells = byId('monitor-requests').children[1].children;
  assert.equal(timedCells[0].textContent, new Date('2026-09-24T00:00:00.000Z').toLocaleString('zh-CN', { hour12: false }),
    'UTC ISO 时间按本地时区渲染');
  assert.equal(cells[1].textContent, '<img onerror=alert(1)>');
  assert.equal(cells[6].textContent, '0'); assert.equal(cells[7].textContent, '未提供');
  assert.equal(cells[4].textContent, '未提供'); assert.equal(cells[5].textContent, '未提供');
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  assert.match(html, /用量与性能/); assert.match(html, /connect-src 'none'/);
  new vm.Script(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]);
});
test('usage monitor renders as the last section of the panel', () => {
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  const monitor = html.indexOf('id="usage-monitor"');
  assert.equal(html.indexOf('id="usage-monitor"', monitor + 1), -1, 'usage monitor markup appears once');
  assert.ok(monitor > html.indexOf('id="native-models"'), 'usage monitor follows the official model list');
  assert.ok(monitor > html.indexOf('保存后在新建会话中使用。'), 'usage monitor follows the closing footnote');
  assert.ok(monitor < html.indexOf('</main>'), 'usage monitor stays inside the panel body');
});
test('monitor time range filters records and collapsible sections default collapsed', () => {
  class Element {
    constructor() { this.children = []; this.value = ''; this.textContent = ''; this.listeners = {}; this.style = {}; }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    get options() { return this.children; }
  }
  const elements = new Map();
  const byId = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  byId('monitor-session').value = 'all';
  byId('monitor-range').value = '1h';
  let receive;
  vm.runInNewContext(monitorScript(), { document: { getElementById: byId, createElement: () => new Element() }, window: { addEventListener: (_, fn) => { receive = fn; } }, vscode: { postMessage() {} }, setInterval: () => 0 });
  const fresh = { id: 'fresh', startedAt: new Date().toISOString(), model: 'm', status: 'success', attribution: 'unassigned' };
  const stale = { id: 'stale', startedAt: '2020-01-01T00:00:00.000Z', model: 'm', status: 'success', attribution: 'unassigned' };
  const unparseable = { id: 'odd', startedAt: 'now', model: 'm', status: 'success', attribution: 'unassigned' };
  receive({ data: { type: 'monitor-state', result: { snapshot: { records: [fresh, stale, unparseable], sessions: [], sessionStatus: 'ready' } } } });
  assert.equal(byId('monitor-requests').children.length, 2, '时间范围外的记录被过滤，时间无法解析的记录仍显示');
  byId('monitor-range').value = 'all';
  byId('monitor-range').listeners.change();
  assert.equal(byId('monitor-requests').children.length, 3, '切回全部后显示所有记录');
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  for (const id of ['models-card', 'fusion-card', 'native-card', 'monitor-meta']) {
    const tag = html.match(new RegExp('<details id="' + id + '"[^>]*>'))?.[0] || '';
    assert.ok(tag && !tag.includes('open'), id + ' 默认折叠');
  }
  const monitorTag = html.match(/<details id="usage-monitor"[^>]*>/)?.[0] || '';
  assert.ok(monitorTag.includes('open'), '用量与性能卡片默认展开');
  assert.match(html, /id="monitor-range"[^>]*aria-label="统计时间范围"/);
});
test('monitor shows a disconnect notice when monitor-state messages stop arriving', () => {
  class Element {
    constructor() { this.children = []; this.value = ''; this.textContent = ''; this.listeners = {}; this.style = {}; }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    get options() { return this.children; }
  }
  const elements = new Map();
  const byId = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  byId('monitor-session').value = 'all';
  let receive, tick, now = 1000000;
  class FakeDate extends Date { static now() { return now; } }
  vm.runInNewContext(monitorScript(), {
    document: { getElementById: byId, createElement: () => new Element() },
    window: { addEventListener: (_, fn) => { receive = fn; } },
    vscode: { postMessage() {} }, setInterval: fn => { tick = fn; return 0; }, Date: FakeDate });
  const status = byId('monitor-status');
  tick();
  assert.notEqual(status.textContent, '连接已断开，请关闭面板后重新打开。', '尚未收到任何消息时不误报断线');
  receive({ data: { type: 'monitor-state', result: { snapshot: null, status: 'unavailable' } } });
  now += 21000; tick();
  assert.equal(status.textContent, '连接已断开，请关闭面板后重新打开。', '消息停止超过阈值后提示断线');
  now += 5000;
  receive({ data: { type: 'monitor-state', result: { snapshot: null, status: 'unavailable' } } });
  tick();
  assert.equal(status.textContent, '监控暂时不可用，请稍后刷新。', '恢复收到消息后回到正常状态文案');
});
test('panel refresh is isolated, concurrent reads are coalesced and disposal suppresses posts', async () => {
  const posts = []; let onMessage, onClose, finish, reads = 0;
  const disposable = { dispose() {} };
  const panel = { visible: true, webview: { cspSource: 'test:', postMessage: async data => { posts.push(data); }, onDidReceiveMessage(fn) { onMessage = fn; return disposable; } }, onDidDispose(fn) { onClose = fn; return disposable; }, reveal() {}, dispose() { onClose(); } };
  const controller = createPanelController({ vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } }, context: { subscriptions: [] }, manager: { state: () => ({}), dispatch() { throw new Error('must not dispatch monitor'); } }, safeError: () => ({ message: 'error' }), readMonitor: () => { reads++; return new Promise(resolve => { finish = resolve; }); } });
  controller.open();
  await onMessage({ id: 'refresh', type: 'monitor.refresh' });
  assert.equal(reads, 1);
  onClose(); finish({ status: 'ready', snapshot: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts.length, 0);
});
