#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="${repo_root}/infrastructure/bootstrap-ssm-secrets-access.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

mkdir -p "${tmp_dir}/bin"
cat > "${tmp_dir}/bin/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${AWS_TEST_LOG}"

case "$1 $2" in
  'sts get-caller-identity')
    printf '123456789012\n'
    ;;
  'iam get-role')
    printf 'arn:aws:iam::123456789012:role/GitHubActionsRecordingsDeployRole\n'
    ;;
  'iam put-role-policy')
    policy_file=''
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == '--policy-document' ]]; then
        policy_file="$2"
        break
      fi
      shift
    done
    [[ "${policy_file}" == file://* ]] || { echo 'expected file:// policy document' >&2; exit 1; }
    jq -e '.Statement[0].Resource == "arn:aws:ssm:eu-west-2:123456789012:parameter/recordings/*"' "${policy_file#file://}" >/dev/null
    jq -e '.Statement[0].Action == ["ssm:GetParameter","ssm:GetParameters","ssm:GetParametersByPath"]' "${policy_file#file://}" >/dev/null
    ;;
  *)
    echo "unexpected aws invocation: $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${tmp_dir}/bin/aws"

export PATH="${tmp_dir}/bin:${PATH}"
export AWS_TEST_LOG="${tmp_dir}/aws.log"

output="$(AWS_REGION=eu-west-2 DEPLOYMENT_ROLE_NAME=GitHubActionsRecordingsDeployRole PARAMETER_PREFIX=recordings bash "${script}")"
[[ "${output}" == '/recordings' ]] || { echo "unexpected output: ${output}" >&2; exit 1; }

grep -Fq 'iam put-role-policy' "${AWS_TEST_LOG}"
if grep -Fq 'cloudformation deploy' "${AWS_TEST_LOG}"; then
  echo 'bootstrap must not call cloudformation deploy' >&2
  exit 1
fi

if PARAMETER_PREFIX='/recordings' bash "${script}" >/dev/null 2>&1; then
  echo 'expected leading slash prefix to be rejected' >&2
  exit 1
fi

echo 'SSM access bootstrap tests passed.'
