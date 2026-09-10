# recordings

AWS-native workflow for ingesting, processing, transcribing and delivering personal audio recordings.

This public repository was extracted as a **sanitised snapshot** from a private monorepo. Private monorepo Git history is intentionally not imported.

## Components

- [`pipeline/`](pipeline/) — upload API, private S3 storage, FFmpeg probing/chunking, Gemini transcription/orchestration, EventBridge and Step Functions.
- [`transform/`](transform/) — deterministic transcript formatting, chunk stitching request construction, speaker-label enrichment and final HTML generation.

The pipeline directly invokes the transform Lambda, so both components are maintained together.

## Privacy and security

The source repository is public; recording data is not.

- Do not commit recordings, transcripts, generated result files, signed URLs, API keys or deployment credentials.
- Runtime recordings remain in an S3 bucket with public access blocked.
- HTTP endpoints use an application-level recordings secret where appropriate.
- CI for pull requests is unprivileged and receives no AWS or Bitwarden credentials.
- Production deployment uses a dedicated recordings-only GitHub Actions OIDC role and a recordings-scoped Bitwarden Secrets Manager machine account/project.

Run the repository source-boundary check locally with:

```bash
bash scripts/check-public-source.sh
```

## Development

Both packages require Node.js 22 or later.

```bash
cd transform
npm ci
npm test
npm run check

cd ../pipeline
npm ci
npm test
npm run check
```

AWS SAM is used to validate/build the application templates.

## Deployment

Production deployment remains intentionally **manual-only** during repository migration.

The deployment-readiness infrastructure and GitHub environment setup are documented in [`infrastructure/README.md`](infrastructure/README.md). The workflow builds/tests both packages before any AWS or Bitwarden credential is loaded and deploys `transform` before `pipeline`.

Existing production stack and resource names are preserved so repository migration changes the deployment owner rather than recreating the recordings application.

## Migration status

The repository has completed source extraction and is preparing for deployment ownership cutover. See [`MIGRATION.md`](MIGRATION.md) for the remaining bootstrap, smoke-test and private-repository retirement steps.

The default branch is `master`.
