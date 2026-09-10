# Recordings pipeline

AWS-native ingestion, chunking and Gemini orchestration for phone recordings.

## Flow

1. A client requests a pre-signed S3 PUT from `recordings-upload` using `POST /upload-url`.
2. The client uploads the M4A directly to the private recordings bucket.
3. S3 emits `Object Created`; EventBridge starts the Standard Step Functions workflow when `PipelineEnabled=true`.
4. `recordings-media` downloads the recording, probes it with FFmpeg, and either passes the original through (<= 360 seconds) or creates 365-second chunks every 360 seconds (5-second overlap).
5. `recordings-ai` uploads each item to Gemini Files, calls `gemini-3.5-transcribe` with speaker diarization, deletes the temporary Gemini file, and invokes `recordings-transform` to compact the raw annotation response before it reaches Step Functions.
6. Chunked recordings are processed sequentially with a 65-second wait between transcription calls, stitched with `gemini-3.5-flash-lite`, then summarised and speaker-renamed using the deterministic transform Lambda.
7. Final HTML is written to `s3://<bucket>/results/<recording-id>.html`.

The pipeline deliberately keeps raw Gemini word annotations out of Step Functions so the 256 KiB state limit is not consumed by timestamp/diarization metadata.

## Upload API

```http
POST <UploadFunctionUrl>/upload-url
x-recordings-auth: <shared secret>
content-type: application/json

{"filename":"Call recording.m4a","content_type":"audio/mp4"}
```

Then PUT the file bytes to the returned `upload_url` using the returned required headers. Do not Base64 encode the audio.

## Configuration

Deployment requires these values to be supplied outside source control:

- `CODE_BUCKET` — private S3 bucket used by SAM for deployment artifacts.
- `RECORDINGS_TRANSFORM_SHARED_SECRET` — shared secret used by the upload and transform HTTP endpoints.
- `GEMINI_API_KEY` — Gemini API credential.
- `PIPELINE_ENABLED` — optional; defaults to `true` in `deploy.sh`.
- `AWS_REGION` — optional; defaults to `eu-west-2`.

The production CI migration will retrieve secrets through a recordings-scoped secret-management credential and assume a recordings-scoped GitHub Actions OIDC role. No deployment credentials belong in this repository.

## Rollout safety

The SAM template itself defaults `PipelineEnabled` to `false`. During a first deployment into a new environment, keep the EventBridge rule disabled until the Gemini and transform configuration is confirmed.

## Retention and privacy

Objects under `processing/` expire after one day. Original recordings under `inbox/` are retained unless a separate lifecycle policy is configured. The bucket blocks public access; making this source repository public must not make recording data public.
