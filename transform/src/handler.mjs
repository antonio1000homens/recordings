import crypto from 'node:crypto';
import { applyTransform } from './direct.mjs';

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

function body(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  return JSON.parse(raw);
}

function pathToAction(path) {
  return String(path || '/').replace(/^\//, '');
}

export async function handler(event) {
  // IAM-authenticated Lambda invocations from Step Functions/recordings-ai use
  // a compact action contract and deliberately bypass the public HTTP secret.
  if (event?.action) {
    try {
      return applyTransform(event.action, event.input || {});
    } catch (error) {
      console.error(JSON.stringify({ service: 'recordings-transform', action: event.action, error: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  }

  const method = event?.requestContext?.http?.method || 'GET';
  const path = event?.rawPath || '/';

  if (method === 'GET' && path === '/healthz') return json(200, { ok: true, service: 'recordings-transform' });
  if (method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const expectedSecret = process.env.RECORDINGS_TRANSFORM_SHARED_SECRET || '';
  const headers = normalizedHeaders(event.headers);
  if (!equalSecret(headers['x-recordings-auth'], expectedSecret)) return json(401, { error: 'unauthorized' });

  let input;
  try { input = body(event); } catch { return json(400, { error: 'invalid_json' }); }

  try {
    return json(200, applyTransform(pathToAction(path), input));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ service: 'recordings-transform', path, error: message }));
    if (message.startsWith('Unsupported transform action:')) return json(404, { error: 'not_found' });
    return json(400, { error: 'transform_failed', message });
  }
}
