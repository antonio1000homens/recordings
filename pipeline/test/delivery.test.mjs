import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  CALLBACK_EXPIRY_SECONDS,
  MAX_HTTP_ATTEMPTS,
  SIGNED_URL_EXPIRY_SECONDS,
  buildDownstreamPayload,
  buildReadySlackMessage,
  buildStartedSlackMessage,
  handler as deliveryHandler,
  postJsonWithRetry,
} from '../src/delivery.mjs';
import {
  callbackIdFromPath,
  processCallback,
  sanitizeCallbackOutput,
} from '../src/callback.mjs';

function response(status) {
  return { ok: status >= 200 && status < 300, status };
}

function callbackItem({ status = 'PENDING', expiresAtEpoch = 2000, taskToken = 'secret-task-token' } = {}) {
  return {
    callbackId: { S: 'a'.repeat(64) },
    recordingId: { S: 'recording-123' },
    status: { S: status },
    expiresAtEpoch: { N: String(expiresAtEpoch) },
    ...(taskToken ? { taskToken: { S: taskToken } } : {}),
  };
}

function callbackDeps({ item = callbackItem(), claimed = item, releaseStatus = 'SUCCEEDED' } = {}) {
  const calls = { fetch: 0, claim: 0, release: 0, finalize: [], expire: 0, rollback: 0 };
  return {
    calls,
    deps: {
      async fetchCallback() { calls.fetch += 1; return item; },
      async claimCallback() { calls.claim += 1; return claimed; },
      async releaseStepFunction(token, output) {
        calls.release += 1;
        calls.token = token;
        calls.output = output;
        return releaseStatus;
      },
      async finalizeCallback(_id, _completionId, status) { calls.finalize.push(status); },
      async expireCallback() { calls.expire += 1; },
      async rollbackClaim() { calls.rollback += 1; },
    },
  };
}

test('signed artifact URLs use a 30 minute expiry and callback wait is longer', () => {
  assert.equal(SIGNED_URL_EXPIRY_SECONDS, 1800);
  assert.equal(CALLBACK_EXPIRY_SECONDS, 3600);
  assert.equal(MAX_HTTP_ATTEMPTS, 3);
});

test('transient webhook responses retry with a bounded exponential policy', async () => {
  const statuses = [429, 503, 204];
  let calls = 0;
  let sleeps = 0;
  const result = await postJsonWithRetry('https://example.invalid/hook', { ok: true }, {
    fetchImpl: async () => response(statuses[calls++]),
    sleepImpl: async () => { sleeps += 1; },
  });
  assert.equal(result.status, 204);
  assert.equal(calls, 3);
  assert.equal(sleeps, 2);
});

test('permanent webhook 4xx is not retried indefinitely', async () => {
  let calls = 0;
  await assert.rejects(
    postJsonWithRetry('https://example.invalid/hook', {}, {
      fetchImpl: async () => { calls += 1; return response(400); },
      sleepImpl: async () => {},
    }),
    (error) => error.name === 'PermanentWebhookError' && error.status === 400,
  );
  assert.equal(calls, 1);
});

test('Slack start failure is best effort and does not fail the handler', async () => {
  const originalFetch = globalThis.fetch;
  const originalWebhook = process.env.RECORDINGS_SLACK_WEBHOOK;
  const originalEnabled = process.env.SLACK_NOTIFICATIONS_ENABLED;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return response(400); };
  process.env.RECORDINGS_SLACK_WEBHOOK = 'https://example.invalid/slack';
  process.env.SLACK_NOTIFICATIONS_ENABLED = 'true';
  try {
    const result = await deliveryHandler({
      action: 'notify_started',
      bucket: 'recordings-test',
      key: 'inbox/recording-123/Call recording.m4a',
    });
    assert.equal(result.delivered, false);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWebhook === undefined) delete process.env.RECORDINGS_SLACK_WEBHOOK;
    else process.env.RECORDINGS_SLACK_WEBHOOK = originalWebhook;
    if (originalEnabled === undefined) delete process.env.SLACK_NOTIFICATIONS_ENABLED;
    else process.env.SLACK_NOTIFICATIONS_ENABLED = originalEnabled;
  }
});

test('Slack messages contain expected metadata and readable expiring links', () => {
  const started = buildStartedSlackMessage({ recordingId: 'recording-123', filename: 'Call.m4a' });
  assert.match(started, /Recording workflow started/);
  assert.match(started, /Call\.m4a/);
  assert.match(started, /recording-123/);
  assert.doesNotMatch(started, /taskToken|webhook/i);

  const ready = buildReadySlackMessage({
    recordingId: 'recording-123',
    filename: 'Call.m4a',
    audio: { url: 'https://signed.example/audio' },
    html: { url: 'https://signed.example/html' },
  });
  assert.match(ready, /<https:\/\/signed\.example\/audio\|Audio>/);
  assert.match(ready, /<https:\/\/signed\.example\/html\|Transcript>/);
  assert.match(ready, /expire in 30 minutes/i);
});

test('downstream payload contains artifact metadata and opaque callback without a task token', () => {
  const payload = buildDownstreamPayload({
    recordingId: 'recording-123',
    filename: 'Call.m4a',
    processedAt: '2026-09-10T18:00:00.000Z',
    audio: { filename: 'Call.m4a', bucket: 'b', key: 'inbox/r/Call.m4a', url: 'https://signed/audio' },
    html: { filename: 'r.html', bucket: 'b', key: 'results/r.html', url: 'https://signed/html' },
  }, {
    url: `https://callback.example/recordings/callback/${'a'.repeat(64)}`,
    expiresAt: '2026-09-10T19:00:00.000Z',
  });
  assert.equal(payload.audio.url, 'https://signed/audio');
  assert.equal(payload.html.url, 'https://signed/html');
  assert.match(payload.callback.url, /[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(payload), /secret-task-token|taskToken/);
});

test('callback path accepts only opaque 256-bit hexadecimal identifiers', () => {
  const id = 'a'.repeat(64);
  assert.equal(callbackIdFromPath(`/recordings/callback/${id}`), id);
  assert.equal(callbackIdFromPath('/recordings/callback/raw-task-token'), null);
});

test('successful callback releases Step Functions once then records terminal status', async () => {
  const { calls, deps } = callbackDeps();
  const result = await processCallback({
    callbackId: 'a'.repeat(64),
    body: { status: 'success', recordingId: 'recording-123', oneDrivePath: '/Recordings/Call.m4a' },
    completionId: 'request-1',
    nowEpoch: 1000,
  }, deps);
  assert.equal(result.statusCode, 200);
  assert.equal(calls.claim, 1);
  assert.equal(calls.release, 1);
  assert.equal(calls.token, 'secret-task-token');
  assert.equal(calls.output.status, 'success');
  assert.deepEqual(calls.finalize, ['SUCCEEDED']);
});

test('failed callback is released as a failure result and records terminal failure', async () => {
  const { calls, deps } = callbackDeps({ releaseStatus: 'FAILED' });
  const result = await processCallback({
    callbackId: 'a'.repeat(64),
    body: { status: 'failed', error: 'downstream action failed' },
    completionId: 'request-2',
    nowEpoch: 1000,
  }, deps);
  assert.equal(result.statusCode, 200);
  assert.equal(calls.release, 1);
  assert.equal(calls.output.status, 'failed');
  assert.deepEqual(calls.finalize, ['FAILED']);
});

test('duplicate terminal callback is idempotent and does not invoke Step Functions again', async () => {
  const { calls, deps } = callbackDeps({ item: callbackItem({ status: 'SUCCEEDED', taskToken: null }) });
  const result = await processCallback({
    callbackId: 'a'.repeat(64),
    body: { status: 'success' },
    completionId: 'request-3',
    nowEpoch: 1000,
  }, deps);
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.duplicate, true);
  assert.equal(calls.claim, 0);
  assert.equal(calls.release, 0);
});

test('expired callback is rejected and never releases Step Functions', async () => {
  const { calls, deps } = callbackDeps({ item: callbackItem({ expiresAtEpoch: 999 }) });
  const result = await processCallback({
    callbackId: 'a'.repeat(64),
    body: { status: 'success' },
    completionId: 'request-4',
    nowEpoch: 1000,
  }, deps);
  assert.equal(result.statusCode, 410);
  assert.equal(calls.expire, 1);
  assert.equal(calls.release, 0);
});

test('unknown callback is rejected cleanly', async () => {
  const { calls, deps } = callbackDeps({ item: null, claimed: null });
  const result = await processCallback({
    callbackId: 'a'.repeat(64),
    body: { status: 'success' },
    completionId: 'request-5',
    nowEpoch: 1000,
  }, deps);
  assert.equal(result.statusCode, 404);
  assert.equal(calls.release, 0);
});

test('callback metadata is bounded and excludes unapproved fields', () => {
  const output = sanitizeCallbackOutput({
    status: 'success',
    oneNotePage: 'page',
    taskToken: 'must-not-escape',
    url: 'https://signed.example/should-not-escape',
  }, 'recording-123');
  assert.deepEqual(output, { recordingId: 'recording-123', status: 'success', oneNotePage: 'page' });
});

test('state machine starts with Slack, converges both branches, signs late and waits for callback', async () => {
  const template = await fs.readFile(new URL('../template.yaml', import.meta.url), 'utf8');
  assert.match(template, /"StartAt": "NotifySlackStarted"/);
  assert.match(template, /"FinalizeDirect"[\s\S]*?"Next": "PrepareResultArtifacts"/);
  assert.match(template, /"FinalizeStitched"[\s\S]*?"Next": "PrepareResultArtifacts"/);
  assert.match(template, /"SaveHtmlResult"[\s\S]*?"Next": "GenerateDeliveryLinks"/);
  assert.match(template, /lambda:invoke\.waitForTaskToken/);
  assert.match(template, /"TimeoutSeconds": \$\{CallbackTimeoutSeconds\}/);
  assert.match(template, /"Next": "CallbackTimeout"/);
});

test('callback implementation uses success and failure task-token APIs without logging the token', async () => {
  const source = await fs.readFile(new URL('../src/callback.mjs', import.meta.url), 'utf8');
  assert.match(source, /SendTaskSuccessCommand/);
  assert.match(source, /SendTaskFailureCommand/);
  assert.match(source, /REMOVE taskToken/);
  assert.doesNotMatch(source, /console\.(?:info|warn|error)\([^\n]*taskToken/);
});
