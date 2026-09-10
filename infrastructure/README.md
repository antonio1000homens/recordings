# Deployment bootstrap

The production recordings stacks are intentionally not deployed automatically from this public repository yet.

The first cutover uses a dedicated GitHub Actions OIDC role and a dedicated Bitwarden Secrets Manager machine account/project. The existing private monorepo remains the deployment owner until the new path has been proven.

## 1. Bootstrap the AWS OIDC deployment role

The AWS account already needs the GitHub Actions OIDC provider for `token.actions.githubusercontent.com`.

Run the bootstrap from a trusted local/admin AWS identity, supplying the existing private SAM deployment bucket used by the current recordings deployment:

```bash
AWS_REGION=eu-west-2 \
CODE_BUCKET='aws2022-lambda-code' \
bash infrastructure/bootstrap-deployment-role.sh
```

The script creates/updates the stack `recordings-github-actions-deploy-role` and prints the dedicated deployment-role ARN.

This repository was created after GitHub enabled immutable OIDC subjects for new repositories. Because the deployment job references the `production` environment, the AWS trust policy matches that immutable environment subject rather than a branch-form subject:

```text
repo:antonio1000homens@36929120/recordings@1364314008:environment:production
```

The workflow independently refuses to run unless `github.ref` is exactly `refs/heads/master`.

The role policy is restricted to the existing recordings stacks, Lambda functions, runtime roles, log groups, recordings bucket, Step Functions state machine, EventBridge rule and only these SAM deployment artifact prefixes:

```text
recordings/pipeline/*
recordings/transform/*
```

The old top-level SAM artifact prefixes may remain in the code bucket as historical deployment objects; the recordings-only role does not require access to them.

## 2. GitHub `production` environment

Create an environment named `production` and restrict **Deployment branches and tags** to `master` only.

Add these environment secrets:

- `AWS_ROLE_TO_ASSUME` — output ARN from the bootstrap stack.
- `CODE_BUCKET` — `aws2022-lambda-code`.
- `BWS_GITHUB_ACTIONS_RECORDINGS_APP` — access token for a Bitwarden Secrets Manager machine account scoped only to the recordings project.

Add these environment variables:

- `BW_RECORDINGS_SHARED_SECRET` — Bitwarden secret ID for the recordings HTTP shared secret.
- `BW_GEMINI_API_KEY` — Bitwarden secret ID for the recordings Gemini API key.
- `AWS_REGION` — optional; defaults to `eu-west-2`.

Secret IDs are identifiers rather than secret values, but keeping them as environment variables scopes the deployment configuration to `production`.

## 3. Bitwarden structure

Recommended Bitwarden Secrets Manager layout:

```text
Project: recordings
  RECORDINGS_TRANSFORM_SHARED_SECRET
  GEMINI_API_KEY

Machine account: github-actions-recordings
  Read access: recordings project only
```

During migration, create recordings-project secret entries without deleting/moving the entries still used by the private monorepo. This allows both deployment paths to coexist until cutover is verified.

Prefer a Gemini API key dedicated to recordings. If the existing key must be reused initially, copy its value into a recordings-project secret entry rather than granting the new machine account access to an unrelated project.

## 4. Plan before deploying

`.github/workflows/deploy.yml` is deliberately `workflow_dispatch` only and refuses to run unless the selected ref is `master`.

For the first cutover, always run **Deploy Recordings** with:

```text
operation: plan
confirm_deploy: false
pipeline_enabled: true
```

Plan mode uses the same built templates, secrets, stack names, SAM code bucket and artifact prefixes as a real deployment, but passes `--no-execute-changeset` to SAM. CloudFormation creates change sets for inspection and does not update stack resources.

Plan mode also refuses to delete/recreate a stack if an existing stack is in an unrecoverable state. Recovery actions remain deploy-only and should be reviewed separately.

Inspect the generated change-set tables in the workflow log. Pay particular attention to any `Remove`, unexpected `Add`, or replacement of stateful resources such as the recordings S3 bucket, Lambda functions, Step Functions state machine or EventBridge rule.

## 5. First deployment

Only after the plan has been reviewed and accepted, manually run **Deploy Recordings** again from `master` with:

```text
operation: deploy
confirm_deploy: true
pipeline_enabled: true
```

The workflow deploys transform first, then pipeline, and verifies that both CloudFormation stacks and the Step Functions state machine are describable afterwards.

Leave the private monorepo deployment in place during this first public-repository deployment. Then run one direct recording and one chunked recording through the existing endpoint and verify final HTML/result generation.

Only after those checks pass should the private monorepo workflows/source be removed.

## Rollback

Do not delete the existing recordings CloudFormation stacks during repository migration.

If the new deployment path fails, stop using the public-repo deployment workflow and continue deploying from the private monorepo while the problem is corrected. Because stack names and resource names are preserved, repository migration should not itself require an AWS data migration.
