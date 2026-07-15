#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# Demonstrate the DELETE gate: drain OLD only after re-proving every object in the
# per-provider union AND in its correctly-routed bucket.
#   default      : DRY-RUN only — shows the target count, deletes nothing.
#   DEMO_DELETE=1 : actually delete from OLD (OLD drains; provider buckets kept).
# OLD here is "old-demo" (not a production-named bucket), so no --allow-production
# is needed; a real prod run additionally requires that deliberate override.
source "$(dirname "$0")/lib.sh"

step "DELETE — drain OLD after re-verifying the union (dry-run by default)"

snapshot "BEFORE delete"

note "dry-run delete (compares OLD vs each provider bucket — new files vs old files, NO git)…"
if out="$(cli delete --old "$OLD_BUCKET" --region "$AWS_REGION" 2>&1)"; then
  ok "dry-run gate PASS — would delete the verified set"
else
  err "$out"; print_report delete; exit 1
fi
print_report delete

if [ "${DEMO_DELETE:-0}" = "1" ]; then
  step "DELETE (for real) — --no-dry-run"
  note "deleting verified objects from s3://$OLD_BUCKET …"
  if out="$(cli delete --old "$OLD_BUCKET" --region "$AWS_REGION" --no-dry-run 2>&1)"; then
    ok "OLD drained — every deleted object was first proven byte-identical in its provider bucket"
  else
    err "$out"; print_report delete; exit 1
  fi
  print_report delete
  snapshot "AFTER delete (OLD drained; provider buckets intact)"
else
  note "set DEMO_DELETE=1 to actually drain OLD (this demo left it intact)."
fi
