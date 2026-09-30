import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDownstreamPayload,
  oneNoteSafeHtml,
} from '../src/delivery.mjs';

const sourceHtml = '<h2>Summary</h2><ul><li>First summary point.</li><li>Second summary point.</li></ul><h2>Transcript</h2><p><b>Automated System:</b> Hello.</p><p><b>Me:</b> Hello.</p>';

test('OneNote-safe HTML preserves headings, summary bullets, speaker labels, and turns', () => {
  const formatted = oneNoteSafeHtml(sourceHtml);

  assert.equal(
    formatted,
    '<b>Summary</b><br/><br/>• First summary point.<br/>• Second summary point.<br/><br/><b>Transcript</b><br/><br/><b>Automated System:</b> Hello.<br/><br/><b>Me:</b> Hello.<br/><br/>',
  );
  assert.match(formatted, /<b>Summary<\/b><br\/><br\/>/);
  assert.match(formatted, /First summary point\.<br\/>• Second summary point\./);
  assert.match(formatted, /<b>Transcript<\/b><br\/><br\/>/);
  assert.match(formatted, /<b>Automated System:<\/b> Hello\.<br\/><br\/><b>Me:<\/b> Hello\./);
});

test('OneNote-safe HTML preserves escaped content and does not mutate canonical HTML', () => {
  const canonicalHtml = '<h2>Transcript</h2><p><b>Me:</b> &lt;hello &amp; goodbye&gt;</p>';
  const original = canonicalHtml;

  assert.equal(
    oneNoteSafeHtml(canonicalHtml),
    '<b>Transcript</b><br/><br/><b>Me:</b> &lt;hello &amp; goodbye&gt;<br/><br/>',
  );
  assert.equal(canonicalHtml, original);
});

test('OneNote-safe HTML is idempotent', () => {
  const formatted = oneNoteSafeHtml(sourceHtml);
  assert.equal(oneNoteSafeHtml(formatted), formatted);
});

test('OneNote-safe HTML supports numbered lists and paragraphs without block dependence', () => {
  assert.equal(
    oneNoteSafeHtml('<ol><li>First</li><li>Second</li></ol><p>Turn</p>'),
    '1. First<br/>2. Second<br/><br/>Turn<br/><br/>',
  );
});

test('downstream payload retains transcriptHtml contract and applies only delivery formatting', () => {
  const payload = buildDownstreamPayload({
    recordingId: 'recording-123',
    filename: 'Call.m4a',
    processedAt: '2026-09-15T15:30:00.000Z',
    audio: { filename: 'Call.m4a', bucket: 'b', key: 'inbox/r/Call.m4a', url: 'https://signed/audio' },
    html: { filename: 'r.html', bucket: 'b', key: 'results/r.html', url: 'https://signed/html' },
    callName: 'Call',
    transcriptHtml: sourceHtml,
  }, {
    url: `https://callback.example/recordings/callback/${'a'.repeat(64)}`,
    expiresAt: '2026-09-15T16:30:00.000Z',
  });

  assert.equal(payload.transcriptHtml, oneNoteSafeHtml(sourceHtml));
  assert.equal(sourceHtml, '<h2>Summary</h2><ul><li>First summary point.</li><li>Second summary point.</li></ul><h2>Transcript</h2><p><b>Automated System:</b> Hello.</p><p><b>Me:</b> Hello.</p>');
  assert.equal(payload.html.url, 'https://signed/html');
  assert.equal(payload.audio.url, 'https://signed/audio');
});
