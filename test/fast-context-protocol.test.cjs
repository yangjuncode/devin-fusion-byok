'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const { s, v, frame, str, fields } = require('../src/protocol/wire.cjs');
const { createRemote, parseStream, parseCall, requestBody, ORIGIN, MAX_RESPONSE } = require('../src/fast-context/protocol.cjs');
const finish = (text, trailer = {}) => Buffer.concat([frame(s(1, text)), frame(Buffer.from(JSON.stringify(trailer)), 2)]);
test('stream parses arbitrarily small fragments and gzip, requiring terminal success', () => {
  const bytes = Buffer.concat([frame(s(1, 'a')), frame(gzipSync(s(1, 'b')), 1), frame(Buffer.from('{}'), 2)]);
  assert.equal(parseStream(bytes), 'ab');
  assert.throws(() => parseStream(bytes.subarray(0, -1)), /invalid_stream/);
  assert.throws(() => parseStream(frame(s(1, 'answer'))), /incomplete_stream/);
  assert.throws(() => parseStream(finish('answer', { error: { code: 'permission_denied', message: 'secret' } })), /^Error: permission_denied$/);
  assert.throws(() => parseStream(Buffer.concat([finish('answer'), frame(s(1, 'late'))])), /invalid_stream/);
});
test('tool parser respects quoted braces, rejects malformed/multiple tool calls', () => {
  assert.equal(parseCall('[TOOL_CALLS]restricted_exec[ARGS]{"command1":{"type":"rg","pattern":"a{2}"}}').args.command1.pattern, 'a{2}');
  assert.equal(parseCall('[TOOL_CALLS]answer[ARGS]{"answer":"<ANSWER></ANSWER>"}</s>').name, 'answer');
  assert.equal(parseCall('[TOOL_CALLS]answer{"answer":"<ANSWER></ANSWER>"}</s>').name, 'answer');
  assert.equal(parseCall('Search complete.\n<ANSWER></ANSWER></s>').args.answer, '<ANSWER></ANSWER>');
  assert.throws(() => parseCall('[TOOL_CALLS]answer[ARGS]{"answer":"x"} [TOOL_CALLS]exec[ARGS]{}'), /invalid_model_response/);
  assert.throws(() => parseCall('[TOOL_CALLS]exec[ARGS]{}'), /invalid_model_response/);
  assert.throws(() => parseCall('[TOOL_CALLS]answer[ARGS]{"answer":"x"'), /invalid_model_response/);
});
test('remote restricts credentials to official origin and forbids redirects', async () => {
  const calls = [];
  const remote = createRemote({ key: 'private-key', request: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('GetUserJwt')) return new Response(s(1, 'eyJtest.payload.signature'));
    if (url.endsWith('GetCliTeamSettings')) return new Response(v(3, 0));
    if (url.endsWith('CheckUserMessageRateLimit')) return new Response(Buffer.alloc(0));
    return new Response(finish('[TOOL_CALLS]answer[ARGS]{"answer":"<ANSWER></ANSWER>"}'));
  } });
  await remote.authorize();
  assert.equal((await remote.complete([], [])).name, 'answer');
  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ url, init }) => url.startsWith(ORIGIN + '/') && init.redirect === 'error' && init.signal));
  assert.equal(str(fields(calls[0].init.body, 1)[0].value, 3), 'private-key');
});
test('policy ban and failed policy lookup prevent inference', async () => {
  for (const status of [200, 403, 500]) {
    const calls = [];
    const remote = createRemote({ key: 'secret', request: async url => {
      calls.push(url);
      return url.endsWith('GetUserJwt') ? new Response(s(1, 'eyJtest.payload.signature'))
        : new Response(status === 200 ? v(3, 1) : 'error-with-secret', { status });
    } });
    await assert.rejects(remote.authorize(), /disabled|permission_denied|upstream_http_500/);
    assert.equal(calls.length, 2);
  }
});
test('oversized stream and decompression bombs fail boundedly', () => {
  assert.throws(() => parseStream(frame(Buffer.alloc(MAX_RESPONSE + 1))), /invalid_stream/);
  assert.throws(() => parseStream(frame(gzipSync(Buffer.alloc(MAX_RESPONSE + 1)), 1)));
});
test('request preserves role and tool-result association', () => {
  const bytes = requestBody('key', 'jwt', [
    { role: 2, content: '', call: { id: 'id', name: 'restricted_exec', args: { command1: { type: 'tree' } } } },
    { role: 4, content: 'result', ref: 'id' },
  ], []);
  const messages = fields(bytes, 2);
  assert.equal(str(fields(messages[0].value, 6)[0].value, 1), 'id');
  assert.equal(str(messages[1].value, 7), 'id');
});
test('insecure TLS inheritance is refused before credentials are sent', () => {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    assert.throws(() => createRemote({ key: 'secret' }), /insecure_tls_configuration/);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});
test('rate limit response stops before inference and is not retried', async () => {
  const calls = [];
  const remote = createRemote({ key: 'key', request: async url => {
    calls.push(url);
    return url.endsWith('GetUserJwt') ? new Response(s(1, 'eyJtest.payload.signature'))
      : url.endsWith('GetCliTeamSettings') ? new Response(Buffer.alloc(0))
        : new Response('private-upstream-message', { status: 429 });
  } });
  await assert.rejects(remote.authorize(), /^Error: resource_exhausted$/);
  assert.equal(calls.length, 3);
});
test('cancelled authorization sends no credentials and oversized HTTP bodies abort', async () => {
  const controller = new AbortController(); controller.abort();
  let fetched = false;
  await assert.rejects(createRemote({ key: 'key', signal: controller.signal,
    request: async () => { fetched = true; } }).authorize());
  assert.equal(fetched, false);
  await assert.rejects(createRemote({ key: 'key',
    request: async () => new Response(Buffer.alloc(MAX_RESPONSE + 1)) }).authorize(), /response_too_large/);
});
