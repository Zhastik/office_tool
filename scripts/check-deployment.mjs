import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const origin = new URL(process.env.PDFWORK_URL || 'http://127.0.0.1:8765');
const apiOnly = process.env.PDFWORK_CHECK_MODE === 'api';
const policy = JSON.parse(readFileSync(new URL('../server/browser-headers.json', import.meta.url), 'utf8'));

function assertRequestId(response) {
  assert.match(response.headers.get('x-request-id') || '', /^[0-9a-f]{32}$/);
}

function assertBrowserHeaders(response) {
  for (const [name, value] of Object.entries(policy)) {
    assert.equal(response.headers.get(name), value, name);
  }
}

function request(path, init) {
  return fetch(new URL(path, origin), { ...init, signal: AbortSignal.timeout(10_000) });
}

async function responseToGetWithBody() {
  const transport = origin.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const sent = transport.request(new URL('/api/health', origin), {
      method: 'GET',
      headers: { 'Content-Length': 4 },
      signal: AbortSignal.timeout(10_000),
    }, (received) => {
      received.resume();
      resolve(received.statusCode);
    });
    sent.on('error', reject);
    sent.end('test');
  });
}

const health = await request('/api/health');
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { status: 'ok', file_processing: 'browser' });
assert.equal(health.headers.get('cache-control'), 'no-store');
assertRequestId(health);
if (!apiOnly) assertBrowserHeaders(health);

const ready = await request('/api/ready');
assert.equal(ready.status, 200);
assert.deepEqual(await ready.json(), { status: 'ready' });

const info = await request('/api/v1/info');
assert.equal(info.status, 200);
const metadata = await info.json();
assert.equal(metadata.name, 'pdfwork');
assert.equal(metadata.file_processing, 'browser');
assert.ok(metadata.version);

const head = await request('/api/health', { method: 'HEAD' });
assert.equal(head.status, 200);
assert.equal(await head.text(), '');

const post = await request('/api/health', { method: 'POST', body: 'test' });
assert.equal(post.status, 405);
assert.equal(post.headers.get('allow'), 'GET, HEAD');
assertRequestId(post);
if (!apiOnly) assertBrowserHeaders(post);
assert.equal(await responseToGetWithBody(), 400);

const index = await request('/');
if (apiOnly) {
  assert.equal(index.status, 404);
  console.log('FastAPI contract and API-only boundary passed.');
} else {
  assert.equal(index.status, 200);
  assertBrowserHeaders(index);
  assertRequestId(index);
  assert.equal(index.headers.get('cache-control'), 'no-cache');
  const html = await index.text();
  const assetPath = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(assetPath, 'Vite entry point missing from index.html');

  const asset = await request(assetPath);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assertBrowserHeaders(asset);
  await asset.body.cancel();

  const pdfWorker = await request('/runtime/pdfjs/worker.mjs', { method: 'HEAD' });
  assert.equal(pdfWorker.status, 200);
  assert.match(pdfWorker.headers.get('content-type'), /javascript/);
  assert.equal(pdfWorker.headers.get('cache-control'), 'no-cache');
  assertBrowserHeaders(pdfWorker);

  const missing = await request('/assets/missing-test-file.js');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assertBrowserHeaders(missing);
  console.log('HTTP contract, read-only ingress, MIME types, cache and CSP passed.');
}

