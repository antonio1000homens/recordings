import {
  chunkTranscriptBlock,
  extractChunks,
  finalizeEnrichment,
  metadataRequest,
  planRecording,
  prepareEnrichment,
  prepareStitchedEnrichment,
  stitchRequest,
  summaryRequest,
  transcriptHtml,
} from './transform.mjs';

function stitchRequestFromBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('blocks must be a non-empty array');
  const text = blocks
    .slice()
    .sort((a, b) => Number(a.index) - Number(b.index))
    .map((item) => String(item.chunk_transcript || ''))
    .filter(Boolean)
    .join('\n');
  if (!text) throw new Error('blocks contain no chunk transcripts');
  const prompt = `Stitch the following independently transcribed chunks from one continuous phone recording. Consecutive chunks overlap by 5 seconds. Speaker labels are local to each chunk and can swap between chunks.\n\nRules:\n1. Remove only dialogue duplicated because of the 5-second overlap.\n2. Preserve all non-duplicate dialogue and wording as faithfully as possible. Do not summarise or omit content.\n3. Resolve speaker continuity across chunks and assign consistent global labels Speaker 0, Speaker 1, etc. Do not identify real names yet.\n4. Return the cleaned transcript as HTML paragraphs exactly in the form <p><b>Speaker N:</b> text</p>.\n5. Do not include chunk markers in the cleaned transcript.\n\nChunk transcripts:\n${text}`;
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: {
        type: 'OBJECT',
        properties: { cleaned_transcript_html: { type: 'STRING' } },
        required: ['cleaned_transcript_html'],
      },
    },
  };
}

export function applyTransform(action, input = {}) {
  switch (action) {
    case 'metadata-request': return { request: metadataRequest(input.source) };
    case 'plan': return planRecording(input.metadata, input.source);
    case 'transcript': return { transcript_html: transcriptHtml(input.transcription) };
    case 'summary-request': return { gemini_request: summaryRequest(input.transcript_html) };
    case 'prepare-enrichment': return prepareEnrichment(input.transcription);
    case 'finalize': return finalizeEnrichment(input.transcript_html, input.gemini_response);
    case 'chunks': return { chunks: extractChunks(input.job) };
    case 'chunk-transcript': return { chunk_transcript: chunkTranscriptBlock(input.index, input.start_seconds, input.transcription) };
    case 'stitch-request': return { gemini_request: stitchRequest(input.chunk_transcripts) };
    case 'stitch-request-from-blocks': return { gemini_request: stitchRequestFromBlocks(input.blocks) };
    case 'prepare-stitched-enrichment': return prepareStitchedEnrichment(input.gemini_response);
    default: throw new Error(`Unsupported transform action: ${action}`);
  }
}
