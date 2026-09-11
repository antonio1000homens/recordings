export const CHUNK_STEP_SECONDS = 360;
export const CHUNK_LENGTH_SECONDS = 365;

export function safeFilename(value) {
  const text = String(value || 'recording.m4a').split(/[\\/]/).pop() || 'recording.m4a';
  const cleaned = text.replace(/[^A-Za-z0-9._() +\-]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || 'recording.m4a';
}

function filenameStem(value) {
  const text = String(value || 'recording.m4a').split(/[\\/]/).pop() || 'recording.m4a';
  return text.replace(/\.[^.]+$/, '');
}

function validTimestampParts({ year, month, day, hour, minute, second }) {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (Number.isNaN(date.getTime())) return null;
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) return null;
  return { year, month, day, hour, minute, second };
}

function embeddedTimestampParts(stem) {
  const match = String(stem || '').match(/(?:^|[ _-])(?:(\d{4})(\d{2})(\d{2})|(\d{2})(\d{2})(\d{2}))[_-](\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;

  return validTimestampParts({
    year: match[1] ? Number(match[1]) : 2000 + Number(match[4]),
    month: Number(match[2] || match[5]),
    day: Number(match[3] || match[6]),
    hour: Number(match[7]),
    minute: Number(match[8]),
    second: Number(match[9]),
  });
}

function utcTimestampParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('now must be a valid date');
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function recordingLabel(stem) {
  const withoutTimestamp = String(stem || '').replace(/[ _-]\d{6,8}[_-]\d{6}$/, '');
  const withoutRecorderPrefix = withoutTimestamp.replace(/^(?:call[ _-]*recording|voice[ _-]*recording|recording)[ _-]*/i, '');
  const normalized = withoutRecorderPrefix.normalize('NFKD').replace(/\p{M}/gu, '');
  const slug = normalized
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'recording';
}

export function buildRecordingId(filename, { now = new Date(), uniqueId = '' } = {}) {
  const stem = filenameStem(filename);
  const timestamp = embeddedTimestampParts(stem) || utcTimestampParts(now);
  const suffix = String(uniqueId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'unknown';
  const date = `${timestamp.year}${pad2(timestamp.month)}${pad2(timestamp.day)}`;
  const time = `${pad2(timestamp.hour)}${pad2(timestamp.minute)}`;
  return `${date}-${time}-${recordingLabel(stem)}-${suffix}`;
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
