#!/usr/bin/env bash
set -euo pipefail

fail=0

check_pattern() {
  local description="$1"
  local pattern="$2"
  if git grep -nE -- "$pattern" -- ':!scripts/check-public-source.sh' >/tmp/public-source-scan 2>/dev/null; then
    echo "Public-source check failed: ${description}" >&2
    cat /tmp/public-source-scan >&2
    fail=1
  fi
}

# Private-monorepo deployment details must not leak into the public project.
check_pattern 'private Lambda deployment bucket reference' 'aws2022-lambda-code'
check_pattern 'broad monorepo AWS deployment role reference' 'GitHubActionsLambdasDeployRole'
check_pattern 'broad monorepo Bitwarden credential reference' 'BWS_GITHUB_ACTIONS_LAMBDAS_APP'
check_pattern 'private AWS account identifier' '243857182133'
check_pattern 'private infrastructure hostname' 'alf-broadcast\.co\.uk'
check_pattern 'private infrastructure email/domain' 'alf1000\.uk'

# Common credential forms. These are intentionally conservative checks, not a
# replacement for GitHub secret scanning or a dedicated secret scanner.
check_pattern 'AWS access key-shaped value' 'AKIA[0-9A-Z]{16}'
check_pattern 'Google API key-shaped value' 'AIza[0-9A-Za-z_-]{35}'
check_pattern 'private key material' '-----BEGIN (RSA |EC |OPENSSH |)?PRIVATE KEY-----'

# Real recordings/transcripts should not be tracked even if an ignore rule is bypassed.
tracked_media="$(git ls-files | grep -Ei '\.(m4a|mp3|wav|aac|flac|ogg|opus|mp4)$' || true)"
if [[ -n "${tracked_media}" ]]; then
  echo 'Public-source check failed: tracked media/recording files found:' >&2
  printf '%s\n' "${tracked_media}" >&2
  fail=1
fi

if [[ "${fail}" -ne 0 ]]; then
  exit 1
fi

echo 'Public-source checks passed.'
