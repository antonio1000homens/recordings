import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import ffmpegPath from 'ffmpeg-static';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { chunkWindows, parseDuration, recordingIdFromKey, safeFilename } from './media-core.mjs';

const s3 = new S3Client({});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stderr) : reject(new Error(`Command failed (${code}): ${stderr.slice(-4000)}`)));
  });
}

async function download(bucket, key, target) {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(result.Body, (await import('node:fs')).createWriteStream(target));
  return result.ContentType || 'audio/mp4';
}

async function upload(bucket, key, file, contentType) {
  const body = await fs.readFile(file);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

async function probeDuration(inputPath) {
  const stderr = await run(ffmpegPath, ['-hide_banner', '-i', inputPath, '-map', '0:a:0', '-f', 'null', '-']);
  return parseDuration(stderr);
}

function sourceMetadata(bucket, key, contentType) {
  const rawFilename = String(key || '').split('/').pop() || 'recording.m4a';
  let filename = rawFilename;
  try { filename = decodeURIComponent(rawFilename); } catch { /* keep raw S3 key component */ }
  return {
    bucket,
    key,
    filename: safeFilename(filename),
    content_type: contentType,
  };
}

export async function handler(event) {
  const bucket = event?.bucket;
  const key = event?.key;
  if (!bucket || !key) throw new Error('bucket and key are required');

  const recordingId = recordingIdFromKey(key);
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), `recording-${recordingId}-`));
  const inputPath = path.join(workdir, 'input.m4a');

  try {
    const contentType = event.content_type || await download(bucket, key, inputPath);
    const source = sourceMetadata(bucket, key, contentType);
    const durationSeconds = await probeDuration(inputPath);
    const windows = chunkWindows(durationSeconds);

    if (windows.length === 1) {
      return {
        recording_id: recordingId,
        source,
        route: 'direct',
        duration_seconds: durationSeconds,
        chunk_step_seconds: 360,
        overlap_seconds: 5,
        chunks: [{
          index: 0,
          start_seconds: 0,
          length_seconds: durationSeconds,
          bucket,
          key,
          content_type: contentType,
        }],
      };
    }

    const chunks = [];
    for (const window of windows) {
      const filename = `chunk_${String(window.index).padStart(3, '0')}.m4a`;
      const outputPath = path.join(workdir, filename);
      await run(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-ss', String(window.start_seconds),
        '-i', inputPath,
        '-t', String(window.length_seconds),
        '-map', '0:a:0',
        '-c:a', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-y', outputPath,
      ]);
      const outputKey = `processing/${recordingId}/chunks/${filename}`;
      await upload(bucket, outputKey, outputPath, contentType);
      chunks.push({
        ...window,
        bucket,
        key: outputKey,
        content_type: contentType,
      });
    }

    return {
      recording_id: recordingId,
      source,
      route: 'split',
      duration_seconds: durationSeconds,
      chunk_step_seconds: 360,
      overlap_seconds: 5,
      chunks,
    };
  } finally {
    await fs.rm(workdir, { recursive: true, force: true });
  }
}
