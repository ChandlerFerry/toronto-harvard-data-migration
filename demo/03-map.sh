#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# Build the provider mapping and PROVE it validates.
#   1. synthesize a git repo of .dvc files referencing the real seeded md5s
#   2. run the real `dvc-map` (git history JOIN object store) -> per-provider counts
source "$(dirname "$0")/lib.sh"

step "MAP — build provider mapping from git history, validate against the store"

note "synthesizing git provider-map fixture from s3://$OLD_BUCKET"
node --import tsx "$REPO_ROOT/demo/make-git-fixture.ts" \
  --old "$OLD_BUCKET" --out "$FIXTURE_DIR" --region "$AWS_REGION"

# Run the real dvc-map; hide the raw log line, surface it only if it fails.
if out="$(cli map --git-repo "$FIXTURE_DIR" --old "$OLD_BUCKET" --region "$AWS_REGION" 2>&1)"; then
  ok "mapping valid — no orphans, no provider conflicts"
else
  err "$out"; print_report map; exit 1
fi
print_report map
