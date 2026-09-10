# Migration status

This repository is being extracted from the private `antonio1000homens/lambdas` monorepo using a sanitised source snapshot. The private repository remains the production deployment owner until the cutover is explicitly completed.

## Completed in the initial extraction

- Pipeline source, tests, SAM template and deployment script copied to `pipeline/`.
- Transform source, sanitised tests, SAM template and deployment script copied to `transform/`.
- Private deployment defaults removed from deployment scripts.
- Public-source guardrails and media/secret ignore rules added.
- PR CI added without AWS, OIDC or Bitwarden permissions.
- Production AWS stack/function/resource names preserved to support a non-destructive ownership cutover later.

## Required before production cutover

- [ ] Change the GitHub repository default branch from `main` to `master` in repository settings.
- [ ] Restore the exact `pipeline/package-lock.json` from the private source snapshot and change pipeline CI from `npm install` back to `npm ci`.
- [ ] Run an exact-tree secret scan before treating the initial migration as complete.
- [ ] Create a dedicated GitHub Actions AWS role restricted to `antonio1000homens/recordings` and the trusted deployment branch/environment.
- [ ] Create a dedicated recordings-scoped Bitwarden machine credential; do not reuse the broad monorepo credential.
- [ ] Add a trusted deployment workflow that runs only after unprivileged validation and never exposes secrets to pull-request code.
- [ ] Inspect CloudFormation/SAM changes against the existing production stacks and confirm no unexpected replacement of stateful resources.
- [ ] Perform direct and chunked recording smoke tests from the new deployment owner.
- [ ] Only then remove recordings deployment/source from the private `lambdas` repository.

## Out of scope for the initial extraction PR

- Changing or deleting production AWS resources.
- Removing recordings code/workflows from `lambdas`.
- Reusing the existing broad monorepo AWS deployment role.
- Reusing the existing broad monorepo Bitwarden machine credential.
- Implementing the signed URL / external webhook callback enhancement; that feature should move to this repository once the extraction baseline is accepted.
