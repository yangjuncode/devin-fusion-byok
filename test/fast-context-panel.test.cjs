'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderPanel } = require('../src/panel/view.cjs');
const { createPanelController } = require('../src/panel/controller.cjs');
const { createFastContextHost, mcpConfig } = require('../src/fast-context/config-ui.cjs');
const { setupPrompt } = require('../src/fast-context/setup-prompt.cjs');

const tempDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-panel-')));

test('the control panel has a Fast Context tab with copy buttons', () => {
  const html = renderPanel({ nonce: 'safe', cspSource: 'test:' });
  const section = html.slice(html.indexOf('id="view-fastcontext"'), html.indexOf('id="view-settings"'));
  assert.ok(section.includes('hidden>'));
  for (const id of ['fc-root', 'fc-pick', 'fc-copy-prompt', 'fc-copy-config', 'fc-preview']) assert.ok(section.includes(`id="${id}"`), id);
  assert.match(html, /'fastContext\.' \+ type/);
  assert.match(html, /send\('copy', \{ kind: 'prompt'/);
});

test('setup prompt carries exact config, harness recipes and verification without secrets', () => {
  const config = mcpConfig({ extensionPath: "/ext/it's", root: '/项目/app', node: '/usr/bin/node' }).mcpServers['fusion-fast-context'];
  const prompt = setupPrompt({ ...config, platform: 'darwin' });
  assert.ok(prompt.includes(JSON.stringify(config.args)));
  assert.ok(prompt.includes(`claude mcp add fusion-fast-context --scope user -- '/usr/bin/node' '/ext/it'\\''s/src/fast-context/server.cjs' '--root' '/项目/app'`));
  assert.ok(prompt.includes('[mcp_servers.fusion-fast-context]'));
  for (const text of ['fast_context_status', 'fast_context_search', '不要整文件覆盖', '用户级', '22.16']) assert.ok(prompt.includes(text), text);
  assert.doesNotMatch(prompt, /WINDSURF_API_KEY|apiKey/);
  assert.throws(() => setupPrompt({ command: 'node', args: ['x'] }), /invalid_config/);
});

test('host copies prompt or config only for allowed, existing roots', async () => {
  const root = tempDir(), other = tempDir(), copied = [];
  const vscode = { workspace: { isTrusted: true, workspaceFolders: [{ name: 'app', uri: { scheme: 'file', fsPath: root } }] },
    env: { clipboard: { writeText: async text => { copied.push(text); } } },
    window: { showOpenDialog: async () => [{ scheme: 'file', fsPath: other }] } };
  const host = createFastContextHost({ vscode, context: { extensionPath: '/ext' }, resolve: () => '/bin/node' });
  assert.deepEqual(host.state().roots.map(item => item.path), [root]);
  await host.copy('prompt', root);
  assert.match(copied[0], /fusion-fast-context/);
  await host.copy('config', root);
  assert.deepEqual(JSON.parse(copied[1]).mcpServers['fusion-fast-context'].args, ['/ext/src/fast-context/server.cjs', '--root', root]);
  await assert.rejects(host.copy('prompt', other), /fast_context_root_not_allowed/);
  assert.equal(await host.pick(), other);
  await host.copy('prompt', other);
  assert.equal(copied.length, 3);
  fs.rmSync(other, { recursive: true });
  await assert.rejects(host.copy('prompt', other), /fast_context_root_missing/);
  vscode.workspace.isTrusted = false;
  await assert.rejects(host.copy('prompt', root), /fast_context_untrusted/);
  fs.rmSync(root, { recursive: true });
});

test('panel controller routes Fast Context messages without touching the config manager', async () => {
  let handler; const posted = [], calls = [];
  const panel = { reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }),
    webview: { html: '', cspSource: '', postMessage: async message => { posted.push(message); return true; }, onDidReceiveMessage: fn => { handler = fn; return { dispose() {} }; } } };
  const fastContext = { state: () => ({ roots: [], trusted: true }), pick: async () => '/picked',
    copy: async (kind, root) => { calls.push([kind, root]); if (root === '/bad') throw new Error('fast_context_root_not_allowed'); } };
  const controller = createPanelController({ vscode: { ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => panel } },
    context: { subscriptions: [] }, fastContext, safeError: () => ({ message: 'x' }),
    manager: { state: () => ({}), dispatch: async () => { throw new Error('must not reach the manager'); } } });
  controller.open();
  await handler({ id: 'a', type: 'fastContext.copy', payload: { kind: 'prompt', root: '/ok' } });
  await handler({ id: 'b', type: 'fastContext.copy', payload: { kind: 'evil', root: '/bad' } });
  await handler({ id: 'c', type: 'fastContext.pick' });
  assert.deepEqual(calls, [['prompt', '/ok'], ['prompt', '/bad']]);
  const results = posted.filter(message => message.type === 'fast-context-result');
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].text, /只能选择/);
  assert.equal(posted.filter(message => message.type === 'fast-context-state').at(-1).selected, '/picked');
});
