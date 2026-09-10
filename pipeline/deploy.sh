#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-eu-west-2}"
STACK_NAME="${STACK_NAME:-recordings-pipeline}"
S3_PREFIX="${S3_PREFIX:-recordings/pipeline}"
PIPELINE_ENABLED="${PIPELINE_ENABLED:-true}"
SKIP_SAM_BUILD="${SKIP_SAM_BUILD:-false}"
PLAN_ONLY="${PLAN_ONLY:-false}"

: "${CODE_BUCKET:?CODE_BUCKET is required}"
: "${RECORDINGS_TRANSFORM_SHARED_SECRET:?RECORDINGS_TRANSFORM_SHARED_SECRET is required}"
: "${GEMINI_API_KEY:?GEMINI_API_KEY is required}"

if [[ "${PLAN_ONLY}" != "true" && "${PLAN_ONLY}" != "false" ]]; then
  echo "PLAN_ONLY must be 'true' or 'false'." >&2
  exit 2
fi

show_delete_failures() {
  echo "CloudFormation resources that most recently failed deletion:" >&2
  aws cloudformation describe-stack-events \
    --stack-name "${STACK_NAME}" \
    --region "${AWS_REGION}" \
    --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId,ResourceType,ResourceStatusReason]" \
    --output table >&2 || true
}

stack_status="$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${AWS_REGION}" \
  --query 'Stacks[0].StackStatus' \
  --output text 2>/dev/null || true)"

case "${stack_status}" in
  ROLLBACK_FAILED|ROLLBACK_COMPLETE|CREATE_FAILED|DELETE_FAILED|UPDATE_ROLLBACK_FAILED)
    if [[ "${PLAN_ONLY}" == "true" ]]; then
      echo "Cannot create a safe plan while ${STACK_NAME} is in ${stack_status}; no stack changes were made." >&2
      exit 1
    fi

    echo "Removing unrecoverable stack ${STACK_NAME} (${stack_status}) before redeploying."
    aws cloudformation delete-stack \
      --stack-name "${STACK_NAME}" \
      --region "${AWS_REGION}"
    if ! aws cloudformation wait stack-delete-complete \
      --stack-name "${STACK_NAME}" \
      --region "${AWS_REGION}"; then
      show_delete_failures
      exit 1
    fi
    ;;
esac

if [[ "${SKIP_SAM_BUILD}" == "true" ]]; then
  if [[ ! -f .aws-sam/build/template.yaml ]]; then
    echo "SKIP_SAM_BUILD=true but .aws-sam/build/template.yaml does not exist." >&2
    exit 1
  fi
  echo "Reusing SAM build produced earlier in this job."
else
  sam build --template-file template.yaml
fi

deploy_args=(
  --template-file .aws-sam/build/template.yaml
  --stack-name "${STACK_NAME}"
  --region "${AWS_REGION}"
  --s3-bucket "${CODE_BUCKET}"
  --s3-prefix "${S3_PREFIX}"
  --capabilities CAPABILITY_NAMED_IAM
  --no-confirm-changeset
  --no-fail-on-empty-changeset
)

if [[ "${PLAN_ONLY}" == "true" ]]; then
  echo "Creating CloudFormation change set only; it will not be executed."
  deploy_args+=(--no-execute-changeset)
fi

sam deploy "${deploy_args[@]}" \
  --parameter-overrides \
    "SharedSecret=${RECORDINGS_TRANSFORM_SHARED_SECRET}" \
    "GeminiApiKey=${GEMINI_API_KEY}" \
    "PipelineEnabled=${PIPELINE_ENABLED}"

if [[ "${PLAN_ONLY}" == "true" ]]; then
  echo "Plan complete for ${STACK_NAME}; CloudFormation resources were not updated."
  exit 0
fi

aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${AWS_REGION}" \
  --query 'Stacks[0].Outputs' \
  --output table
