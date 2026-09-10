import crypto from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { recordingIdFromKey, safeFilename } from './media-core.mjs';

export const SIGNED_URL_EXPIRY_SECONDS = 1800;
export const CALLBACK_EXPIRY_SECONDS = 3600;
export const MAX_HTTP_ATTEMPTS = 3;

const s3 = new S3Client({});
let ddbClient;
let ddbCommands;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function decodeKeyFilename(key) {
  const raw = String(key || '').split('/').pop() || 'recording.m4a';
  try {
    return safeFilename(decodeURIComponent(raw));
  } catch {
    return safeFilename(raw);
  }
}

function requireString(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function artifact(value, name) {
  return {
    bucket: requireString(value?.bucket, `${name}.bucket`),
    key: requireString(value?.key, `${name}.key`),
    filename: safeFilename(value?.filename || decodeKeyFilename(value?.key)),
  };
}

export function isTransientHttpStatus(status) {
  return status === 429 || status >= 500;
}

export class HttpDeliveryError extends Error {
  constructor(message, { status = null, transient = false } = {}) {
    super(message);
    this.name = transient ? 'TransientWebhookError' : 'PermanentWebhookError';
    this.status = status;
    this.transient = transient;
  }
}

export async function postJsonWithRetry(url, payload, {
  maxAttempts = MAX_HTTP_ATTEMPTS,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
} = {}) {
  requireString(url, 'webhook URL');
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) return { attempts: attempt, status: response.status };

      const transient = isTransientHttpStatus(response.status);
      const error = new HttpDeliveryError('Webhook returned an unsuccessful response', {
        status: response.status,
        transient,
      });
      if (!transient) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof HttpDeliveryError && !error.transient) throw error;
      lastError = error instanceof HttpDeliveryError
        ? error
        : new HttpDeliveryError('Webhook network request failed', { transient: true });
    }

    if (attempt < maxAttempts) {
      await sleepImpl(500 * (2 ** (attempt - 1)));
    }
  }

  throw lastError || new HttpDeliveryError('Webhook delivery failed', { transient: true });
}

export function buildStartedSlackMessage({ recordingId, filename }) {
  return [
    '*Recording workflow started*',
    `File: ${filename || 'unknown'}`,
    `Recording ID: \`${recordingId || 'unknown'}\``,
  ].join('\n');
}

export function buildReadySlackMessage(delivery) {
  return [
    '*Recording ready*',
    `File: ${delivery.filename}`,
    `Recording ID: \`${delivery.recordingId}\``,
    `<${delivery.audio.url}|Audio> | <${delivery.html.url}|Transcript>`,
    'Links expire in 30 minutes.',
  ].join('\n');
}

async function notifySlack({ text, stage, recordingId }) {
  if (!boolEnv('SLACK_NOTIFICATIONS_ENABLED', true)) {
    return { delivered: false, skipped: true };
  }

  const webhook = String(process.env.RECORDINGS_SLACK_WEBHOOK || '').trim();
  if (!webhook) {
    console.warn('Slack notification skipped because configuration is missing', { stage, recordingId });
    return { delivered: false, skipped: true };
  }

  try {
    const result = await postJsonWithRetry(webhook, { text });
    console.info('Slack notification delivered', { stage, recordingId, attempts: result.attempts });
    return { delivered: true, attempts: result.attempts };
  } catch (error) {
    console.warn('Slack notification failed and will not block recording processing', {
      stage,
      recordingId,
      error: error.name,
      status: error.status || undefined,
    });
    return { delivered: false, error: error.name };
  }
}

async function assertObjectExists(item) {
  await s3.send(new HeadObjectCommand({ Bucket: item.bucket, Key: item.key }));
}

async function signedGetUrl(item) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: item.bucket, Key: item.key }),
    { expiresIn: SIGNED_URL_EXPIRY_SECONDS },
  );
}

async function getDynamoDb() {
  if (!ddbClient) {
    const module = await import('@aws-sdk/client-dynamodb');
    ddbCommands = module;
    ddbClient = new module.DynamoDBClient({});
  }
  return { client: ddbClient, commands: ddbCommands };
}

async function markCallbackDeliveryFailed(callbackId) {
  const tableName = requireString(process.env.CALLBACK_TABLE, 'CALLBACK_TABLE');
  const { client, commands } = await getDynamoDb();
  await client.send(new commands.UpdateItemCommand({
    TableName: tableName,
    Key: { callbackId: { S: callbackId } },
    UpdateExpression: 'SET #status = :failed, failedAt = :failedAt REMOVE taskToken',
    ConditionExpression: '#status = :pending',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':pending': { S: 'PENDING' },
      ':failed': { S: 'DELIVERY_FAILED' },
      ':failedAt': { S: new Date().toISOString() },
    },
  }));
}

async function createCallbackRecord({ callbackId, taskToken, recordingId, expiresAt, expiresAtEpoch }) {
  const tableName = requireString(process.env.CALLBACK_TABLE, 'CALLBACK_TABLE');
  const { client, commands } = await getDynamoDb();
  await client.send(new commands.PutItemCommand({
    TableName: tableName,
    Item: {
      callbackId: { S: callbackId },
      taskToken: { S: taskToken },
      recordingId: { S: recordingId },
      status: { S: 'PENDING' },
      createdAt: { S: new Date().toISOString() },
      expiresAt: { S: expiresAt },
      expiresAtEpoch: { N: String(expiresAtEpoch) },
    },
    ConditionExpression: 'attribute_not_exists(callbackId)',
  }));
}

function callbackUrl(callbackId) {
  const base = requireString(process.env.CALLBACK_BASE_URL, 'CALLBACK_BASE_URL');
  return new URL(`recordings/callback/${callbackId}`, base.endsWith('/') ? base : `${base}/`).toString();
}

export function buildDownstreamPayload(delivery, callback) {
  return {
    recordingId: delivery.recordingId,
    filename: delivery.filename,
    processedAt: delivery.processedAt,
    audio: delivery.audio,
    html: delivery.html,
    callback,
  };
}

async function notifyStarted(event) {
  const key = requireString(event.key, 'key');
  const recordingId = event.recordingId || recordingIdFromKey(key);
  const filename = event.filename || decodeKeyFilename(key);
  return notifySlack({
    text: buildStartedSlackMessage({ recordingId, filename }),
    stage: 'started',
    recordingId,
  });
}

async function generateLinks(event) {
  const recordingId = requireString(event.recordingId, 'recordingId');
  const audio = artifact(event.artifacts?.audio, 'artifacts.audio');
  const html = artifact(event.artifacts?.html, 'artifacts.html');

  await Promise.all([assertObjectExists(audio), assertObjectExists(html)]);
  const [audioUrl, htmlUrl] = await Promise.all([signedGetUrl(audio), signedGetUrl(html)]);

  const delivery = {
    recordingId,
    filename: audio.filename,
    processedAt: new Date().toISOString(),
    audio: { ...audio, url: audioUrl },
    html: { ...html, url: htmlUrl },
  };

  console.info('Artifact links generated', {
    recordingId,
    audio: { bucket: audio.bucket, key: audio.key, expiresInSeconds: SIGNED_URL_EXPIRY_SECONDS },
    html: { bucket: html.bucket, key: html.key, expiresInSeconds: SIGNED_URL_EXPIRY_SECONDS },
  });

  return delivery;
}

async function notifyReady(event) {
  const delivery = event.delivery;
  if (!delivery?.recordingId || !delivery?.audio?.url || !delivery?.html?.url) {
    throw new Error('delivery with signed audio and html URLs is required');
  }
  return notifySlack({
    text: buildReadySlackMessage(delivery),
    stage: 'ready',
    recordingId: delivery.recordingId,
  });
}

async function deliverAndWait(event) {
  const taskToken = requireString(event.taskToken, 'taskToken');
  const delivery = event.delivery;
  const recordingId = requireString(delivery?.recordingId, 'delivery.recordingId');
  requireString(delivery?.audio?.url, 'delivery.audio.url');
  requireString(delivery?.html?.url, 'delivery.html.url');

  const callbackId = crypto.randomBytes(32).toString('hex');
  const expiresAtEpoch = Math.floor(Date.now() / 1000) + CALLBACK_EXPIRY_SECONDS;
  const expiresAt = new Date(expiresAtEpoch * 1000).toISOString();
  const callback = { url: callbackUrl(callbackId), expiresAt };

  await createCallbackRecord({ callbackId, taskToken, recordingId, expiresAt, expiresAtEpoch });

  const webhook = requireString(process.env.RECORDINGS_DELIVERY_WEBHOOK, 'RECORDINGS_DELIVERY_WEBHOOK');
  try {
    const result = await postJsonWithRetry(webhook, buildDownstreamPayload(delivery, callback));
    console.info('Downstream recording webhook accepted', {
      recordingId,
      attempts: result.attempts,
      status: result.status,
    });
    return { recordingId, callbackId, expiresAt, delivered: true };
  } catch (error) {
    try {
      await markCallbackDeliveryFailed(callbackId);
    } catch (markError) {
      console.warn('Unable to mark callback record after webhook failure', {
        recordingId,
        error: markError.name,
      });
    }
    console.error('Downstream recording webhook delivery failed', {
      recordingId,
      error: error.name,
      status: error.status || undefined,
    });
    throw error;
  }
}

export async function handler(event) {
  switch (event?.action) {
    case 'notify_started':
      return notifyStarted(event);
    case 'generate_links':
      return generateLinks(event);
    case 'notify_ready':
      return notifyReady(event);
    case 'deliver_and_wait':
      return deliverAndWait(event);
    default:
      throw new Error('Unsupported delivery action');
  }
}
