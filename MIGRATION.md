# Migration status

This repository was extracted from a private monorepo using a sanitised source snapshot. The private repository remains the production deployment owner until the cutover is explicitly completed.

## Completed

- [x] Pipeline source, tests, SAM template and deployment script copied to `pipeline/`.
- [x] Transform source, sanitised tests, SAM template and deployment script copied to `transform/`.
- [x] Private deployment defaults removed from deployment scripts.
- [x] Public-source guardrails and media/secret ignore rules added.
- [x] Credential-free PR CI added.
- [x] Production AWS stack/function/resource names preserved for a non-destructive ownership cutover.
- [x] GitHub default branch changed to `master`.
- [x] Pipeline dependency lock restored from the private source and CI returned to `npm ci`.
- [x] Dedicated recordings-only GitHub Actions OIDC role template prepared.
- [x] Manual-only production deployment workflow prepared.

## Required before the first public-repo production deployment

- [ ] CI for the deployment-readiness PR passes, including the public-source scan, locked installs, SAM builds and IAM template lint.
- [ ] Bootstrap `infrastructure/github-actions-deploy-role.yaml` into AWS from a trusted admin/local identity.
- [ ] Create a GitHub environment named `production`.
- [ ] Configure `AWS_ROLE_TO_ASSUME` and `CODE_BUCKET` as protected `production` environment secrets.
- [ ] Create a dedicated Bitwarden Secrets Manager project/machine account for recordings.
- [ ] Configure `BWS_GITHUB_ACTIONS_RECORDINGS_APP` as a protected `production` environment secret.
- [ ] Configure `BW_RECORDINGS_SHARED_SECRET` and `BW_GEMINI_API_KEY` as `production` environment variables containing the recordings-project Bitwarden secret IDs.
- [ ] Confirm the dedicated AWS role can only be assumed by `antonio1000homens/recordings` on `refs/heads/master`.

## Required before retiring the private deployment

- [ ] Manually dispatch the new deployment workflow against the existing production stacks.
- [ ] Confirm the deployment does not unexpectedly replace the recordings S3 bucket, functions, state machine or other stateful resources.
- [ ] Run one direct recording through the existing production endpoint.
- [ ] Run one chunked recording through the existing production endpoint.
- [ ] Verify final HTML/result generation and transform invocation.
- [ ] Verify workflow/log output does not expose secret values or temporary signed URLs.
- [ ] Only then remove recordings deployment/source from the private monorepo.

## Deployment safety rules

- Production deployment remains manual-only during the migration.
- Pull-request CI receives no AWS or Bitwarden credentials.
- The public repository must not receive the broad monorepo deployment role or broad secret-manager machine credential.
- Existing CloudFormation stack and application resource names stay stable through the repository cutover.
- Do not delete the existing stacks as part of repository migration; rollback is to resume deployment from the private repository.

## Follow-up application work

The signed artifact URL / external webhook callback enhancement should be tracked and implemented in this repository once the deployment ownership cutover is complete.
