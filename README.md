# recordings

AWS-native workflow for ingesting, processing, transcribing and delivering personal audio recordings.

This public repository was extracted as a **sanitised snapshot** from the private `antonio1000homens/lambdas` repository. Private monorepo Git history is intentionally not imported.

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
- Production deployment will use a dedicated recordings-only GitHub Actions OIDC role and a recordings-scoped secret-management credential before deployment ownership is moved here.

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
npm install
npm test
npm run check
```

AWS SAM is used to validate/build the application templates.

## Migration status

The repository is currently in the **source extraction / validation phase**. The existing production deployment remains owned by the private `lambdas` repository until the dedicated AWS OIDC role, recordings-scoped secrets and production change-set checks are complete.

The large `pipeline/package-lock.json` has not yet been copied because the connector used for the snapshot truncates that file and local npm regeneration was unavailable. CI therefore uses `npm install --no-package-lock` for the pipeline temporarily. The exact lockfile must be restored and CI switched back to `npm ci` **before production deployment ownership moves to this repository**.

The intended default branch is `master`.
