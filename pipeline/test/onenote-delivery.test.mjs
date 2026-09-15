import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDownstreamPayload,
  oneNoteSafeHtml,
} from '../src/delivery.mjs';

test('OneNote-safe HTML adds explicit breaks between adjacent transcript paragraphs', () => {
  const source = '<h2>Transcript</h2><p><b>Me:</b> Hello</p><p><b>Remote:</b> Hi</p>';
  const formatted = oneNoteSafeHtml(source);

  assert.equal(
    formatted,
    '<h2>Transcript</h2><p><b>Me:</b> Hello</p><br/><p><b>Remote:</b> Hi</p>',
  );
  assert.equal(source, '<h2>Transcript</h2><p><b>Me:</b> Hello</p><p><b>Remote:</b> Hi</p>');
});

test('OneNote-safe HTML preserves non-adjacent block structure', () => {
  const source = '<h2>Summary</h2><p>Summary text</p><h2>Transcript</h2><p>First turn</p>\n<p>Second turn</p>';

  assert.equal(
    oneNoteSafeHtml(source),
    '<h2>Summary</h2><p>Summary text</p><h2>Transcript</h2><p>First turn</p><br/><p>Second turn</p>',
  );
});

test('downstream payload keeps the existing transcriptHtml contract but makes it OneNote-safe', () => {
  const transcriptHtml = '<h2>Transcript</h2><p><b>Me:</b> Hello</p><p><b>Remote:</b> Hi</p>';
  const payload = buildDownstreamPayload({
    recordingId: 'recording-123',
    filename: 'Call.m4a',
    processedAt: '2026-09-15T15:30:00.000Z',
    audio: { filename: 'Call.m4a', bucket: 'b', key: 'inbox/r/Call.m4a', url: 'https://signed/audio' },
    html: { filename: 'r.html', bucket: 'b', key: 'results/r.html', url: 'https://signed/html' },
    callName: 'Call',
    transcriptHtml,
  }, {
    url: `https://callback.example/recordings/callback/${'a'.repeat(64)}`,
    expiresAt: '2026-09-15T16:30:00.000Z',
  });

  assert.equal(
    payload.transcriptHtml,
    '<h2>Transcript</h2><p><b>Me:</b> Hello</p><br/><p><b>Remote:</b> Hi</p>',
  );
  assert.equal(transcriptHtml, '<h2>Transcript</h2><p><b>Me:</b> Hello</p><p><b>Remote:</b> Hi</p>');
});
