# Recordings pipeline

AWS-native ingestion, chunking, Gemini orchestration and callback-based external delivery for phone recordings.

## Flow

1. A client requests a pre-signed S3 PUT from the Cloudflare ingress using `POST /upload-url`.
2. The client uploads the M4A directly to the private recordings bucket.
3. S3 emits `Object Created`; EventBridge starts the Standard Step Functions workflow when `PipelineEnabled=true`.
4. `recordings-delivery` sends a best-effort **Recording workflow started** Slack notification. Slack failure never blocks processing.
5. `recordings-media` probes/chunks the recording as required.
6. `recordings-ai` transcribes with Gemini and invokes `recordings-transform` to compact annotation data.
7. Chunked recordings are processed sequentially, stitched, summarised and speaker-renamed before delivery.
8. Final HTML is written to `s3://<bucket>/results/<recording-id>.html`.
9. `recordings-delivery` creates private 30-minute pre-signed `GET` URLs for the source audio and result HTML.
10. A best-effort **Recording ready** Slack message contains labelled Audio/Transcript links.
11. The workflow enters a Step Functions `waitForTaskToken` task. `recordings-delivery` creates a cryptographically random callback ID, stores the callback-ID-to-task-token mapping in the private `recordings-callbacks` DynamoDB table, and POSTs the recording payload to the configured downstream webhook.
12. The downstream consumer calls the opaque callback URL on `recordings.alf-broadcast.co.uk`. Cloudflare validates the route/body, SigV4-signs the origin request, and invokes the IAM-protected `recordings-callback` Function URL. A success callback uses `SendTaskSuccess`; a failure callback uses `SendTaskFailure`.

The pipeline deliberately keeps raw Gemini word annotations out of Step Functions so the 256 KiB state limit is not consumed by timestamp/diarization metadata. External delivery happens only after the HTML result exists, so webhook/callback failures do not cause transcription stages to be rerun inside the same execution path.

## Upload API

```http
POST https://recordings.alf-broadcast.co.uk/upload-url
x-recordings-auth: <shared secret>
content-type: application/json

{"filename":"Call recording.m4a","content_type":"audio/mp4"}
```

Then PUT the file bytes to the returned `upload_url` using the returned required headers. Do not Base64 encode the audio.

## Downstream webhook contract

The initial consumer is IFTTT event `newrecording`, but the AWS workflow intentionally uses a generic JSON webhook contract:

```json
{
  "recordingId": "<stable recording id>",
  "filename": "Call recording.m4a",
  "processedAt": "2026-09-10T18:00:00.000Z",
  "audio": {
    "filename": "Call recording.m4a",
    "url": "<30-minute pre-signed GET URL>",
    "bucket": "<recordings bucket>",
    "key": "inbox/<recording-id>/Call recording.m4a"
  },
  "html": {
    "filename": "<recording-id>.html",
    "url": "<30-minute pre-signed GET URL>",
    "bucket": "<recordings bucket>",
    "key": "results/<recording-id>.html"
  },
  "callback": {
    "url": "https://recordings.alf-broadcast.co.uk/recordings/callback/<opaque-callback-id>",
    "expiresAt": "<ISO-8601 timestamp>"
  }
}
```

The downstream webhook is retried only for network failures, HTTP 429 and HTTP 5xx, using three bounded attempts with exponential backoff. Permanent HTTP 4xx responses fail delivery without an uncontrolled retry loop. The payload contains the stable `recordingId`; consumers should use that identifier for deduplication if a failed execution is deliberately redriven or replayed. Exactly-once HTTP delivery cannot be guaranteed.

The pre-signed URLs and callback URL are intentionally provided to the downstream consumer. The raw Step Functions task token is stored only in DynamoDB and is never placed in the webhook payload or callback URL.

## Callback API

The public callback endpoint accepts only:

```http
POST https://recordings.alf-broadcast.co.uk/recordings/callback/<opaque-callback-id>
content-type: application/json
```

Success example:

```json
{
  "recordingId": "<same stable recording id>",
  "status": "success",
  "source": "ifttt",
  "filename": "Call recording.m4a",
  "processedAt": "2026-09-10T18:00:00.000Z"
}
```

Generic failure example:

```json
{
  "recordingId": "<same stable recording id>",
  "status": "failed",
  "error": "downstream action failed"
}
```

Only `status` is required; when `recordingId` is supplied it must match the callback record. Callback IDs are 256-bit random bearer capabilities. Cloudflare rejects malformed callback paths, invalid JSON and unsupported status values before AWS invocation, then signs valid-looking requests with AWS SigV4. The underlying `recordings-callback` Function URL uses `AWS_IAM` and is not anonymously invokable.

The Lambda/DynamoDB layer remains authoritative. Unknown callbacks return 404, expired callbacks return 410, and conditional updates ensure the first terminal callback wins. Repeated callbacks after success/failure are acknowledged as duplicates without invoking Step Functions again. The task token is removed from the table after terminal completion.

IFTTT currently has no reliable failure branch for later OneDrive/OneNote action failures. Its final action should therefore call the success callback only after those actions have run. If it never reaches that action, the Step Functions callback wait times out instead of marking the workflow complete.

## Slack notifications

Slack is operator observability only. There are two stages:

- **started** — emitted before FFmpeg/Gemini work begins and contains only filename/recording ID metadata;
- **ready** — emitted after the signed URLs exist and contains labelled Audio/Transcript links plus the 30-minute expiry notice.

Slack network errors, HTTP 429 and HTTP 5xx receive a small bounded retry. Permanent HTTP 4xx responses are not repeatedly retried. All Slack failures are non-fatal to the recording workflow. Webhook secrets are never logged; the ready message is the intentional exception where temporary signed artifact URLs are sent to Slack.

## Configuration

Deployment requires these values to be supplied outside source control:

- `CODE_BUCKET` — private S3 bucket used by SAM for deployment artifacts.
- `RECORDINGS_TRANSFORM_SHARED_SECRET` — shared secret used by the upload and transform HTTP endpoints.
- `GEMINI_API_KEY` — Gemini API credential.
- `RECORDINGS_DELIVERY_WEBHOOK` — full downstream webhook URL; initially the IFTTT `newrecording` endpoint.
- `RECORDINGS_SLACK_WEBHOOK` — Slack incoming-webhook URL when Slack notifications are enabled.
- `SLACK_NOTIFICATIONS_ENABLED` — optional; defaults to `true`.
- `CALLBACK_TIMEOUT_SECONDS` — optional; integer from 2700 through 3600, defaults to `3600`.
- `PIPELINE_ENABLED` — optional; defaults to `true` in `deploy.sh`.
- `AWS_REGION` — optional; defaults to `eu-west-2`.

For the protected production GitHub environment, source control contains only secret names, never secret values or Bitwarden UUIDs. The ingress deployment also resolves both Lambda Function URLs from AWS and deploys them to the Cloudflare Worker as non-secret runtime configuration. The Worker AWS access key is stored only as Cloudflare secrets.

`recordings-callback` has only DynamoDB callback lookup/update plus `states:SendTaskSuccess`/`states:SendTaskFailure`; it cannot read S3 objects or access outbound webhook secrets. Possession of an unexpired opaque callback capability is required to complete a wait, and possession of the raw Lambda Function URL is insufficient because the origin requires AWS IAM authentication.

See `SECURITY.md` for trust boundaries, callback replay/expiry semantics, verification and rollback procedures.

## Rollout safety

The SAM template itself defaults `PipelineEnabled` to `false`. During a first deployment into a new environment, keep the EventBridge rule disabled until Gemini, Slack, downstream webhook and callback configuration are confirmed.

## Retention and privacy

Objects under `processing/` expire after one day. Original recordings under `inbox/` are retained unless a separate lifecycle policy is configured. The bucket blocks public access; signed artifact URLs are GET-only and expire after 30 minutes. Callback records use DynamoDB TTL and retain only correlation metadata while active. Making this source repository public does not make recording data public.
