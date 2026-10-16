import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, PncpError, defaultUserAgent, remoteUrl } from '../src/http.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporary } from './fixtures.js';
const original = globalThis.fetch;
after(() => { globalThis.fetch = original; });
const client = (timeout = 100, retries = 2, maxBytes = 1024) => new HttpClient(timeout, retries, maxBytes, { minIntervalMs: 0, backoffMs: 1, telemetry: false, persistCooldown: false });
test('request sends the compatibility User-Agent and rejects other origins/ports before fetch', async () => {
  let headers: Headers | undefined;
  globalThis.fetch = async (_url, options) => { headers = new Headers(options?.headers); return new Response('{}'); };
  await client().json('https://pncp.gov.br/');
  assert.equal(headers?.get('user-agent'), defaultUserAgent);
  for (const url of ['http://pncp.gov.br/', 'https://pncp.gov.br.evil.example/', 'https://pncp.gov.br:444/', 'https://user:pass@pncp.gov.br/'])
    assert.throws(() => remoteUrl(url));
});
test('a reset while streaming JSON is retried and the error cause is preserved on exhaustion', async () => {
  let count = 0;
  const cause = () => new TypeError('terminated', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
  globalThis.fetch = async () => { count++; return count === 1 ? new Response(new ReadableStream({ start(c) { c.error(cause()); } })) : new Response('{"ok":true}'); };
  assert.deepEqual(await client().json('https://pncp.gov.br/'), { ok: true });
  assert.equal(count, 2);
  globalThis.fetch = async () => { throw cause(); };
  await assert.rejects(client(100, 0).json('https://pncp.gov.br/'), error => error instanceof PncpError && error.cause instanceof TypeError);
});
test('a body timeout is transient, but syntactically invalid JSON is not retried', async () => {
  let count = 0;
  globalThis.fetch = async (_url, options) => {
    count++;
    if (count > 1)
      return new Response('{}');
    return new Response(new ReadableStream({ start(c) { options?.signal?.addEventListener('abort', () => c.error(options.signal?.reason), { once: true }); } }));
  };
  await client(10).json('https://pncp.gov.br/');
  assert.equal(count, 2);
  count = 0;
  globalThis.fetch = async () => { count++; return new Response('{invalid'); };
  await assert.rejects(client().json('https://pncp.gov.br/'), /JSON inválido/);
  assert.equal(count, 1);
});
test('streaming limits cancel the source before reading the entire file', async () => {
  let chunks = 0, cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(c) {
      chunks++; if (chunks > 100)
        c.close();
      else
        c.enqueue(new Uint8Array(8));
    }, cancel() { cancelled = true; }
  }, { highWaterMark: 0 }));
  await assert.rejects(client(100, 0, 16).download('https://pncp.gov.br/file'), /limite/);
  assert.ok(chunks <= 4);
  assert.equal(cancelled, true);
});
test('download transient statuses share the retry policy and request budget', async () => {
  let count = 0;
  globalThis.fetch = async () => { count++; return count === 1 ? new Response('busy', { status: 503 }) : new Response('file'); };
  const budget = { remaining: 3 };
  assert.equal((await client().download('https://pncp.gov.br/file', 'doc', { budget })).data.toString(), 'file');
  assert.equal(count, 2);
  assert.equal(budget.remaining, 1);
});
test('Retry-After is respected and cancellation prevents an early second request', async () => {
  const temp = temporary();
  const previous = process.env.PNCP_DATA_DIR;
  process.env.PNCP_DATA_DIR = temp.directory;
  let count = 0;
  globalThis.fetch = async () => { count++; return new Response('busy', { status: 429, headers: { 'retry-after': '120' } }); };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('stop')), 30);
  try {
    const started = Date.now();
    await assert.rejects(new HttpClient(100, 2, 1024, { minIntervalMs: 0, backoffMs: 1, telemetry: false }).json('https://www.pncp.gov.br/', {}, 'test', { signal: controller.signal }));
    assert.equal(count, 1);
    assert.ok(JSON.parse(readFileSync(join(temp.directory, 'http-state/pncp-cooldown.json'), 'utf8')).retry_at >= started + 119000);
  }
  finally {
    clearTimeout(timer);
    if (previous === undefined)
      delete process.env.PNCP_DATA_DIR;
    else
      process.env.PNCP_DATA_DIR = previous;
    temp.remove();
  }
});
