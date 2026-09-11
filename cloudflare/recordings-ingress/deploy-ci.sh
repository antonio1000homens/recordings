#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="${ROOT_DIR}/wrangler.toml"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: ${name}" >&2
    exit 1
  fi
}

put_secret() {
  local name="$1"
  local value="$2"
  printf '%s' "${value}" | npx wrangler secret put "${name}" --config "${CONFIG_PATH}"
}

require_env CLOUDFLARE_API_TOKEN
require_env RECORDINGS_SHARED_SECRET
require_env RECORDINGS_WORKER_AWS_ACCESS_KEY_ID
require_env RECORDINGS_WORKER_AWS_SECRET_ACCESS_KEY
require_env UPLOAD_ORIGIN_URL

# Keep runtime configuration out of source so the Function URL can be discovered
# from CloudFormation during deployment and rotated without editing wrangler.toml.
put_secret RECORDINGS_SHARED_SECRET "${RECORDINGS_SHARED_SECRET}"
put_secret AWS_ACCESS_KEY_ID "${RECORDINGS_WORKER_AWS_ACCESS_KEY_ID}"
put_secret AWS_SECRET_ACCESS_KEY "${RECORDINGS_WORKER_AWS_SECRET_ACCESS_KEY}"

npx wrangler deploy --config "${CONFIG_PATH}" --var "AWS_REGION:${AWS_REGION:-eu-west-2}" --var "UPLOAD_ORIGIN_URL:${UPLOAD_ORIGIN_URL}"
