#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-eu-west-2}"
DEPLOYMENT_ROLE_NAME="${DEPLOYMENT_ROLE_NAME:-GitHubActionsRecordingsDeployRole}"
PARAMETER_PREFIX="${PARAMETER_PREFIX:-recordings}"
POLICY_NAME="${POLICY_NAME:-recordings-ssm-read}"

if [[ -z "${PARAMETER_PREFIX}" || "${PARAMETER_PREFIX}" == /* || "${PARAMETER_PREFIX}" == */ ]]; then
  echo 'PARAMETER_PREFIX must be a non-empty SSM hierarchy without leading/trailing slashes.' >&2
  exit 2
fi

account_id="$(aws sts get-caller-identity \
  --query Account \
  --output text \
  --region "${AWS_REGION}")"

role_arn="$(aws iam get-role \
  --role-name "${DEPLOYMENT_ROLE_NAME}" \
  --query 'Role.Arn' \
  --output text \
  --region "${AWS_REGION}")"

[[ -n "${account_id}" && "${account_id}" != "None" ]] || {
  echo 'Unable to resolve AWS account ID.' >&2
  exit 1
}
[[ -n "${role_arn}" && "${role_arn}" != "None" ]] || {
  echo "Unable to resolve IAM role ${DEPLOYMENT_ROLE_NAME}." >&2
  exit 1
}

policy_file="$(mktemp)"
trap 'rm -f "${policy_file}"' EXIT

cat > "${policy_file}" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadRecordingsParameters",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath"
      ],
      "Resource": "arn:aws:ssm:${AWS_REGION}:${account_id}:parameter/${PARAMETER_PREFIX}/*"
    }
  ]
}
EOF

# Use the low-level IAM API rather than `aws cloudformation deploy` here. This is
# idempotent and avoids AWS CLI deploy customisation/parsing differences in local
# development environments while preserving the same narrowly scoped permission.
aws iam put-role-policy \
  --role-name "${DEPLOYMENT_ROLE_NAME}" \
  --policy-name "${POLICY_NAME}" \
  --policy-document "file://${policy_file}" \
  --region "${AWS_REGION}"

printf '/%s\n' "${PARAMETER_PREFIX}"
