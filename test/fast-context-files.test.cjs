'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSnapshot, modelPath, readSafe, runRg, findRipgrep } = require('../src/fast-context/files.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fusion-fc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/auth.js'), 'function authenticate(token) {\n  return token === "demo";\n}\nmodule.exports = { authenticate };\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.js\n');
  await fs.writeFile(path.join(root, 'ignored.js'), 'IGNORE_MARKER');
  await fs.writeFile(path.join(root, '.env.local'), 'DO_NOT_READ_SECRET');
  await fs.writeFile(path.join(root, 'private.pem'), 'DO_NOT_READ_KEY');
  await fs.mkdir(path.join(root, '.git'));
  return root;
}
test('snapshot searches real code and returns 1-based file locations', async t => {
  const root = await fixture(t);
  const snapshot = await createSnapshot(root);
  assert.match(snapshot.tree(), /\/codebase\/src\/auth.js/);
  const result = await snapshot.execute({ type: 'rg', pattern: '^function authenticate', path: '/codebase' });
  assert.match(result, /\/codebase\/src\/auth.js:1:function authenticate/);
  assert.match(await snapshot.execute({ type: 'readfile', file: '/codebase/src/auth.js', start_line: 2, end_line: 2 }), /^2:  return/);
  assert.equal(await snapshot.verify('src/auth.js'), true);
});
test('snapshot enforces ignores and fixed exclusions for all commands', async t => {
  const root = await fixture(t);
  const snapshot = await createSnapshot(root, { exclude: ['.gitignore'] });
  assert.deepEqual([...snapshot.entries.keys()], ['src/auth.js']);
  await assert.rejects(snapshot.execute({ type: 'readfile', file: '/codebase/.env.local' }), /file_not_available/);
  assert.equal(await snapshot.execute({ type: 'rg', pattern: 'DO_NOT_READ', path: '/codebase' }), '(no matches)');
});
test('gitignore also applies to folders without a git repository', async t => {
  const root = await fixture(t);
  await fs.rm(path.join(root, '.git'), { recursive: true });
  const snapshot = await createSnapshot(root);
  assert.equal(snapshot.entries.has('ignored.js'), false);
});
test('symlinks, hard links and binary files never enter snapshot', async t => {
  const root = await fixture(t);
  await fs.symlink(os.tmpdir(), path.join(root, 'outside'));
  await fs.symlink(path.join(root, 'src/auth.js'), path.join(root, 'link.js'));
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([65, 0, 66]));
  await fs.link(path.join(root, 'src/auth.js'), path.join(root, 'hard.js'));
  const snapshot = await createSnapshot(root);
  assert.ok(![...snapshot.entries.keys()].some(file => /link|outside|binary|auth|hard/.test(file)));
  await assert.rejects(readSafe(root, 'link.js'), /path_not_allowed/);
});
test('model paths cannot escape or select other absolute roots', () => {
  for (const value of ['/etc/passwd', '/codebase/../secret', '../x', 'C:\\secret', '//host/share', '/codebase//etc', 'a\0b']) {
    assert.throws(() => modelPath(value), /path_not_allowed/);
  }
  assert.equal(modelPath('/codebase/src/auth.js'), 'src/auth.js');
});
test('option-like rg patterns stay data and cannot run preprocessors', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'sample.txt'), '--pre=touch /tmp/never\n');
  const snapshot = await createSnapshot(root);
  const result = await snapshot.execute({ type: 'rg', pattern: '--pre=touch', path: '/codebase' });
  assert.match(result, /sample.txt:1:--pre=touch/);
  await assert.rejects(snapshot.execute({ type: 'exec', command: 'touch sentinel' }), /unsupported_command/);
});
test('include/exclude patterns and explicit roots narrow snapshot searches', async t => {
  const root = await fixture(t);
  const snapshot = await createSnapshot(root);
  assert.equal(await snapshot.execute({ type: 'rg', pattern: 'authenticate', include: ['*.py'], path: '/codebase' }), '(no matches)');
  assert.equal(await snapshot.execute({ type: 'rg', pattern: 'authenticate', exclude: ['**/*.js'], path: '/codebase' }), '(no matches)');
  assert.match(await snapshot.execute({ type: 'rg', pattern: 'authenticate', include: ['**/*.js'], path: '/codebase/src' }), /auth.js/);
});
test('snapshot limits are explicit and changed files fail verification', async t => {
  const root = await fixture(t);
  const snapshot = await createSnapshot(root, { limits: { files: 1, bytes: 1000, lines: 100 } });
  assert.equal(snapshot.stats.truncated, true);
  const complete = await createSnapshot(root);
  await fs.writeFile(path.join(root, 'src/auth.js'), 'changed\n');
  assert.equal(await complete.verify('src/auth.js'), false);
});
test('cancelled ripgrep and invalid ranges fail without leaking command errors', async t => {
  const root = await fixture(t);
  const snapshot = await createSnapshot(root);
  await assert.rejects(snapshot.execute({ type: 'readfile', file: 'src/auth.js', start_line: -1 }), /invalid_range/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(runRg(findRipgrep(), ['--files'], { cwd: root, signal: abort.signal }), /cancelled/);
});
