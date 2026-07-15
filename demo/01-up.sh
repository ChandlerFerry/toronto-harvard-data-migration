#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# Start LocalStack (S3 mock on :4566) and wait until it is ready.
source "$(dirname "$0")/lib.sh"

step "UP — start LocalStack (S3 mock on :4566)"
docker compose -f "$REPO_ROOT/docker-compose.localstack.yml" up -d

printf '%swaiting for LocalStack S3%s' "$C_DIM" "$C_RESET"
for _ in $(seq 1 60); do
  if curl -fsS "$AWS_ENDPOINT_URL/_localstack/health" 2>/dev/null \
       | grep -Eq '"s3": "(available|running)"'; then
    printf '\n'; ok "LocalStack S3 ready"
    exit 0
  fi
  printf '%s.%s' "$C_DIM" "$C_RESET"; sleep 1
done
printf '\n'; err "LocalStack did not become ready in time"
exit 1
