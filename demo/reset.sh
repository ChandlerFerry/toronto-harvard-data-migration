#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# Wipe all demo buckets + reports + the git fixture, so the demo can be re-run
# clean. Leaves LocalStack running (use demo/down.sh to stop it).
source "$(dirname "$0")/lib.sh"

step "RESET — clean slate (buckets + reports + fixture)"
for b in "$OLD_BUCKET" $(provider_buckets); do
  note "removing s3://$b"
  awsls s3 rb "s3://$b" --force >/dev/null 2>&1 || true
done
rm -rf "$REPORT_DIR" "$FIXTURE_DIR"
# Incremental progress files (defaults mirror demo/incremental.sh); `:-` keeps this
# safe under `set -u` when the override env vars are unset.
rm -f "${INCREMENTAL_PLAN:-$REPO_ROOT/.demo/incremental-plan}" \
      "${INCREMENTAL_DONE:-$REPO_ROOT/.demo/incremental-done}"
ok "reset complete (buckets, reports, fixture, incremental progress cleared)"
