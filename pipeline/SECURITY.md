# Pipeline ingress security

## Upload ingress

Tasker must use the stable Cloudflare Worker endpoint:

```text
POST https://recordings.alf-broadcast.co.uk/upload-url
```

and continue sending the existing `x-recordings-auth` shared secret. The Worker rejects missing/invalid client authentication before AWS is invoked, then signs the origin request with AWS SigV4 using the dedicated `recordings-worker-invoker` IAM principal.

The deployed `recordings-upload` Lambda Function URL uses `AWS_IAM`. The invoker identity policy grants only `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` for `recordings-upload`, with `lambda:InvokeFunction` constrained to Function URL invocation. Because the Worker principal and Lambda are in the same AWS account, no Lambda resource-based allow policy is required. The previous public `Principal: '*'` upload permissions are removed from the deployed CloudFormation stack.

The Lambda still validates `x-recordings-auth` as defence in depth. A successful request returns a 900-second presigned S3 `PutObject` URL scoped to a generated `inbox/...` key. Tasker uploads the audio directly to S3; recording bytes do not traverse Cloudflare or Lambda.

`pipeline/deploy.sh` applies the upload Function URL hardening transform to `.aws-sam/build/template.yaml` before every supported deployment, including deployments that reuse CI-built SAM artifacts. The transform fails closed if the expected upload Function URL or public permission resources are not present, preventing a silently incomplete cutover.

## Verification after deployment

1. `GET https://recordings.alf-broadcast.co.uk/healthz` should return the Worker health response.
2. `POST https://recordings.alf-broadcast.co.uk/upload-url` without `x-recordings-auth` should return `401` and should not invoke Lambda.
3. The underlying Lambda Function URL should return `403` to an unsigned request after the `AWS_IAM` cutover.
4. A valid Worker request should return a presigned S3 upload URL.
5. PUT a small audio file to that returned URL and confirm the object lands under `inbox/` and normal S3/EventBridge processing starts.

## Rollback

If Worker-to-Lambda SigV4 invocation fails after cutover, revert the change that introduced the hardening transform and redeploy the pipeline. Do not proxy audio through the Worker or Lambda as a workaround.

## Callback ingress

The callback Function URL remains intentionally separate from this change because external callback consumers cannot be assumed to support AWS SigV4. Its security review is tracked independently in issue #22.
