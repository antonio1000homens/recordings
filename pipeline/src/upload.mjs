import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { buildRecordingId, safeFilename } from './media-core.mjs';

const s3 = new S3Client({});
const BUCKET = process.env.RECORDINGS_BUCKET;
const SHARED_SECRET = process.env.RECORDINGS_SHARED_SECRET || '';

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

function normalizedHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value ?? '')]));
}

function equalSecret(candidate, expected) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function parseBody(event) {
  const raw = event?.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '{}';
  return JSON.parse(raw);
}

export async function handler(event) {
  const method = event?.requestContext?.http?.method || 'GET';
  const path = event?.rawPath || '/';
  if (method === 'GET' && path === '/healthz') return json(200, { ok: true, service: 'recordings-upload' });
  if (method !== 'POST' || path !== '/upload-url') return json(404, { error: 'not_found' });

  const headers = normalizedHeaders(event.headers);
  if (!equalSecret(headers['x-recordings-auth'], SHARED_SECRET)) return json(401, { error: 'unauthorized' });

  let input;
  try { input = parseBody(event); } catch { return json(400, { error: 'invalid_json' }); }
  const filename = safeFilename(input.filename);
  const contentType = String(input.content_type || input.contentType || 'audio/mp4');
  if (!/^audio\//i.test(contentType)) return json(400, { error: 'invalid_content_type' });

  const recordingId = buildRecordingId(filename, { uniqueId: randomUUID() });
  const key = `inbox/${recordingId}/${filename}`;
  const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

  return json(200, {
    recording_id: recordingId,
    bucket: BUCKET,
    key,
    upload_url: uploadUrl,
    expires_in_seconds: 900,
    required_headers: { 'content-type': contentType },
  });
}
