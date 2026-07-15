#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# Stop LocalStack and remove its volume. Also clears the local report/fixture dirs.
source "$(dirname "$0")/lib.sh"
step "DOWN — stop LocalStack + remove volumes/artifacts"
docker compose -f "$REPO_ROOT/docker-compose.localstack.yml" down -v
rm -rf "$REPORT_DIR" "$FIXTURE_DIR"
ok "LocalStack stopped, volumes + demo artifacts removed"
