import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

const s3 = new S3Client({});
const lambda = new LambdaClient({});
const API_KEY = process.env.GEMINI_API_KEY || '';
const TRANSFORM_FUNCTION = process.env.TRANSFORM_FUNCTION_NAME || 'recordings-transform';
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash-lite';

class GeminiRateLimitError extends Error {
  constructor(message) { super(message); this.name = 'GeminiRateLimitError'; }
}
class GeminiTransientError extends Error {
  constructor(message) { super(message); this.name = 'GeminiTransientError'; }
}

async function responseJson(response, label) {
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (response.ok) return body;
  const message = `${label} failed with HTTP ${response.status}: ${text.slice(0, 1000)}`;
  if (response.status === 429) throw new GeminiRateLimitError(message);
  if (response.status >= 500) throw new GeminiTransientError(message);
  throw new Error(message);
}

async function s3Buffer(bucket, key) {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (result.Body?.transformToByteArray) return { bytes: Buffer.from(await result.Body.transformToByteArray()), contentType: result.ContentType };
  const chunks = [];
  for await (const chunk of result.Body) chunks.push(Buffer.from(chunk));
  return { bytes: Buffer.concat(chunks), contentType: result.ContentType };
}

async function uploadGemini(bytes, mimeType, displayName) {
  const start = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'x-goog-api-key': API_KEY,
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(bytes.length),
      'x-goog-upload-header-content-type': mimeType,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!start.ok) await responseJson(start, 'Gemini upload start');
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini upload start returned no upload URL');

  const finish = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'x-goog-upload-offset': '0',
      'x-goog-upload-command': 'upload, finalize',
      'content-length': String(bytes.length),
      'content-type': mimeType,
    },
    body: bytes,
  });
  const body = await responseJson(finish, 'Gemini upload');
  if (!body?.file?.uri || !body?.file?.name) throw new Error('Gemini upload returned no file URI/name');
  return body.file;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGeminiFile(file, { timeoutMs = 60000, pollMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let current = file;
  while (true) {
    const state = String(current?.state || '').toUpperCase();
    if (state === 'ACTIVE') return current;
    if (state === 'FAILED') throw new Error(`Gemini file processing failed for ${file.name}`);
    if (Date.now() >= deadline) throw new GeminiTransientError(`Timed out waiting for Gemini file ${file.name} to become ACTIVE`);

    await sleep(pollMs);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}`, {
      headers: { 'x-goog-api-key': API_KEY },
    });
    current = await responseJson(response, 'Gemini file status');
  }
}

async function deleteGeminiFile(file) {
  if (!file?.name) return;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}`, {
    method: 'DELETE', headers: { 'x-goog-api-key': API_KEY },
  });
  if (!response.ok && response.status !== 404) console.warn(`Gemini file cleanup failed: ${response.status}`);
}

async function transcribe(file, mimeType) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-3.5-transcribe',
      input: [{ type: 'audio', uri: file.uri, mime_type: mimeType }],
      generation_config: {
        transcription_config: {
          mode: { type: 'verbatim', diarization_mode: 'speaker' },
        },
      },
    }),
  });
  return responseJson(response, 'Gemini transcription');
}

async function invokeTransform(action, input) {
  const response = await lambda.send(new InvokeCommand({
    FunctionName: TRANSFORM_FUNCTION,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify({ action, input })),
  }));
  const payload = response.Payload ? JSON.parse(Buffer.from(response.Payload).toString('utf8')) : {};
  if (response.FunctionError) throw new Error(`Transform Lambda failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function transcribeItem(item, mode) {
  if (!item?.bucket || !item?.key) throw new Error('chunk bucket/key are required');
  const { bytes, contentType } = await s3Buffer(item.bucket, item.key);
  const mimeType = item.content_type || contentType || 'audio/mp4';
  const file = await uploadGemini(bytes, mimeType, item.key.split('/').pop() || 'recording.m4a');
  try {
    const activeFile = await waitForGeminiFile(file);
    const transcription = await transcribe(activeFile, mimeType);
    if (mode === 'direct') {
      return invokeTransform('prepare-enrichment', { transcription });
    }
    const transformed = await invokeTransform('chunk-transcript', {
      index: item.index,
      start_seconds: item.start_seconds,
      transcription,
    });
    return {
      index: item.index,
      start_seconds: item.start_seconds,
      chunk_transcript: transformed.chunk_transcript,
    };
  } finally {
    await deleteGeminiFile(file);
  }
}

async function generate(request) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(TEXT_MODEL)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  return responseJson(response, 'Gemini text generation');
}

export async function handler(event) {
  if (!API_KEY) throw new Error('GEMINI_API_KEY is not configured');
  switch (event?.action) {
    case 'transcribe_direct': return transcribeItem(event.item, 'direct');
    case 'transcribe_chunk': return transcribeItem(event.item, 'chunk');
    case 'generate': return generate(event.request);
    default: throw new Error(`Unsupported recordings-ai action: ${event?.action}`);
  }
}
