#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-eu-west-2}"
STACK_NAME="${STACK_NAME:-recordings-github-actions-ssm-secrets-access}"
DEPLOYMENT_ROLE_NAME="${DEPLOYMENT_ROLE_NAME:-GitHubActionsRecordingsDeployRole}"
PARAMETER_PREFIX="${PARAMETER_PREFIX:-recordings/prod}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

aws cloudformation deploy \
  --template-file "${script_dir}/github-actions-ssm-secrets-access.yaml" \
  --stack-name "${STACK_NAME}" \
  --region "${AWS_REGION}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    "DeploymentRoleName=${DEPLOYMENT_ROLE_NAME}" \
    "ParameterPrefix=${PARAMETER_PREFIX}"

aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${AWS_REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ParameterPath'].OutputValue | [0]" \
  --output text
