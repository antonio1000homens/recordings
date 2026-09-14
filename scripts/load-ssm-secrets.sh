#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
AWS_REGION="${AWS_REGION:-eu-west-2}"
SSM_PREFIX="${SSM_PREFIX:-/recordings/prod}"

if [[ -z "${GITHUB_ENV:-}" ]]; then
  echo 'GITHUB_ENV is required; this script is intended for GitHub Actions.' >&2
  exit 1
fi

load_parameter() {
  local env_name="$1"
  local relative_name="$2"
  local parameter_name="${SSM_PREFIX%/}/${relative_name}"
  local value

  if ! value="$(aws ssm get-parameter \
      --name "${parameter_name}" \
      --with-decryption \
      --region "${AWS_REGION}" \
      --query 'Parameter.Value' \
      --output text)"; then
    echo "Unable to load required SSM parameter: ${parameter_name}" >&2
    exit 1
  fi

  echo "::add-mask::${value}"
  {
    echo "${env_name}<<__SSM_${env_name}__"
    printf '%s\n' "${value}"
    echo "__SSM_${env_name}__"
  } >> "${GITHUB_ENV}"
}

case "${mode}" in
  deploy)
    load_parameter RECORDINGS_TRANSFORM_SHARED_SECRET shared-secret
    load_parameter GEMINI_API_KEY gemini-api-key
    load_parameter RECORDINGS_DELIVERY_WEBHOOK delivery-webhook
    if [[ "${SLACK_NOTIFICATIONS_ENABLED:-true}" == "true" ]]; then
      load_parameter RECORDINGS_SLACK_WEBHOOK slack-webhook
    fi
    ;;

  ingress)
    load_parameter CLOUDFLARE_API_TOKEN cloudflare/api-token
    load_parameter RECORDINGS_WORKER_AWS_ACCESS_KEY_ID worker/aws-access-key-id
    load_parameter RECORDINGS_WORKER_AWS_SECRET_ACCESS_KEY worker/aws-secret-access-key
    load_parameter RECORDINGS_SHARED_SECRET shared-secret
    ;;

  *)
    echo 'Usage: scripts/load-ssm-secrets.sh <deploy|ingress>' >&2
    exit 2
    ;;
esac
