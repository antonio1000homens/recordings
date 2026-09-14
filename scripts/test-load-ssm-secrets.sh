#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
loader="${repo_root}/scripts/load-ssm-secrets.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

mkdir -p "${tmp_dir}/bin"
cat > "${tmp_dir}/bin/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

parameter_name=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      parameter_name="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

test -n "${parameter_name}" || { echo 'fake aws: --name was not supplied' >&2; exit 1; }
printf 'value-for:%s\n' "${parameter_name}"
EOF
chmod +x "${tmp_dir}/bin/aws"

export PATH="${tmp_dir}/bin:${PATH}"
export AWS_REGION='eu-west-2'
export SSM_PREFIX='/recordings/test/'

assert_contains() {
  local needle="$1"
  grep -Fq -- "${needle}" "${GITHUB_ENV}" || {
    echo "Expected GITHUB_ENV to contain: ${needle}" >&2
    cat "${GITHUB_ENV}" >&2
    exit 1
  }
}

assert_not_contains() {
  local needle="$1"
  if grep -Fq -- "${needle}" "${GITHUB_ENV}"; then
    echo "Expected GITHUB_ENV not to contain: ${needle}" >&2
    cat "${GITHUB_ENV}" >&2
    exit 1
  fi
}

GITHUB_ENV="${tmp_dir}/deploy.env"
export GITHUB_ENV
: > "${GITHUB_ENV}"
SLACK_NOTIFICATIONS_ENABLED=false bash "${loader}" deploy >/dev/null
assert_contains 'RECORDINGS_TRANSFORM_SHARED_SECRET<<__SSM_RECORDINGS_TRANSFORM_SHARED_SECRET__'
assert_contains 'value-for:/recordings/test/shared-secret'
assert_contains 'GEMINI_API_KEY<<__SSM_GEMINI_API_KEY__'
assert_contains 'value-for:/recordings/test/gemini-api-key'
assert_contains 'RECORDINGS_DELIVERY_WEBHOOK<<__SSM_RECORDINGS_DELIVERY_WEBHOOK__'
assert_contains 'value-for:/recordings/test/delivery-webhook'
assert_not_contains 'RECORDINGS_SLACK_WEBHOOK<<__SSM_RECORDINGS_SLACK_WEBHOOK__'

: > "${GITHUB_ENV}"
SLACK_NOTIFICATIONS_ENABLED=true bash "${loader}" deploy >/dev/null
assert_contains 'RECORDINGS_SLACK_WEBHOOK<<__SSM_RECORDINGS_SLACK_WEBHOOK__'
assert_contains 'value-for:/recordings/test/slack-webhook'

GITHUB_ENV="${tmp_dir}/ingress.env"
export GITHUB_ENV
: > "${GITHUB_ENV}"
bash "${loader}" ingress >/dev/null
assert_contains 'CLOUDFLARE_API_TOKEN<<__SSM_CLOUDFLARE_API_TOKEN__'
assert_contains 'value-for:/recordings/test/cloudflare/api-token'
assert_contains 'RECORDINGS_WORKER_AWS_ACCESS_KEY_ID<<__SSM_RECORDINGS_WORKER_AWS_ACCESS_KEY_ID__'
assert_contains 'value-for:/recordings/test/worker/aws-access-key-id'
assert_contains 'RECORDINGS_WORKER_AWS_SECRET_ACCESS_KEY<<__SSM_RECORDINGS_WORKER_AWS_SECRET_ACCESS_KEY__'
assert_contains 'value-for:/recordings/test/worker/aws-secret-access-key'
assert_contains 'RECORDINGS_SHARED_SECRET<<__SSM_RECORDINGS_SHARED_SECRET__'
assert_contains 'value-for:/recordings/test/shared-secret'

unset GITHUB_ENV
if bash "${loader}" deploy >/dev/null 2>&1; then
  echo 'Expected loader to fail when GITHUB_ENV is missing.' >&2
  exit 1
fi

if GITHUB_ENV="${tmp_dir}/invalid.env" bash "${loader}" invalid >/dev/null 2>&1; then
  echo 'Expected loader to reject an unsupported mode.' >&2
  exit 1
fi

echo 'SSM secret loader tests passed.'
