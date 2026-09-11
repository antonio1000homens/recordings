import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractChunks,
  finalizeEnrichment,
  planRecording,
  prepareEnrichment,
  stitchRequest,
  transcriptHtml,
} from '../src/transform.mjs';

const source = { '@microsoft.graph.downloadUrl': 'https://example.test/audio.m4a' };
function metadata(duration) {
  return { data: { tasks: [{ operation: 'metadata', result: { metadata: { Duration: duration } } }] } };
}

test('25:17 recording is split into five overlapping chunks', () => {
  const result = planRecording(metadata('0:25:17'), source);
  assert.equal(result.duration_seconds, 1517);
  assert.equal(result.route, 'split');
  assert.equal(result.chunk_count, 5);
  assert.equal(result.overlap_seconds, 5);
  assert.match(result.chunk_request.tasks['split-recording'].arguments, /chunk_004\.m4a/);
});

test('six minutes stays direct and six minutes one second splits', () => {
  assert.equal(planRecording(metadata('0:06:00'), source).route, 'direct');
  assert.equal(planRecording(metadata('0:06:01'), source).route, 'split');
});

test('transcript annotations are grouped by speaker', () => {
  const response = {
    body: {
      steps: [{ content: [{ annotations: [
        { type: 'word_info', text: 'Hello', speaker: 'spk:0' },
        { type: 'word_info', text: 'there', speaker: 'spk:0' },
        { type: 'word_info', text: 'Hi', speaker: 'spk:1' },
      ] }] }],
    },
  };
  assert.equal(transcriptHtml(response), '<p><b>Speaker 0:</b> Hello there</p><p><b>Speaker 1:</b> Hi</p>');
});

test('prepare enrichment returns transcript and Gemini request', () => {
  const result = prepareEnrichment({ body: { output_text: 'plain transcript' } });
  assert.match(result.transcript_html, /plain transcript/);
  assert.equal(result.gemini_request.contents[0].role, 'user');
});

test('enrichment prompt instructs Gemini to label Antonio as Me', () => {
  const result = prepareEnrichment({ body: { output_text: 'Antonio Ferreira speaking' } });
  const prompt = result.gemini_request.contents[0].parts[0].text;
  assert.match(prompt, /One participant is always the owner of this recording, Antonio/);
  assert.match(prompt, /Antonio Ferreira/);
  assert.match(prompt, /set that speaker's label to exactly Me/);
  assert.match(prompt, /use Me rather than Antonio or a surname/);
});

test('enrichment prompt asks Gemini to reconstruct labels when speaker tags are missing', () => {
  const result = prepareEnrichment({ body: { output_text: 'Hello Antonio. Hi Sarah.' } });
  const prompt = result.gemini_request.contents[0].parts[0].text;
  assert.match(prompt, /transcript has lost its speaker-turn labels/i);
  assert.match(prompt, /labelled_transcript_html/);
  assert.match(prompt, /Preserve every word and its order as faithfully as possible/);
  assert.ok(result.gemini_request.generationConfig.response_schema.required.includes('labelled_transcript_html'));
});

test('enrichment prompt keeps deterministic rename path when speaker tags exist', () => {
  const result = prepareEnrichment({
    body: {
      steps: [{ content: [{ annotations: [
        { type: 'word_info', text: 'Hello', speaker: 'spk:0' },
        { type: 'word_info', text: 'Hi', speaker: 'spk:1' },
      ] }] }],
    },
  });
  const prompt = result.gemini_request.contents[0].parts[0].text;
  assert.match(prompt, /already contains usable Speaker N labels/);
  assert.match(prompt, /Set labelled_transcript_html to an empty string/);
});

test('finalize enrichment renames speakers and emits summary', () => {
  const gemini = {
    body: {
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        speaker_0_label: 'Alex',
        speaker_1_label: 'Taylor',
        summary_points: ['Appointment confirmed'],
        labelled_transcript_html: '',
      }) }] } }],
    },
  };
  const result = finalizeEnrichment('<p><b>Speaker 0:</b> Hello</p><p><b>Speaker 1:</b> Hi</p>', gemini);
  assert.match(result.formatted_html, /<b>Alex:<\/b>/);
  assert.match(result.formatted_html, /Appointment confirmed/);
});

test('finalize enrichment uses reconstructed speaker turns when original labels are missing', () => {
  const gemini = {
    body: {
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        speaker_0_label: 'Me',
        speaker_1_label: 'Sarah',
        summary_points: ['Me spoke with Sarah'],
        labelled_transcript_html: '<p><b>Speaker 0:</b> Hello Sarah.</p><p><b>Speaker 1:</b> Hi Antonio.</p>',
      }) }] } }],
    },
  };
  const result = finalizeEnrichment('<p>Hello Sarah. Hi Antonio.</p>', gemini);
  assert.equal(result.transcript_html, '<p><b>Me:</b> Hello Sarah.</p><p><b>Sarah:</b> Hi Antonio.</p>');
  assert.match(result.formatted_html, /<b>Me:<\/b>/);
  assert.match(result.formatted_html, /<b>Sarah:<\/b>/);
});

test('finalize enrichment ignores reconstructed transcript when original speaker tags exist', () => {
  const gemini = {
    body: {
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        speaker_0_label: 'Me',
        speaker_1_label: 'Sarah',
        summary_points: [],
        labelled_transcript_html: '<p><b>Speaker 0:</b> altered text</p>',
      }) }] } }],
    },
  };
  const result = finalizeEnrichment('<p><b>Speaker 0:</b> original text</p>', gemini);
  assert.equal(result.transcript_html, '<p><b>Me:</b> original text</p>');
  assert.doesNotMatch(result.transcript_html, /altered text/);
});

test('chunk exports are sorted and annotated', () => {
  const result = extractChunks({ data: { tasks: [{ operation: 'export/url', result: { files: [
    { filename: 'chunk_001.m4a', url: 'b' },
    { filename: 'chunk_000.m4a', url: 'a' },
  ] } }] } });
  assert.deepEqual(result, [
    { filename: 'chunk_000.m4a', url: 'a', index: 0, start_seconds: 0 },
    { filename: 'chunk_001.m4a', url: 'b', index: 1, start_seconds: 360 },
  ]);
});

test('stitch request formats raw aggregated Gemini chunk responses before prompting', () => {
  const response = {
    steps: [{ content: [{ annotations: [
      { type: 'word_info', text: 'Hello', speaker: 'spk:0' },
      { type: 'word_info', text: 'Taylor', speaker: 'spk:1' },
    ] }] }],
  };
  const aggregate = `<<<CHUNK index=0 start_seconds=0>>>\n${JSON.stringify(response)}\n<<<END_CHUNK>>>`;
  const request = stitchRequest(aggregate);
  const prompt = request.contents[0].parts[0].text;
  assert.match(prompt, /<b>Speaker 0:<\/b> Hello/);
  assert.match(prompt, /<b>Speaker 1:<\/b> Taylor/);
  assert.doesNotMatch(prompt, /word_info/);
});
