# Recordings ingress operations

## Trust and cost boundaries

The public ingress is `https://recordings.alf-broadcast.co.uk` on Cloudflare Workers. Tasker and downstream delivery consumers do not hold AWS credentials.

- `/upload-url` requires `x-recordings-auth` at the Worker. The Worker then SigV4-signs the request to the `recordings-upload` Function URL.
- `/recordings/callback/<capability>` is routed through the same Worker. The opaque 256-bit callback ID is the per-execution capability; the Worker validates route/JSON shape and SigV4-signs the request to `recordings-callback`.
- Both Lambda Function URLs are deployed with `AWS_IAM`; unsigned direct-origin calls must be denied.
- The upload Lambda only creates a 900-second S3 `PutObject` URL scoped under `inbox/`. Audio bytes travel directly from Tasker to S3, not through Cloudflare or Lambda.
- Expensive work begins after an object lands under `inbox/`. `recordings-media` performs an S3 HEAD before download/FFmpeg and rejects objects larger than `MAX_RECORDING_BYTES`. The code default is 250 MiB when the environment variable is absent. Oversize objects fail before FFmpeg chunking and before any Gemini call.
- No AWS WAF, reserved Lambda concurrency, or other fixed-cost ingress service is intentionally required for this personal-volume design.

## Production smoke verification

Run these checks after ingress or pipeline security changes.

1. Worker health
   - `GET https://recordings.alf-broadcast.co.uk/healthz`
   - Expect HTTP 200.
2. Edge authentication
   - `POST https://recordings.alf-broadcast.co.uk/upload-url` without `x-recordings-auth`.
   - Expect HTTP 401 before AWS invocation.
3. Raw upload origin
   - Invoke the underlying `recordings-upload` Function URL without SigV4.
   - Expect AWS HTTP 403.
4. Valid upload path
   - POST a normal Tasker payload with the valid shared secret.
   - Confirm the response contains a key under `inbox/`, a presigned `upload_url`, `expires_in_seconds: 900`, and required content-type headers.
5. Direct S3 PUT
   - Upload a small test audio object to the returned presigned URL.
   - Confirm the object lands under `inbox/` and the normal EventBridge/Step Functions execution starts.
6. Size guardrail
   - Do not upload a large object merely to test production. Unit tests cover the threshold behavior. If a controlled integration test is needed, temporarily use a low `MAX_RECORDING_BYTES` in a non-production environment.
7. Raw callback origin
   - Invoke the underlying `recordings-callback` Function URL without SigV4.
   - Expect AWS HTTP 403.
8. Callback path
   - Complete a normal downstream delivery and verify the callback URL uses `recordings.alf-broadcast.co.uk/recordings/callback/<capability>`.
   - Confirm one valid callback releases the waiting Step Functions task and a replay is treated as a duplicate rather than releasing it again.

## Rollback

If Worker-to-Lambda invocation fails after a deployment:

1. Revert the change that modified ingress/hardening behavior and redeploy through the normal GitHub Actions pipeline.
2. Do not proxy recording bytes through Lambda or Cloudflare as a workaround.
3. Do not make a Function URL public permanently to restore service. A temporary rollback to the last known-good repository revision is preferred because CloudFormation then owns the policy state and avoids drift.
4. Re-run the smoke checks above before restoring normal recording use.

## Shared-secret compromise

If `x-recordings-auth` is suspected compromised:

1. Rotate the recordings shared secret in Bitwarden Secrets Manager.
2. Update Tasker with the new value.
3. Run the normal ingress and application deployment so the Worker and upload Lambda receive the same rotated secret.
4. Verify the old secret returns 401 at the Worker and the new secret can obtain a presigned URL.
5. Review Cloudflare/AWS request and Lambda logs for unusual request volume. The secret alone cannot directly invoke the IAM-protected Lambda origin, but possession of it allows presign requests through the public Worker until rotation.

## Size-limit configuration

`MAX_RECORDING_BYTES` is read by `recordings-media`. When unset, the default is 250 MiB (`262144000` bytes). Set it only to a positive integer. Choose a value comfortably above legitimate phone-recording sizes while keeping enough margin to block unexpectedly large or abusive objects before expensive processing.
