# Recordings secrets migration: Bitwarden to SSM Parameter Store

Tracked by #29.

## Current state

GitHub Actions already authenticates to AWS using GitHub OIDC and the existing `GitHubActionsRecordingsDeployRole`. No long-lived AWS access key needs to be added to GitHub.

The deployment workflows support both secret backends during migration:

- `SECRETS_BACKEND=bitwarden` (the default) keeps the existing Bitwarden Secrets Manager path.
- `SECRETS_BACKEND=ssm` loads the same runtime environment variables from SSM Parameter Store after GitHub has assumed the AWS deployment role through OIDC.

This makes the migration reversible while the SSM-backed deployment is validated. Remove the Bitwarden path only after both production deployment workflows have succeeded with `SECRETS_BACKEND=ssm`.

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

## Recommended: bootstrap from the authenticated development environment

`scripts/bootstrap-ssm-migration.sh` performs the migration setup from a local development environment that is already authenticated to AWS, GitHub and Bitwarden Secrets Manager.

Prerequisites:

- `aws` is authenticated to the target AWS account and can update IAM/CloudFormation and SSM.
- `gh` is authenticated and can update Actions variables on `antonio1000homens/recordings`.
- `bws` is authenticated to the Bitwarden Secrets Manager project containing the existing recordings secrets.
- `jq` is installed.
- `CODE_BUCKET` is set locally to the existing recordings SAM deployment bucket, or passed with `--code-bucket`.

The bootstrap:

1. verifies all three authenticated sessions;
2. resolves the existing GitHub OIDC deployment role ARN from AWS;
3. deploys the scoped read-only SSM policy for the GitHub role;
4. discovers the existing Bitwarden records by logical key without printing their values;
5. copies each value directly into the corresponding SSM `SecureString` parameter;
6. verifies the SSM parameter names without reading values back into logs; and
7. creates/updates non-secret GitHub production variables (`AWS_REGION`, `AWS_ROLE_TO_ASSUME`, `CODE_BUCKET`, and `SSM_PREFIX`).

It does **not** change `SECRETS_BACKEND` unless `--activate-ssm` is explicitly supplied.

### 1. Validate everything without making changes

Set the existing deployment bucket in your local shell, then run the dry-run from the repository branch containing this migration:

```bash
export CODE_BUCKET='<existing-recordings-sam-deployment-bucket>'

bash scripts/bootstrap-ssm-migration.sh \
  --code-bucket "$CODE_BUCKET" \
  --dry-run
```

The dry run checks AWS/GitHub/Bitwarden authentication, confirms the existing OIDC role, verifies the code bucket input, and resolves all required Bitwarden secret IDs. It does not change AWS or GitHub.

### 2. Bootstrap IAM, SSM parameters and GitHub variables

```bash
bash scripts/bootstrap-ssm-migration.sh \
  --code-bucket "$CODE_BUCKET"
```

At the end of this run the SSM parameters exist and the GitHub non-secret variables are configured, but the workflows remain on their current backend (normally Bitwarden).

### 3. Activate SSM only after the migration code is merged

After the migration code is present on `master`, run:

```bash
bash scripts/bootstrap-ssm-migration.sh \
  --code-bucket "$CODE_BUCKET" \
  --activate-ssm
```

This repeats the idempotent bootstrap and finally sets the production GitHub Actions variable:

```text
SECRETS_BACKEND=ssm
```

You can also activate it directly without rerunning the bootstrap:

```bash
gh variable set SECRETS_BACKEND \
  --repo antonio1000homens/recordings \
  --env production \
  --body ssm
```

### Bitwarden key/ID overrides

The bootstrap normally finds the required Bitwarden records by their logical key names. If an existing Bitwarden key uses a different name, export its UUID using the same identifier variable already used by the workflows, then rerun the bootstrap:

```bash
export BW_RECORDINGS_SHARED_SECRET='<bitwarden-secret-uuid>'
export BW_GEMINI_API_KEY='<bitwarden-secret-uuid>'
export BW_RECORDINGS_DELIVERY_WEBHOOK='<bitwarden-secret-uuid>'
export BW_RECORDINGS_SLACK_WEBHOOK='<bitwarden-secret-uuid>'
export BW_CF_DEPLOY_API_TOKEN='<bitwarden-secret-uuid>'
export BW_RECORDINGS_WORKER_AWS_ACCESS_KEY_ID='<bitwarden-secret-uuid>'
export BW_RECORDINGS_WORKER_AWS_SECRET_ACCESS_KEY='<bitwarden-secret-uuid>'
```

These variables contain Bitwarden record IDs, not secret values.

The script deliberately does not attempt to read existing GitHub Actions secret values: GitHub does not expose secret values after they have been stored. Secret migration is therefore sourced directly from the authenticated Bitwarden CLI.

## Manual bootstrap equivalent

The commands below describe the same migration if individual steps need to be run manually.

### 1. Give the existing GitHub OIDC role read-only SSM access

Authenticate locally to AWS with an identity that can update IAM policies, then run:

```bash
AWS_REGION=eu-west-2 bash infrastructure/bootstrap-ssm-secrets-access.sh
```

This deploys a policy scoped to:

```text
arn:aws:ssm:eu-west-2:<account-id>:parameter/recordings/prod/*
```

It does not grant `ssm:PutParameter` or `ssm:DeleteParameter` to GitHub Actions.

### 2. Populate the SecureString parameters

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

### 3. Validate access without printing values

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

## GitHub Actions configuration

Both `.github/workflows/deploy.yml` and `.github/workflows/deploy-ingress.yml` read these production environment variables:

| Variable | Recommended value | Purpose |
| --- | --- | --- |
| `SECRETS_BACKEND` | `ssm` | Selects the Parameter Store loader. Defaults to `bitwarden` when unset. |
| `SSM_PREFIX` | `/recordings/prod` | Parameter hierarchy used by the loader. |
| `AWS_REGION` | `eu-west-2` | Region containing the deployment role and parameters. |
| `AWS_ROLE_TO_ASSUME` | existing deploy role ARN | Non-secret OIDC role ARN. The workflows accept the existing secret as a fallback during migration. |
| `CODE_BUCKET` | existing code bucket name | Non-secret deployment configuration. The main deploy workflow accepts the existing secret as a fallback during migration. |

The loader maps the SSM values to the environment variables already consumed by the deployment scripts:

```bash
bash scripts/load-ssm-secrets.sh deploy
bash scripts/load-ssm-secrets.sh ingress
```

Each retrieved value is masked before it is written to `GITHUB_ENV`. The workflows configure AWS credentials before invoking the SSM loader, so SSM access uses the existing GitHub OIDC session rather than static AWS credentials.

## Safe production rollout

1. Merge the migration code while `SECRETS_BACKEND` is unset or set to `bitwarden`; the existing deployment path remains unchanged.
2. Run the local bootstrap without `--activate-ssm` to deploy SSM access, copy Bitwarden values into SSM, and configure non-secret GitHub variables.
3. Set `SECRETS_BACKEND=ssm` using `--activate-ssm` only after the migration code is on `master`.
4. Manually run **Deploy Recordings** with `operation=plan`. Confirm both SAM change sets can be created using SSM-backed secrets.
5. Manually run **Deploy Recordings** with `operation=deploy` and the required confirmation.
6. Manually run **Deploy Recordings Ingress** and confirm the Worker secret sync and deployment complete successfully.
7. If either path fails, set `SECRETS_BACKEND=bitwarden` to roll back secret retrieval without reverting code:

```bash
gh variable set SECRETS_BACKEND \
  --repo antonio1000homens/recordings \
  --env production \
  --body bitwarden
```

The workflow summaries record only the selected backend, never secret values.

## Remove Bitwarden after validation

After both production workflows have succeeded with SSM:

- Remove the Bitwarden action steps and the temporary backend switch.
- Remove `BWS_GITHUB_ACTIONS_RECORDINGS_APP` from the production environment.
- Remove the `BW_*` secret/variable UIDs from the production environment.
- Keep `AWS_ROLE_TO_ASSUME`, `AWS_REGION`, `CODE_BUCKET`, and `SSM_PREFIX` as non-secret Actions variables.
- Keep deployment secret values exclusively in SSM Parameter Store.

The Cloudflare Worker AWS credentials still exist as deployment secrets because the Worker needs them at runtime; this migration moves their source of truth out of GitHub/Bitwarden and into SSM.
