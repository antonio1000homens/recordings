import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkWindows, parseDuration, recordingIdFromKey, safeFilename } from '../src/media-core.mjs';

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
