# Recordings transform

Deterministic transformation service used by the recordings pipeline. It formats Gemini transcription responses, constructs stitching/summary requests, normalises speaker labels and produces final HTML.

## Invocation modes

The Lambda supports two invocation paths:

- direct Lambda invocation from the recordings Step Functions / `recordings-ai` worker using an `action` contract;
- HTTP POST calls through the Function URL for compatible external integrations.

Direct IAM-authorised Lambda invocation does not require the HTTP shared secret. HTTP POST routes require `x-recordings-auth` to match `RECORDINGS_TRANSFORM_SHARED_SECRET`. `GET /healthz` is public.

## Actions / routes

Supported transformations include:

- `metadata-request`
- `plan`
- `transcript`
- `summary-request`
- `prepare-enrichment`
- `finalize`
- `chunks`
- `chunk-transcript`
- `stitch-request`
- `stitch-request-from-blocks`
- `prepare-stitched-enrichment`

## Configuration

Deployment requires:

- `CODE_BUCKET` — private S3 bucket used by SAM for deployment artifacts;
- `RECORDINGS_TRANSFORM_SHARED_SECRET` — application-level secret used for HTTP POST calls;
- optional `AWS_REGION`, defaulting to `eu-west-2`.

Do not commit secret values, recordings, transcripts, generated signed URLs or production integration credentials to this repository.
