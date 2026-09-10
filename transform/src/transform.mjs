const CHUNK_STEP_SECONDS = 360;
const CHUNK_LENGTH_SECONDS = 365;

export function unwrap(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'body')) {
    return value.body;
  }
  return value;
}

export function asObject(value, label = 'value') {
  let current = unwrap(value);
  if (typeof current === 'string') {
    try {
      current = JSON.parse(current);
    } catch (error) {
      throw new Error(`${label} is not valid JSON`);
    }
  }
  if (!current || typeof current !== 'object') throw new Error(`${label} must be an object`);
  return current;
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeSpeaker(raw) {
  const text = String(raw ?? '');
  const match = text.match(/(?:spk|speaker)[^0-9]*([0-9]+)/i) || text.match(/([0-9]+)/);
  return match ? match[1] : text;
}

export function metadataRequest(source) {
  const sourceObject = asObject(source, 'source');
  const url = sourceObject['@microsoft.graph.downloadUrl'];
  if (!url) throw new Error('OneDrive download URL missing');
  return {
    tasks: {
      'import-recording': { operation: 'import/url', url, filename: 'recording.m4a' },
      'inspect-recording': { operation: 'metadata', input: 'import-recording' },
    },
    tag: 'recordings-duration-probe',
  };
}

export function parseDurationSeconds(metadataJob) {
  const jobWrapper = asObject(metadataJob, 'metadata');
  const job = jobWrapper.data && typeof jobWrapper.data === 'object' ? jobWrapper.data : jobWrapper;
  const tasks = Array.isArray(job.tasks) ? job.tasks : [];
  const metadataTask = tasks.find((task) => task && task.operation === 'metadata');
  const durationText = metadataTask?.result?.metadata?.Duration;
  if (!durationText) throw new Error('CloudConvert Duration missing');
  const parts = String(durationText).split(':').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`Unexpected Duration: ${durationText}`);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function quoteArgument(value) {
  const text = String(value);
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

export function planRecording(metadataJob, source) {
  const durationSeconds = parseDurationSeconds(metadataJob);
  const sourceObject = asObject(source, 'source');
  const downloadUrl = sourceObject['@microsoft.graph.downloadUrl'];
  if (!downloadUrl) throw new Error('OneDrive download URL missing');

  const args = ['-i', '/input/import-recording/recording.m4a'];
  let chunkCount = 0;
  for (let start = 0; start < durationSeconds; start += CHUNK_STEP_SECONDS) {
    const length = Math.min(CHUNK_LENGTH_SECONDS, durationSeconds - start);
    args.push(
      '-ss', String(start),
      '-t', String(length),
      '-map', '0:a:0',
      '-c:a', 'copy',
      `/output/chunk_${String(chunkCount).padStart(3, '0')}.m4a`,
    );
    chunkCount += 1;
  }

  const chunkRequest = {
    tasks: {
      'import-recording': { operation: 'import/url', url: downloadUrl, filename: 'recording.m4a' },
      'split-recording': {
        operation: 'command',
        input: 'import-recording',
        engine: 'ffmpeg',
        command: 'ffmpeg',
        arguments: args.map(quoteArgument).join(' '),
      },
      'export-chunks': { operation: 'export/url', input: 'split-recording' },
    },
    tag: 'recordings-chunking',
  };

  return {
    duration_seconds: durationSeconds,
    route: durationSeconds > CHUNK_STEP_SECONDS ? 'split' : 'direct',
    chunk_count: chunkCount,
    chunk_request: chunkRequest,
    chunk_step_seconds: CHUNK_STEP_SECONDS,
    overlap_seconds: CHUNK_LENGTH_SECONDS - CHUNK_STEP_SECONDS,
  };
}

export function transcriptHtml(transcriptionResponse) {
  let root = unwrap(transcriptionResponse);
  if (typeof root === 'string') {
    try { root = JSON.parse(root); } catch { return '<p><b>Transcript error:</b> Unable to parse Gemini response.</p>'; }
  }
  root = unwrap(root);
  if (typeof root === 'string') {
    try { root = JSON.parse(root); } catch { return '<p><b>Transcript error:</b> Unable to parse Gemini response body.</p>'; }
  }

  const annotations = [];
  const fallback = [];
  const steps = Array.isArray(root?.steps) ? root.steps : [];
  for (const step of steps) {
    for (const content of (Array.isArray(step?.content) ? step.content : [])) {
      if (content?.text) fallback.push(String(content.text));
      for (const item of (Array.isArray(content?.annotations) ? content.annotations : [])) {
        const type = item && typeof item.type === 'object' ? item.type.type : item?.type;
        if (item && type === 'word_info' && item.text && item.speaker !== undefined && item.speaker !== null) {
          annotations.push({ text: String(item.text), speaker: normalizeSpeaker(item.speaker) });
        }
      }
    }
  }

  if (annotations.length) {
    const groups = [];
    for (const item of annotations) {
      const previous = groups[groups.length - 1];
      if (previous && previous.speaker === item.speaker) previous.words.push(item.text);
      else groups.push({ speaker: item.speaker, words: [item.text] });
    }
    return groups.map((group) => `<p><b>Speaker ${escapeHtml(group.speaker)}:</b> ${escapeHtml(group.words.join(' '))}</p>`).join('');
  }

  const transcript = root?.output_text ? String(root.output_text) : fallback.join('\n');
  return transcript
    ? `<p>${escapeHtml(transcript).replace(/\n/g, '<br/>')}</p>`
    : '<p><b>Transcript unavailable:</b> Gemini returned no transcript text or speaker annotations.</p>';
}

export function summaryRequest(transcript) {
  const text = String(transcript || '');
  const prompt = `Analyse the diarized conversation below. The transcript uses labels such as Speaker 0 and Speaker 1.\n\nTasks:\n1. Identify each speaker from evidence in the conversation, especially introductions and the opening exchanges. Prefer a real first name when clearly supported by the transcript. Never invent a name.\n2. If a real name is not available but the role is clear, use a useful identifier such as Me or Remote. If neither is clear, keep Speaker 0 or Speaker 1.\n3. Return 3 to 8 concise summary points capturing the important facts, decisions, questions, actions, commitments and follow-ups.\n4. Do not rewrite or paraphrase the transcript. Only return speaker labels and summary points; a later deterministic step will rename the transcript.\n\nTranscript:\n${text}`;
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: {
        type: 'OBJECT',
        properties: {
          speaker_0_label: { type: 'STRING' },
          speaker_1_label: { type: 'STRING' },
          speaker_0_reason: { type: 'STRING' },
          speaker_1_reason: { type: 'STRING' },
          summary_points: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['speaker_0_label', 'speaker_1_label', 'summary_points'],
      },
    },
  };
}

export function prepareEnrichment(transcriptionResponse) {
  const transcript_html = transcriptHtml(transcriptionResponse);
  return { transcript_html, gemini_request: summaryRequest(transcript_html) };
}

function extractModelJson(response) {
  let body = unwrap(response);
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return {}; }
  }
  const modelText = body?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (typeof modelText === 'object' && modelText !== null) return modelText;
  try { return JSON.parse(String(modelText || '{}')); } catch { return {}; }
}

export function finalizeEnrichment(transcript, geminiResponse) {
  const transcriptHtmlValue = String(transcript || '');
  const result = extractModelJson(geminiResponse);
  const speaker0 = String(result.speaker_0_label || 'Speaker 0').trim() || 'Speaker 0';
  const speaker1 = String(result.speaker_1_label || 'Speaker 1').trim() || 'Speaker 1';
  const renamed = transcriptHtmlValue
    .replace(/Speaker\s*0(?=:)/gi, escapeHtml(speaker0))
    .replace(/Speaker\s*1(?=:)/gi, escapeHtml(speaker1));
  const points = Array.isArray(result.summary_points) ? result.summary_points.filter(Boolean) : [];
  const summary = points.length
    ? `<h2>Summary</h2><ul>${points.map((point) => `<li>${escapeHtml(point)}</li>`).join('')}</ul>`
    : '<h2>Summary</h2><p>No summary was returned.</p>';
  return {
    formatted_html: `${summary}<h2>Transcript</h2>${renamed}`,
    transcript_html: renamed,
    summary_points: points,
    speaker_0_label: speaker0,
    speaker_1_label: speaker1,
  };
}

export function extractChunks(chunkJob) {
  const wrapper = asObject(chunkJob, 'chunk job');
  const job = wrapper.data && typeof wrapper.data === 'object' ? wrapper.data : wrapper;
  const tasks = Array.isArray(job.tasks) ? job.tasks : [];
  const exportTask = tasks.find((task) => task && task.operation === 'export/url');
  const files = Array.isArray(exportTask?.result?.files) ? exportTask.result.files : [];
  if (!files.length) throw new Error('CloudConvert returned no chunk files');
  return files
    .slice()
    .sort((a, b) => String(a.filename).localeCompare(String(b.filename)))
    .map((file, index) => ({
      filename: file.filename,
      url: file.url,
      index,
      start_seconds: index * CHUNK_STEP_SECONDS,
    }));
}

export function chunkTranscriptBlock(index, startSeconds, transcriptionResponse) {
  return `<<<CHUNK index=${Number(index)} start_seconds=${Number(startSeconds)}>>>\n${transcriptHtml(transcriptionResponse)}\n<<<END_CHUNK>>>\n`;
}

export function normalizeChunkTranscriptAggregate(chunkTranscripts) {
  const text = String(chunkTranscripts || '');
  const pattern = /<<<CHUNK index=(\d+) start_seconds=(\d+)>>>\s*([\s\S]*?)\s*<<<END_CHUNK>>>/g;
  const chunks = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const [, index, startSeconds, responseRaw] = match;
    let response;
    try { response = JSON.parse(responseRaw); }
    catch { throw new Error(`Chunk ${index} Gemini response is not valid JSON`); }
    chunks.push(`<<<CHUNK index=${index} start_seconds=${startSeconds}>>>\n${transcriptHtml(response)}\n<<<END_CHUNK>>>`);
  }
  if (!chunks.length) throw new Error('No chunk responses found in aggregate');
  return chunks.join('\n');
}

export function stitchRequest(chunkTranscripts) {
  const text = normalizeChunkTranscriptAggregate(chunkTranscripts);
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

export function extractStitchedTranscript(geminiResponse) {
  const result = extractModelJson(geminiResponse);
  return String(result.cleaned_transcript_html || '');
}

export function prepareStitchedEnrichment(geminiResponse) {
  const transcript_html = extractStitchedTranscript(geminiResponse);
  return { transcript_html, gemini_request: summaryRequest(transcript_html) };
}
