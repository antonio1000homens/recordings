#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="${repo_root}/scripts/bootstrap-ssm-migration.sh"

if grep -Fq 'file:///dev/stdin' "${script}"; then
  echo 'bootstrap must not use file:///dev/stdin for AWS CLI JSON input' >&2
  exit 1
fi

grep -Fq 'secret_request_dir="$(mktemp -d)"' "${script}"
grep -Fq 'chmod 700 "${secret_request_dir}"' "${script}"
grep -Fq 'chmod 600 "${request_file}"' "${script}"
grep -Fq -- '--cli-input-json "file://${request_file}"' "${script}"

if grep -Fq -- '--value "${value}"' "${script}"; then
  echo 'bootstrap must not place secret values directly on the AWS CLI command line' >&2
  exit 1
fi

echo 'SSM migration bootstrap portability checks passed.'
