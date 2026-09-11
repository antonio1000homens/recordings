import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecordingId, chunkWindows, parseDuration, recordingIdFromKey, safeFilename } from '../src/media-core.mjs';

test('25:17 recording produces five overlapping windows', () => {
  const windows = chunkWindows(1517);
  assert.equal(windows.length, 5);
  assert.deepEqual(windows.map(({start_seconds, length_seconds}) => [start_seconds, length_seconds]), [
    [0, 365], [360, 365], [720, 365], [1080, 365], [1440, 77],
  ]);
});

test('six minutes is direct and 6:01 is split', () => {
  assert.equal(chunkWindows(360).length, 1);
  assert.equal(chunkWindows(361).length, 2);
});

test('duration parser reads ffmpeg Duration', () => {
  assert.equal(parseDuration('Duration: 00:25:17.04, start: 0.000000'), 1517.04);
});

test('filename and recording id are safe', () => {
  assert.equal(safeFilename('../../Call: test?.m4a'), 'Call_ test_.m4a');
  assert.equal(recordingIdFromKey('inbox/abc123/call.m4a'), 'abc123');
});

test('recording id uses Samsung filename timestamp and call name', () => {
  assert.equal(
    buildRecordingId('Call recording British Gas Boiler Service_260906_093458.m4a', {
      now: new Date('2030-01-01T00:00:00Z'),
      uniqueId: '123e4567-test-id',
    }),
    '20260906-0934-british-gas-boiler-service-123e4567',
  );
});

test('recording id falls back to upload UTC time and a generic label', () => {
  assert.equal(
    buildRecordingId('Call recording.m4a', {
      now: new Date('2026-09-11T09:40:12Z'),
      uniqueId: 'abcdef12-test-id',
    }),
    '20260911-0940-recording-abcdef12',
  );
});

test('recording id supports YYYYMMDD timestamps and safe compact labels', () => {
  assert.equal(
    buildRecordingId('Voice recording Café & Support_20260911_104512.m4a', {
      uniqueId: 'feedface-test-id',
    }),
    '20260911-1045-cafe-and-support-feedface',
  );
});
