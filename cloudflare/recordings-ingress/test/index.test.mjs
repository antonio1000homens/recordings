import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';

const baseEnv = {
  RECORDINGS_SHARED_SECRET: 'test-secret',
  AWS_ACCESS_KEY_ID: 'AKIATESTONLY',
  AWS_SECRET_ACCESS_KEY: 'test-secret-access-key',
  AWS_REGION: 'eu-west-2',
  UPLOAD_ORIGIN_URL: 'https://example.lambda-url.eu-west-2.on.aws/',
};

function request(path = '/upload-url', options = {}) {
  return new Request(`https://recordings.example${path}`, options);
}

test('health check does not require authentication', async () => {
  const response = await worker.fetch(request('/healthz'), baseEnv);
  assert.equal(response.status, 200);
});

test('rejects missing client secret at the edge', async () => {
  const response = await worker.fetch(request('/upload-url', { method: 'POST', body: '{}' }), baseEnv);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
});

test('rejects invalid client secret at the edge', async () => {
  const response = await worker.fetch(request('/upload-url', { method: 'POST', headers: { 'x-recordings-auth': 'wrong' }, body: '{}' }), baseEnv);
  assert.equal(response.status, 401);
});

test('rejects invalid JSON before AWS invocation', async () => {
  const response = await worker.fetch(request('/upload-url', { method: 'POST', headers: { 'x-recordings-auth': 'test-secret' }, body: 'not-json' }), baseEnv);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_json' });
});

test('only exposes upload-url POST route', async () => {
  const response = await worker.fetch(request('/anything-else'));
  assert.equal(response.status, 404);
});
