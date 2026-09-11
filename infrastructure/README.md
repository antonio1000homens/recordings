# Deployment bootstrap

Production deployment is CI-gated from this public repository. A successful `CI` run caused by a same-repository `push` to `master` automatically deploys the exact tested revision through the protected `production` environment.

The deployment path uses a dedicated GitHub Actions OIDC role and a dedicated Bitwarden Secrets Manager machine account/project.

## 1. Bootstrap the AWS OIDC deployment role

The AWS account already needs the GitHub Actions OIDC provider for `token.actions.githubusercontent.com`.

Run the bootstrap from a trusted local/admin AWS identity, supplying the existing private SAM deployment bucket used by the recordings deployment:

```bash
AWS_REGION=eu-west-2 \
CODE_BUCKET='<existing-sam-code-bucket>' \
bash infrastructure/bootstrap-deployment-role.sh
```

The script creates/updates the stack `recordings-github-actions-deploy-role` and prints the dedicated deployment-role ARN.

This repository was created after GitHub enabled immutable OIDC subjects for new repositories. Because the deployment job references the `production` environment, the AWS trust policy matches that immutable environment subject rather than a branch-form subject:

```text
repo:antonio1000homens@36929120/recordings@1364314008:environment:production
```

Automatic deployment is additionally constrained in the workflow itself. It accepts only a completed `CI` workflow where:

- the triggering CI conclusion is `success`;
- the CI event was `push`, not `pull_request`;
- the head branch is `master`;
- the head repository is this repository, not a fork;
- the tested SHA is still the current `master` when deployment begins.

The deployment checks out that exact tested SHA. A stale CI rerun for an older `master` revision is refused rather than rolling production backwards.

The role policy is restricted to the recordings stacks, Lambda functions, runtime roles, log groups, recordings bucket, DynamoDB callback table, Step Functions state machine, EventBridge rule and only these SAM deployment artifact prefixes:

```text
recordings/pipeline/*
recordings/transform/*
```

## 2. GitHub `production` environment

Create an environment named `production` and restrict **Deployment branches and tags** to `master` only.

Add these environment secrets:

- `AWS_ROLE_TO_ASSUME` — output ARN from the bootstrap stack.
- `CODE_BUCKET` — existing private SAM deployment bucket name.
- `BWS_GITHUB_ACTIONS_RECORDINGS_APP` — access token for a Bitwarden Secrets Manager machine account scoped only to the recordings project.
- `BW_RECORDINGS_SHARED_SECRET` — Bitwarden secret UUID for the recordings HTTP shared secret.
- `BW_GEMINI_API_KEY` — Bitwarden secret UUID for the recordings Gemini API key.
- `BW_RECORDINGS_DELIVERY_WEBHOOK` — Bitwarden secret UUID for the downstream recording-delivery webhook.
- `BW_RECORDINGS_SLACK_WEBHOOK` — Bitwarden secret UUID for the Slack incoming webhook when Slack notifications are enabled.

Optional environment variables:

- `AWS_REGION` — defaults to `eu-west-2`.
- `SLACK_NOTIFICATIONS_ENABLED` — defaults to `true`.
- `CALLBACK_TIMEOUT_SECONDS` — defaults to `3600`.

The Bitwarden UUIDs are identifiers rather than secret values, but they are stored as GitHub environment secrets so they are masked in public Actions logs.

If the `production` environment has **required reviewers**, automatic deployment will pause for GitHub approval. For completely unattended CI-to-production deployment, do not configure a required-reviewer protection rule. Branch/tag restrictions and the workflow's same-repository successful-push checks remain in force.

## 3. Bitwarden structure

Recommended Bitwarden Secrets Manager layout:

```text
Project: recordings
  RECORDINGS_TRANSFORM_SHARED_SECRET
  GEMINI_API_KEY
  RECORDINGS_DELIVERY_WEBHOOK
  RECORDINGS_SLACK_WEBHOOK

Machine account: github-actions-recordings
  Read access: recordings project only
```

The machine account must have **Can read** access to the `recordings` project, and the GitHub `BW_*` environment secrets must contain the UUIDs of the individual secrets above, not the project UUID. Bitwarden returns `404 Resource not found` when the authenticated machine account cannot access a requested secret UUID.

Prefer a Gemini API key dedicated to recordings. If an existing key must be reused, copy its value into a recordings-project secret entry rather than granting the recordings machine account access to an unrelated project.

## 4. Automatic deployment

`.github/workflows/deploy.yml` listens for completion of the `CI` workflow. A successful `push` CI run on current `master` starts production deployment automatically with the safe production defaults:

```text
operation: deploy
pipeline_enabled: true
confirm_stack_recreate: false
```

The automatic path follows a build-once/deploy-many model. The `transform` and `pipeline` CI jobs each run tests, validation and `sam build`, then publish their `.aws-sam/build` output as one-day GitHub Actions artifacts. Pull-request CI does not publish deployment artifacts.

The deployment workflow uses the triggering CI run ID to download those exact build outputs. It does not run `npm ci`, application tests or `sam build` again for an automatic deployment. The deployment scripts run with `SKIP_SAM_BUILD=true`, so the code packaged and deployed is the same SAM build that passed CI.

Automatic deployment still:

1. checks out the exact CI-tested SHA and refuses stale CI reruns;
2. re-runs the cheap public-source safety check before credentials are loaded;
3. downloads the transform and pipeline SAM artifacts from the triggering CI run;
4. verifies both downloaded artifacts contain `.aws-sam/build/template.yaml`;
5. validates protected configuration exists;
6. resolves runtime secrets through the recordings-scoped Bitwarden machine account;
7. assumes the recordings-only AWS OIDC role;
8. deploys `transform`, then `pipeline` without rebuilding them;
9. verifies both CloudFormation stacks and the Step Functions state machine are describable.

The CI deployment artifacts use a one-day retention period because they are only needed for the immediate production deployment. The production concurrency group is serialized with `cancel-in-progress: false`, so an in-progress deployment is not cancelled part-way through by a later merge.

## 5. Manual plan and emergency deployment

The **Deploy Recordings** `workflow_dispatch` entry remains available on `master`.

For a non-executing CloudFormation plan, run:

```text
operation: plan
confirm_deploy: false
pipeline_enabled: true
confirm_disable_pipeline: false
confirm_stack_recreate: false
```

Plan mode passes `--no-execute-changeset` to SAM. CloudFormation creates change sets for inspection and does not update resources.

For an intentional manual production deployment, run:

```text
operation: deploy
confirm_deploy: true
pipeline_enabled: true
confirm_disable_pipeline: false
confirm_stack_recreate: false
```

Manual runs retain the full dependency install, tests, syntax checks and SAM validation/build sequence before production credentials are loaded. They do not depend on CI artifacts.

If `pipeline_enabled=false` is intentionally selected, `confirm_disable_pipeline=true` is also required. Stack recreation remains an emergency-only opt-in via `confirm_stack_recreate=true`.

## Rollback

Do not delete the existing recordings CloudFormation stacks to roll back application code. Revert the offending commit on `master`; after the revert passes CI, the automatic deployment path will deploy the reverted tested revision.

If the deployment mechanism itself is broken, use the manual workflow only after correcting the deployment path or deploy from a trusted local/admin environment using the same templates and stack names.
