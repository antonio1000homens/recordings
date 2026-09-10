export const CHUNK_STEP_SECONDS = 360;
export const CHUNK_LENGTH_SECONDS = 365;

export function safeFilename(value) {
  const text = String(value || 'recording.m4a').split(/[\\/]/).pop() || 'recording.m4a';
  const cleaned = text.replace(/[^A-Za-z0-9._() +\-]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || 'recording.m4a';
}

export function parseDuration(stderr) {
  const match = String(stderr || '').match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) throw new Error('Unable to determine recording duration from ffmpeg output');
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function chunkWindows(durationSeconds) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('durationSeconds must be positive');
  if (duration <= CHUNK_STEP_SECONDS) {
    return [{ index: 0, start_seconds: 0, length_seconds: duration }];
  }
  const windows = [];
  let index = 0;
  for (let start = 0; start < duration; start += CHUNK_STEP_SECONDS) {
    windows.push({
      index,
      start_seconds: start,
      length_seconds: Math.min(CHUNK_LENGTH_SECONDS, duration - start),
    });
    index += 1;
  }
  return windows;
}

export function recordingIdFromKey(key) {
  const parts = String(key || '').split('/').filter(Boolean);
  if (parts[0] === 'inbox' && parts[1]) return parts[1];
  throw new Error('Expected object key under inbox/<recordingId>/...');
}
