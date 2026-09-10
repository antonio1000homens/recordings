# Deployment bootstrap

The production recordings stacks are intentionally not deployed automatically from this public repository yet.

The first cutover uses a dedicated GitHub Actions OIDC role and a dedicated Bitwarden Secrets Manager machine account/project. The existing private monorepo remains the deployment owner until the new path has been proven.

## 1. Bootstrap the AWS OIDC deployment role

The AWS account already needs the GitHub Actions OIDC provider for `token.actions.githubusercontent.com`.

Run the bootstrap from a trusted local/admin AWS identity, supplying the **existing private SAM deployment bucket** used by the current recordings deployment:

```bash
AWS_REGION=eu-west-2 \
CODE_BUCKET='<existing-sam-code-bucket>' \
bash infrastructure/bootstrap-deployment-role.sh
```

The script creates/updates the stack `recordings-github-actions-deploy-role` and prints the dedicated deployment-role ARN.

The trust policy accepts GitHub OIDC only when the subject is exactly:

```text
repo:antonio1000homens/recordings:ref:refs/heads/master
```

The role policy is restricted to the existing recordings stacks, Lambda functions, runtime roles, log groups, recordings bucket, Step Functions state machine, EventBridge rule and the two recordings prefixes in the SAM code bucket.

## 2. Create the GitHub `production` environment

In repository settings create an environment named `production`.

Add these **environment secrets**:

- `AWS_ROLE_TO_ASSUME` — output ARN from the bootstrap stack.
- `CODE_BUCKET` — existing private SAM deployment bucket name.
- `BWS_GITHUB_ACTIONS_RECORDINGS_APP` — access token for a Bitwarden Secrets Manager machine account scoped only to the recordings project.

Add these **environment variables**:

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

## 4. First deployment

`.github/workflows/deploy.yml` is deliberately `workflow_dispatch` only.

Before the first production run:

1. confirm CI on `master` is green;
2. inspect the OIDC role and its trust policy;
3. configure the `production` environment above;
4. leave the private monorepo deployment in place;
5. manually run **Deploy Recordings** with `confirm_deploy=true`;
6. keep `pipeline_enabled=true` if preserving the currently enabled production ingestion path;
7. inspect the CloudFormation changes and resulting stack states;
8. run one direct recording and one chunked recording through the existing endpoint.

Only after those checks pass should the private monorepo workflows/source be removed.

## Rollback

Do not delete the existing recordings CloudFormation stacks during repository migration.

If the new deployment path fails, stop using the public-repo deployment workflow and continue deploying from the private monorepo while the problem is corrected. Because stack names and resource names are preserved, repository migration should not itself require an AWS data migration.
