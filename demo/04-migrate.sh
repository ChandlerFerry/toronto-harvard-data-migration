#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# Migrate OLD -> per-provider buckets via server-side copy + the provider mapping,
# then deep-verify the union. Bytes move bucket-to-bucket inside S3.
source "$(dirname "$0")/lib.sh"

step "MIGRATE — monolith → per-provider buckets (server-side copy + deep verify)"

snapshot "BEFORE migrate"

note "copying s3://$OLD_BUCKET into per-provider buckets (bytes move bucket-to-bucket inside S3)…"
if out="$(cli migrate --old "$OLD_BUCKET" --git-repo "$FIXTURE_DIR" --region "$AWS_REGION" 2>&1)"; then
  ok "copied + deep-verified"
else
  err "$out"; print_report migrate; exit 1
fi
print_report migrate

snapshot "AFTER migrate"
