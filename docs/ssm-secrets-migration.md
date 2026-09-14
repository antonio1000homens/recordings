# Recordings secrets migration: Bitwarden to SSM Parameter Store

Tracked by #29.

## Current state

GitHub Actions already authenticates to AWS using GitHub OIDC and the existing `GitHubActionsRecordingsDeployRole`. No long-lived AWS access key needs to be added to GitHub.

The remaining Bitwarden dependency is secret retrieval. The first migration stage adds read-only access for the existing deployment role to `/recordings/prod/*` and provides a loader for the deployment workflows. The workflows can stay on Bitwarden until the SSM values have been populated and verified.

## SSM hierarchy

Use standard `SecureString` parameters under `/recordings/prod`:

| SSM parameter | Used as | Current source |
| --- | --- | --- |
| `/recordings/prod/shared-secret` | `RECORDINGS_TRANSFORM_SHARED_SECRET` / `RECORDINGS_SHARED_SECRET` | `BW_RECORDINGS_SHARED_SECRET` |
| `/recordings/prod/gemini-api-key` | `GEMINI_API_KEY` | `BW_GEMINI_API_KEY` |
| `/recordings/prod/delivery-webhook` | `RECORDINGS_DELIVERY_WEBHOOK` | `BW_RECORDINGS_DELIVERY_WEBHOOK` |
| `/recordings/prod/slack-webhook` | `RECORDINGS_SLACK_WEBHOOK` | `BW_RECORDINGS_SLACK_WEBHOOK` |
| `/recordings/prod/cloudflare/api-token` | `CLOUDFLARE_API_TOKEN` | `BW_CF_DEPLOY_API_TOKEN` |
| `/recordings/prod/worker/aws-access-key-id` | `RECORDINGS_WORKER_AWS_ACCESS_KEY_ID` | `BW_RECORDINGS_WORKER_AWS_ACCESS_KEY_ID` |
| `/recordings/prod/worker/aws-secret-access-key` | `RECORDINGS_WORKER_AWS_SECRET_ACCESS_KEY` | `BW_RECORDINGS_WORKER_AWS_SECRET_ACCESS_KEY` |

The shared secret intentionally has one SSM value even though the two workflows expose it under different environment variable names.

## 1. Give the existing GitHub OIDC role read-only SSM access

Authenticate locally to AWS with an identity that can update IAM policies, then run:

```bash
AWS_REGION=eu-west-2 bash infrastructure/bootstrap-ssm-secrets-access.sh
```

This deploys a policy scoped to:

```text
arn:aws:ssm:eu-west-2:<account-id>:parameter/recordings/prod/*
```

It does not grant `ssm:PutParameter` or `ssm:DeleteParameter` to GitHub Actions.

## 2. Populate the SecureString parameters

Do not commit secret values to this repository. Populate each parameter from a trusted local shell/session, for example:

```bash
aws ssm put-parameter \
  --region eu-west-2 \
  --name /recordings/prod/gemini-api-key \
  --type SecureString \
  --value "$GEMINI_API_KEY" \
  --overwrite
```

Repeat for the parameters in the table above. Use the existing secret values from Bitwarden as the source during the migration.

For the initial migration use the AWS-managed SSM KMS key (the default when `--key-id` is omitted). If a customer-managed KMS key is introduced later, add the narrowly scoped `kms:Decrypt` permission to the GitHub role.

## 3. Validate access without printing values

Assuming the GitHub role (or using an equivalent local identity), confirm the names are retrievable:

```bash
aws ssm get-parameters-by-path \
  --region eu-west-2 \
  --path /recordings/prod \
  --recursive \
  --with-decryption \
  --query 'Parameters[].Name' \
  --output text
```

Do not query `Parameter.Value` during validation in a shared terminal/log.

## 4. Workflow cutover

`scripts/load-ssm-secrets.sh` maps the SSM values to the environment variables already consumed by the deployment scripts:

```bash
bash scripts/load-ssm-secrets.sh deploy
bash scripts/load-ssm-secrets.sh ingress
```

The loader masks every retrieved value before writing it to `GITHUB_ENV`.

The next migration step is to wire this loader into `.github/workflows/deploy.yml` and `.github/workflows/deploy-ingress.yml` behind a temporary backend switch. After an SSM-backed deployment succeeds, remove the Bitwarden action, Bitwarden UIDs, and `BWS_GITHUB_ACTIONS_RECORDINGS_APP` from the production GitHub environment.

## GitHub configuration after cutover

Long term, GitHub should contain only non-secret deployment configuration such as:

- `AWS_REGION=eu-west-2`
- the existing deployment role ARN (this can become an Actions variable rather than a secret)
- optionally `SSM_PREFIX=/recordings/prod`

The deployment secret values themselves remain in SSM Parameter Store.
