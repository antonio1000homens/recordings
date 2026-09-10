import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTransform } from '../src/direct.mjs';

test('direct invocation prepares enrichment without HTTP wrapper', () => {
  const result = applyTransform('prepare-enrichment', { transcription: { output_text: 'hello' } });
  assert.match(result.transcript_html, /hello/);
  assert.equal(result.gemini_request.contents[0].role, 'user');
});

test('stitch request from compact blocks sorts by chunk index', () => {
  const result = applyTransform('stitch-request-from-blocks', {
    blocks: [
      { index: 1, chunk_transcript: '<<<CHUNK index=1 start_seconds=360>>>second<<<END_CHUNK>>>' },
      { index: 0, chunk_transcript: '<<<CHUNK index=0 start_seconds=0>>>first<<<END_CHUNK>>>' },
    ],
  });
  const prompt = result.gemini_request.contents[0].parts[0].text;
  const firstChunk = '<<<CHUNK index=0 start_seconds=0>>>first<<<END_CHUNK>>>';
  const secondChunk = '<<<CHUNK index=1 start_seconds=360>>>second<<<END_CHUNK>>>';
  assert.ok(prompt.indexOf(firstChunk) >= 0);
  assert.ok(prompt.indexOf(secondChunk) >= 0);
  assert.ok(prompt.indexOf(firstChunk) < prompt.indexOf(secondChunk));
});
