# Recordings ingress Worker

This Worker preserves the existing Tasker contract while removing anonymous invocation of the upload Lambda.

## Flow

`Tasker POST /upload-url` -> Worker validates `x-recordings-auth` -> Worker SigV4-signs the same request -> `recordings-upload` IAM-authenticated Function URL -> presigned S3 PUT URL -> Tasker uploads audio directly to S3.

The recording bytes never pass through the Worker or Lambda.

## Authentication

The Worker stores `RECORDINGS_SHARED_SECRET`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` as Cloudflare encrypted secrets. AWS credentials belong to a dedicated least-privilege IAM principal whose only permissions are `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on `recordings-upload`, with `lambda:InvokeFunction` constrained by `lambda:InvokedViaFunctionUrl=true`.

The Lambda remains responsible for validating `x-recordings-auth` as defence in depth. Direct anonymous invocation of its Function URL is disabled with `AuthType: AWS_IAM`.

## Secrets

Run from this directory:

```sh
npx wrangler secret put RECORDINGS_SHARED_SECRET
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
```

Do not commit secret values.

## Deployment sequence

1. Deploy `infrastructure/recordings-worker-invoker.yaml` to create the dedicated least-privilege IAM principal.
2. Create an access key for that principal and add it to the Worker as encrypted secrets.
3. Modify/deploy the main SAM stack so `recordings-upload` uses `AuthType: AWS_IAM` and no longer has wildcard Function URL invoke permissions.
4. Set `UPLOAD_ORIGIN_URL` to that Lambda Function URL and deploy the Worker.
5. Point Tasker at the Worker `/upload-url` endpoint; its request body and `x-recordings-auth` contract remain unchanged.
6. Verify the Worker returns a presigned URL.
7. Verify an unsigned direct POST to the Lambda Function URL returns HTTP 403.

## Credential note

Cloudflare Workers cannot natively assume an AWS IAM role without first possessing an AWS credential or using an additional identity-broker/OIDC design. For this small personal ingress, a dedicated access key with only the two Function URL invocation permissions is deliberately preferred over adding an always-on broker. Rotate/revoke the key independently of the Lambda execution role.

## Safety of this branch

This branch deliberately does **not** switch the production Lambda URL to IAM yet. Doing that before the Worker credentials and endpoint are deployed would interrupt Tasker ingestion. The final SAM cutover should be a coordinated deployment after the Worker secrets have been populated.
