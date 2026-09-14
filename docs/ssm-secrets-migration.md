# Recordings secrets: AWS SSM Parameter Store

Tracked by #29.

## Current state

The Bitwarden-to-SSM migration is complete.

Production GitHub Actions authenticate to AWS through GitHub OIDC and the existing `GitHubActionsRecordingsDeployRole`. Deployment secrets are loaded exclusively from AWS Systems Manager Parameter Store. GitHub Actions secrets are not used as a deployment-secret source.

The two production workflows are:

- `.github/workflows/deploy.yml`
- `.github/workflows/deploy-ingress.yml`

Both configure AWS credentials through OIDC and then run `scripts/load-ssm-secrets.sh`.

## GitHub production environment variables

The GitHub `production` environment should contain only non-secret deployment configuration:

| Variable | Value / purpose |
| --- | --- |
| `AWS_REGION` | AWS region, normally `eu-west-2`. |
| `AWS_ROLE_TO_ASSUME` | ARN of the GitHub OIDC deployment role. |
| `CODE_BUCKET` | SAM deployment artifact bucket used by the main deployment workflow. |
| `SSM_PREFIX` | `/recordings`. |
| `SLACK_NOTIFICATIONS_ENABLED` | Optional non-secret feature flag. |
| `CALLBACK_TIMEOUT_SECONDS` | Optional non-secret runtime/deployment setting. |

`AWS_ROLE_TO_ASSUME`, `CODE_BUCKET`, and `SSM_PREFIX` are GitHub **variables**, not GitHub secrets.

There is no `SECRETS_BACKEND` switch anymore. SSM is the only supported deployment-secret source.

## SSM hierarchy

Secrets are stored as `SecureString` parameters under `/recordings`:

| SSM parameter | Runtime environment variable |
| --- | --- |
| `/recordings/shared-secret` | `RECORDINGS_TRANSFORM_SHARED_SECRET` / `RECORDINGS_SHARED_SECRET` |
| `/recordings/gemini-api-key` | `GEMINI_API_KEY` |
| `/recordings/delivery-webhook` | `RECORDINGS_DELIVERY_WEBHOOK` |
| `/recordings/slack-webhook` | `RECORDINGS_SLACK_WEBHOOK` |
| `/recordings/cloudflare/api-token` | `CLOUDFLARE_API_TOKEN` |
| `/recordings/worker/aws-access-key-id` | `RECORDINGS_WORKER_AWS_ACCESS_KEY_ID` |
| `/recordings/worker/aws-secret-access-key` | `RECORDINGS_WORKER_AWS_SECRET_ACCESS_KEY` |

The shared secret intentionally has one SSM value even though the main and ingress workflows expose it under different environment variable names.

## Runtime loading

The deployment role has read-only access scoped to:

```text
arn:aws:ssm:<region>:<account-id>:parameter/recordings/*
```

The loader is invoked as:

```bash
bash scripts/load-ssm-secrets.sh deploy
bash scripts/load-ssm-secrets.sh ingress
```

Each retrieved value is masked before being written to `GITHUB_ENV`. The GitHub OIDC role does not need `ssm:PutParameter` or `ssm:DeleteParameter`.

## Bootstrap / refresh from the development environment

`scripts/bootstrap-ssm-migration.sh` remains available for bootstrapping or refreshing the SSM values from the authenticated development environment.

Prerequisites:

- `aws` authenticated to the target AWS account with permission to update the GitHub deployment role policy and SSM parameters;
- `gh` authenticated with permission to update variables on the GitHub `production` environment;
- `bws` authenticated to the Bitwarden Secrets Manager project when importing or refreshing the existing source values;
- `jq` installed.

Create the local, gitignored configuration file:

```bash
cp config/bootstrap-ssm-migration.env.example config/bootstrap-ssm-migration.env
chmod 600 config/bootstrap-ssm-migration.env
```

Validate without changing anything:

```bash
bash scripts/bootstrap-ssm-migration.sh --dry-run
```

Bootstrap or refresh SSM and the GitHub non-secret variables:

```bash
bash scripts/bootstrap-ssm-migration.sh
```

The bootstrap:

1. validates AWS, GitHub, and Bitwarden CLI access;
2. resolves the existing OIDC deployment role;
3. applies the scoped read-only SSM policy to that role;
4. copies the existing values into SSM `SecureString` parameters without printing them or placing them on the process command line;
5. validates the resulting SSM parameter names; and
6. writes `AWS_REGION`, `AWS_ROLE_TO_ASSUME`, `CODE_BUCKET`, and `SSM_PREFIX` as GitHub environment variables.

The workflows already use SSM unconditionally, so there is no separate activation step.

## GitHub cleanup after migration

After this SSM-only workflow change is merged and a deployment has succeeded, the old migration-era GitHub settings are no longer required.

Old GitHub environment secrets that can be removed include:

```text
BWS_GITHUB_ACTIONS_RECORDINGS_APP
BW_RECORDINGS_SHARED_SECRET
BW_GEMINI_API_KEY
BW_RECORDINGS_DELIVERY_WEBHOOK
BW_RECORDINGS_SLACK_WEBHOOK
```

Old GitHub environment variables that can be removed include:

```text
BW_CF_DEPLOY_API_TOKEN
BW_RECORDINGS_WORKER_AWS_ACCESS_KEY_ID
BW_RECORDINGS_WORKER_AWS_SECRET_ACCESS_KEY
SECRETS_BACKEND
```

Keep these non-secret environment variables:

```text
AWS_REGION
AWS_ROLE_TO_ASSUME
CODE_BUCKET
SSM_PREFIX
```

The deployment workflows are guarded by CI so reintroducing GitHub `secrets.*`, the Bitwarden action, `BW_*`, or `SECRETS_BACKEND` references will fail the infrastructure job.

## Validation

After merging the SSM-only cleanup:

1. manually run **Deploy Recordings** with `operation=plan`;
2. confirm both SAM change sets are created successfully using the SSM-loaded values;
3. run **Deploy Recordings** with `operation=deploy` and its confirmation;
4. run **Deploy Recordings Ingress** and confirm the Worker secret sync/deployment succeeds; and
5. remove the obsolete GitHub secrets/variables listed above.

Do not print or query SSM parameter values in shared logs during validation.
