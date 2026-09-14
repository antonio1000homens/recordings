#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-antonio1000homens/recordings}"
GH_ENVIRONMENT="${GH_ENVIRONMENT:-production}"
AWS_REGION="${AWS_REGION:-eu-west-2}"
DEPLOYMENT_ROLE_NAME="${DEPLOYMENT_ROLE_NAME:-GitHubActionsRecordingsDeployRole}"
SSM_PREFIX="${SSM_PREFIX:-/recordings/prod}"
CODE_BUCKET="${CODE_BUCKET:-}"
ACTIVATE_SSM=false
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-ssm-migration.sh [options]

Bootstrap the recordings Bitwarden -> AWS SSM migration from an authenticated
local development environment.

Prerequisites:
  - aws CLI authenticated to the target AWS account
  - gh CLI authenticated with access to the recordings repository/environment
  - bws CLI authenticated to Bitwarden Secrets Manager
  - jq

Options:
  --repo OWNER/REPO          GitHub repository (default: antonio1000homens/recordings)
  --environment NAME         GitHub Actions environment (default: production)
  --region REGION            AWS region (default: eu-west-2)
  --role-name NAME           Existing GitHub OIDC deploy role name
  --ssm-prefix PATH          SSM path (default: /recordings/prod)
  --code-bucket NAME         SAM deployment bucket; required if CODE_BUCKET is not
                             already a GitHub environment variable
  --activate-ssm             Set GitHub environment variable SECRETS_BACKEND=ssm
                             after successful bootstrap. Without this flag the
                             backend is not changed.
  --dry-run                  Validate authentication, Bitwarden mapping and derived
                             configuration without changing AWS or GitHub.
  -h, --help                 Show this help.

Bitwarden mapping:
  The script auto-discovers secrets by their logical key names. If a key differs,
  export the existing Bitwarden secret UUID before running using the corresponding
  workflow variable name:

    BW_RECORDINGS_SHARED_SECRET
    BW_GEMINI_API_KEY
    BW_RECORDINGS_DELIVERY_WEBHOOK
    BW_RECORDINGS_SLACK_WEBHOOK
    BW_CF_DEPLOY_API_TOKEN
    BW_RECORDINGS_WORKER_AWS_ACCESS_KEY_ID
    BW_RECORDINGS_WORKER_AWS_SECRET_ACCESS_KEY

These variables are treated as Bitwarden secret IDs, never as secret values.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="${2:?--repo requires a value}"
      shift 2
      ;;
    --environment)
      GH_ENVIRONMENT="${2:?--environment requires a value}"
      shift 2
      ;;
    --region)
      AWS_REGION="${2:?--region requires a value}"
      shift 2
      ;;
    --role-name)
      DEPLOYMENT_ROLE_NAME="${2:?--role-name requires a value}"
      shift 2
      ;;
    --ssm-prefix)
      SSM_PREFIX="${2:?--ssm-prefix requires a value}"
      shift 2
      ;;
    --code-bucket)
      CODE_BUCKET="${2:?--code-bucket requires a value}"
      shift 2
      ;;
    --activate-ssm)
      ACTIVATE_SSM=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for command_name in aws gh bws jq; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "Required command not found: ${command_name}" >&2
    exit 1
  }
done

if [[ "${SSM_PREFIX}" != /* ]]; then
  echo 'SSM_PREFIX must start with /.' >&2
  exit 2
fi

printf 'Checking AWS authentication... '
AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --region "${AWS_REGION}")"
echo "account ${AWS_ACCOUNT_ID}"

printf 'Checking GitHub authentication... '
gh auth status >/dev/null
GH_REPO="$(gh repo view "${REPO}" --json nameWithOwner --jq .nameWithOwner)"
echo "${GH_REPO}"

printf 'Checking Bitwarden Secrets Manager authentication... '
# bws secret list includes secret values, so immediately reduce the response to
# identifiers and keys before keeping it in shell memory. Nothing is printed.
BITWARDEN_CATALOG="$(bws secret list --output json | jq -ce '[.[] | {id, key}]')"
echo 'ok'

if [[ -z "${CODE_BUCKET}" ]]; then
  CODE_BUCKET="$(gh variable get CODE_BUCKET --env "${GH_ENVIRONMENT}" --repo "${REPO}" 2>/dev/null || true)"
fi
if [[ -z "${CODE_BUCKET}" ]]; then
  echo 'CODE_BUCKET is not available as a GitHub environment variable yet.' >&2
  echo 'Pass --code-bucket NAME or export CODE_BUCKET before running the bootstrap.' >&2
  exit 1
fi

ROLE_ARN="$(aws iam get-role \
  --role-name "${DEPLOYMENT_ROLE_NAME}" \
  --query 'Role.Arn' \
  --output text \
  --region "${AWS_REGION}")"

resolve_secret_id() {
  local override_name="$1"
  shift
  local override_value="${!override_name:-}"
  local key
  local match
  local matches=()

  if [[ -n "${override_value}" ]]; then
    printf '%s' "${override_value}"
    return 0
  fi

  for key in "$@"; do
    while IFS= read -r match; do
      [[ -n "${match}" ]] && matches+=("${match}")
    done < <(jq -r --arg key "${key}" '.[] | select(.key == $key) | .id' <<<"${BITWARDEN_CATALOG}")
  done

  if [[ ${#matches[@]} -eq 1 ]]; then
    printf '%s' "${matches[0]}"
    return 0
  fi

  if [[ ${#matches[@]} -eq 0 ]]; then
    echo "Unable to find Bitwarden secret for ${override_name}." >&2
    echo "Export ${override_name}=<secret-uuid> to provide the existing Bitwarden ID explicitly." >&2
  else
    echo "Multiple Bitwarden secrets matched ${override_name}; refusing to guess." >&2
    echo "Export ${override_name}=<secret-uuid> to select the intended secret explicitly." >&2
  fi
  return 1
}

BW_SHARED_ID="$(resolve_secret_id BW_RECORDINGS_SHARED_SECRET RECORDINGS_SHARED_SECRET RECORDINGS_TRANSFORM_SHARED_SECRET)"
BW_GEMINI_ID="$(resolve_secret_id BW_GEMINI_API_KEY GEMINI_API_KEY)"
BW_DELIVERY_ID="$(resolve_secret_id BW_RECORDINGS_DELIVERY_WEBHOOK RECORDINGS_DELIVERY_WEBHOOK)"
BW_SLACK_ID="$(resolve_secret_id BW_RECORDINGS_SLACK_WEBHOOK RECORDINGS_SLACK_WEBHOOK)"
BW_CF_ID="$(resolve_secret_id BW_CF_DEPLOY_API_TOKEN CLOUDFLARE_API_TOKEN CF_DEPLOY_API_TOKEN)"
BW_WORKER_ACCESS_ID="$(resolve_secret_id BW_RECORDINGS_WORKER_AWS_ACCESS_KEY_ID RECORDINGS_WORKER_AWS_ACCESS_KEY_ID)"
BW_WORKER_SECRET_ID="$(resolve_secret_id BW_RECORDINGS_WORKER_AWS_SECRET_ACCESS_KEY RECORDINGS_WORKER_AWS_SECRET_ACCESS_KEY)"

echo 'Resolved all Bitwarden secret IDs without printing secret values.'
echo "AWS region: ${AWS_REGION}"
echo "SSM prefix: ${SSM_PREFIX}"
echo "GitHub OIDC role: ${ROLE_ARN}"
echo "Code bucket: ${CODE_BUCKET}"
echo "GitHub environment: ${REPO}:${GH_ENVIRONMENT}"

if [[ "${DRY_RUN}" == "true" ]]; then
  echo 'Dry run complete; no AWS or GitHub changes were made.'
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

echo 'Deploying scoped GitHub Actions SSM read policy...'
AWS_REGION="${AWS_REGION}" \
DEPLOYMENT_ROLE_NAME="${DEPLOYMENT_ROLE_NAME}" \
PARAMETER_PREFIX="${SSM_PREFIX#/}" \
  bash "${repo_root}/infrastructure/bootstrap-ssm-secrets-access.sh" >/dev/null

put_secret_parameter() {
  local relative_name="$1"
  local secret_id="$2"
  local parameter_name="${SSM_PREFIX%/}/${relative_name}"
  local value

  value="$(bws secret get "${secret_id}" --output json | jq -er '.value')"
  if [[ -z "${value}" ]]; then
    echo "Bitwarden secret ${secret_id} returned an empty value; refusing to write ${parameter_name}." >&2
    exit 1
  fi

  # Feed the API request over stdin so the secret value is not placed in the aws
  # process command line. Never enable shell tracing around this function.
  jq -n \
    --arg name "${parameter_name}" \
    --arg value "${value}" \
    '{Name:$name, Type:"SecureString", Value:$value, Overwrite:true}' \
    | aws ssm put-parameter \
        --region "${AWS_REGION}" \
        --cli-input-json file:///dev/stdin \
        >/dev/null

  unset value
  echo "Stored ${parameter_name}"
}

put_secret_parameter shared-secret "${BW_SHARED_ID}"
put_secret_parameter gemini-api-key "${BW_GEMINI_ID}"
put_secret_parameter delivery-webhook "${BW_DELIVERY_ID}"
put_secret_parameter slack-webhook "${BW_SLACK_ID}"
put_secret_parameter cloudflare/api-token "${BW_CF_ID}"
put_secret_parameter worker/aws-access-key-id "${BW_WORKER_ACCESS_ID}"
put_secret_parameter worker/aws-secret-access-key "${BW_WORKER_SECRET_ID}"

echo 'Validating SSM parameter names...'
for relative_name in \
  shared-secret \
  gemini-api-key \
  delivery-webhook \
  slack-webhook \
  cloudflare/api-token \
  worker/aws-access-key-id \
  worker/aws-secret-access-key; do
  parameter_name="${SSM_PREFIX%/}/${relative_name}"
  found="$(aws ssm get-parameter \
    --name "${parameter_name}" \
    --region "${AWS_REGION}" \
    --query 'Parameter.Name' \
    --output text)"
  [[ "${found}" == "${parameter_name}" ]] || {
    echo "Unable to validate ${parameter_name}." >&2
    exit 1
  }
done

set_gh_variable() {
  local name="$1"
  local value="$2"
  gh variable set "${name}" \
    --env "${GH_ENVIRONMENT}" \
    --repo "${REPO}" \
    --body "${value}"
}

echo 'Writing non-secret GitHub Actions environment variables...'
set_gh_variable AWS_REGION "${AWS_REGION}"
set_gh_variable AWS_ROLE_TO_ASSUME "${ROLE_ARN}"
set_gh_variable CODE_BUCKET "${CODE_BUCKET}"
set_gh_variable SSM_PREFIX "${SSM_PREFIX}"

if [[ "${ACTIVATE_SSM}" == "true" ]]; then
  set_gh_variable SECRETS_BACKEND ssm
  echo 'SECRETS_BACKEND=ssm is now active for the production environment.'
else
  echo 'SECRETS_BACKEND was not changed. The workflows remain on their current backend.'
  echo 'After validating the migration, rerun with --activate-ssm or set the variable with gh.'
fi

echo 'Bootstrap complete. No secret values were written to GitHub.'
