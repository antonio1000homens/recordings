# Cloudflare Worker -> AWS authentication

## Selected design

The Worker performs client authentication at the edge and signs the origin request using AWS Signature Version 4. The Lambda Function URL must be changed to `AWS_IAM`; its public `Principal: '*'` Function URL permissions must be removed/replaced as part of production rollout.

AWS requires IAM-authenticated Function URL callers to have both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` (for new Function URLs since October 2025). `infrastructure/recordings-worker-invoker.yaml` creates a dedicated principal with exactly those permissions for `recordings-upload` and constrains `lambda:InvokeFunction` to Function URL invocation.

The Worker uses `aws4fetch`, which is designed around Fetch/SubtleCrypto and works in Cloudflare Workers. The access key and shared Tasker secret are Worker encrypted secrets.

## Why an IAM user here

The preferred security property is no anonymous AWS origin. A Worker is not an AWS workload with an instance/task execution role. Direct SigV4 therefore needs AWS credentials. An OIDC/STS broker can remove the long-lived access key, but it adds another externally callable AWS endpoint and significantly more moving parts for this personal, low-volume service. The dedicated IAM user has no permissions other than invoking this one Function URL, so the blast radius of the Worker credential is deliberately narrow.

Do not reuse GitHub Actions credentials, Lambda execution roles, account-level keys, or credentials from other Cloudflare integrations.

## Production rollout still required

The main SAM template currently owns the upload Function URL. Before switching Tasker to the Worker, modify that URL to `AuthType: AWS_IAM` and replace the current wildcard URL permissions. This should be done in the same deployment window as Worker configuration so ingestion is not accidentally left unavailable.

The callback Function URL is intentionally not changed by this implementation; its external-caller contract must be handled separately.
