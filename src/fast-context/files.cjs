'use strict';
const fs = require('node:fs/promises');
const { constants, existsSync } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');

const EXCLUDES = ['.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', 'target',
  '.venv', 'venv', '__pycache__', '.cache', '.private', 'qa', '.env*', '*.pem', '*.key',
  '*.p12', '*.pfx', '*.sqlite*', '*.db', 'credentials*', 'id_rsa*', 'id_ed25519*',
  '.npmrc', '.netrc', '.git-credentials', '*.min.*', '*.map', 'package-lock.json'];
const LIMITS = { files: 3000, bytes: 8 * 1024 * 1024, fileBytes: 512 * 1024, lines: 200000 };
const hash = data => createHash('sha256').update(data).digest('hex');
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function findRipgrep(env = process.env) {
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates = [
    env.FUSION_FAST_CONTEXT_RG,
    ...String(env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, binary)),
    '/Applications/Devin.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg',
    '/Applications/Devin.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg',
    // Newer Devin builds ship ripgrep-universal with per-architecture folders.
    `/Applications/Devin.app/Contents/Resources/app/node_modules/@vscode/ripgrep-universal/bin/darwin-${process.arch}/rg`,
  ];
  const found = candidates.find(file => file && path.isAbsolute(file) && existsSync(file));
  if (!found) throw new Error('ripgrep_unavailable');
  return found;
}
function runRg(binary, args, { cwd, signal, input, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    // Model text is passed only to -e or stdin, never a shell or executable path.
    const child = execFile(binary, args, {
      cwd, signal, timeout: 10000, maxBuffer, encoding: 'utf8', windowsHide: true,
      env: { PATH: process.env.PATH || '', SYSTEMROOT: process.env.SYSTEMROOT || '',
        RIPGREP_CONFIG_PATH: '', LANG: 'C.UTF-8' },
    }, (error, stdout) => {
      if (signal?.aborted) reject(new Error('cancelled'));
      else if (error && error.code !== 1) reject(new Error('search_command_failed'));
      else resolve(stdout);
    });
    child.stdin.on('error', () => {}); // Child cancellation can close stdin first.
    child.stdin.end(input);
  });
}
async function readSafe(root, file) {
  const absolute = path.resolve(root, file);
  if (!inside(root, absolute)) throw new Error('path_not_allowed');
  const canonical = await fs.realpath(absolute);
  if (!inside(root, canonical) || canonical !== absolute) throw new Error('path_not_allowed');
  const fd = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMITS.fileBytes) throw new Error('file_not_allowed');
    // A bounded read also handles files that grow after stat().
    const buffer = Buffer.alloc(LIMITS.fileBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await fd.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > LIMITS.fileBytes || (await fs.realpath(absolute)) !== canonical) throw new Error('file_changed');
    const data = buffer.subarray(0, size);
    if (data.includes(0)) throw new Error('binary_file');
    return data;
  } finally { await fd.close(); }
}
function modelPath(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\0\r\n]/.test(value)) throw new Error('path_not_allowed');
  const normalized = value.replaceAll('\\', '/').replace(/^\/codebase(?:\/|$)/, '');
  if (path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized) ||
      normalized.split('/').includes('..')) throw new Error('path_not_allowed');
  return path.posix.normalize(normalized).replace(/\/$/, '').replace(/^\.$/, '');
}
function matches(value, patterns) {
  return patterns.some(pattern => path.matchesGlob(value, pattern) || path.matchesGlob(path.posix.basename(value), pattern));
}
function patterns(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20 ||
      value.some(item => typeof item !== 'string' || item.length > 200 || /[\0\r\n]/.test(item))) throw new Error('invalid_patterns');
  return value;
}
function bounded(text, size = 16000) {
  return text.length > size ? text.slice(0, size) + '\n[truncated]' : text;
}
async function createSnapshot(root, { signal, rg = findRipgrep(), exclude = [], limits = LIMITS } = {}) {
  root = await fs.realpath(root);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('invalid_root');
  patterns(exclude);
  const output = await runRg(rg, ['--files', '--hidden', '--null', '--no-config', '--no-follow', '--no-require-git',
    ...[...EXCLUDES, ...exclude].flatMap(glob => ['--glob', '!' + glob]), '--', '.'], { cwd: root, signal });
  const entries = new Map();
  let bytes = 0, lines = 0, skipped = 0, truncated = false, visited = 0;
  const filenames = output.split('\0').filter(Boolean).sort();
  for (const name of filenames) {
    signal?.throwIfAborted();
    if (++visited > limits.files || bytes >= limits.bytes || lines >= limits.lines) { truncated = true; break; }
    const relative = name.replace(/^\.[/\\]/, '').replaceAll('\\', '/');
    if (/[\x00-\x1f]/.test(relative)) { skipped++; continue; }
    try {
      const data = await readSafe(root, relative);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      const fileLines = text.split(/\r?\n/);
      if (text.endsWith('\n')) fileLines.pop();
      if (bytes + data.length > limits.bytes || lines + fileLines.length > limits.lines) { truncated = true; skipped++; continue; }
      entries.set(relative, { text, lines: fileLines, sha256: hash(data) });
      bytes += data.length; lines += fileLines.length;
    } catch { skipped++; }
  }
  const select = prefix => [...entries.keys()].filter(file => !prefix || file === prefix || file.startsWith(prefix + '/'));
  const snapshot = {
    root, entries, stats: { files: entries.size, bytes, skipped, truncated },
    tree(prefix = '', depth = 3) {
      const names = new Set();
      for (const file of select(prefix)) {
        const parts = file.slice(prefix ? prefix.length + 1 : 0).split('/');
        names.add('/codebase/' + (prefix ? prefix + '/' : '') + parts.slice(0, depth).join('/') + (parts.length > depth ? '/' : ''));
      }
      return bounded([...names].join('\n'), 30000);
    },
    async execute(command) {
      signal?.throwIfAborted();
      if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('invalid_command');
      if (command.type === 'readfile') {
        const file = modelPath(command.file), entry = entries.get(file);
        if (!entry) throw new Error('file_not_available');
        const start = command.start_line ?? 1, end = command.end_line ?? Math.min(entry.lines.length, start + 99);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new Error('invalid_range');
        return bounded(entry.lines.slice(start - 1, Math.min(end, start + 99))
          .map((line, i) => `${start + i}:${line.slice(0, 500)}`).join('\n') + (end - start >= 100 ? '\n[truncated]' : ''));
      }
      const prefix = modelPath(command.path ?? '/codebase');
      if (command.type === 'tree' || command.type === 'ls') {
        const depth = command.type === 'ls' ? 1 : (command.levels ?? 3);
        if (!Number.isInteger(depth) || depth < 1 || depth > 6) throw new Error('invalid_depth');
        return snapshot.tree(prefix, depth);
      }
      if (command.type !== 'rg') throw new Error('unsupported_command');
      if (typeof command.pattern !== 'string' || !command.pattern || command.pattern.length > 500) throw new Error('invalid_pattern');
      const include = patterns(command.include), excludePatterns = patterns(command.exclude);
      const ranges = [], chunks = [];
      let offset = 1;
      for (const file of select(prefix)) {
        if (include.length && !matches(file, include) || matches(file, excludePatterns)) continue;
        const entry = entries.get(file);
        ranges.push({ file, start: offset, end: offset + entry.lines.length - 1 });
        chunks.push(entry.lines.join('\n') + '\n');
        offset += Math.max(1, entry.lines.length);
      }
      if (!chunks.length) return '(no matches)';
      // Search only the bounded in-memory snapshot. Even option-looking patterns
      // cannot make ripgrep read an arbitrary host path or execute a preprocessor.
      const found = await runRg(rg, ['--json', '--no-config', '--color', 'never', '--max-count', '60',
        '--max-columns', '500', '--smart-case', '-e', command.pattern, '--', '-'],
      { signal, input: chunks.join('') });
      const results = [];
      for (const line of found.split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.type !== 'match') continue;
        const lineNo = event.data.line_number;
        const source = ranges.find(range => range.start <= lineNo && range.end >= lineNo);
        if (source) results.push(`/codebase/${source.file}:${lineNo - source.start + 1}:${String(event.data.lines.text || '').trimEnd().slice(0, 500)}`);
      }
      return bounded(results.join('\n') || '(no matches)');
    },
    async verify(file) {
      return entries.has(file) && hash(await readSafe(root, file)) === entries.get(file).sha256;
    },
  };
  return snapshot;
}
module.exports = { createSnapshot, readSafe, modelPath, findRipgrep, runRg, EXCLUDES, LIMITS, bounded };
