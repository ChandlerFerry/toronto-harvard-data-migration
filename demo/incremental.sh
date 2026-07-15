#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# Incremental migration — ONE provider per run. Each invocation migrates a single
# provider's slice from the OLD monolith into its dvc-<provider> bucket, deep-verifies
# it, deletes ONLY that provider's objects from OLD, then upgrades ONLY that provider's
# .dvc files in the git repo to v3 (the repo plane). The other providers' objects stay
# in OLD until their turn — so you can watch OLD drain provider-by-provider and prove
# the delete removes only what was migrated.
#   demo/incremental.sh                       # process the next un-migrated provider
#   INCREMENTAL_RESET=1 demo/incremental.sh   # wipe buckets/state + reseed, start over
set -euo pipefail
HERE="$(dirname "$0")"
source "$HERE/lib.sh"

PLAN_FILE="${INCREMENTAL_PLAN:-$REPO_ROOT/.demo/incremental-plan}"
DONE_FILE="${INCREMENTAL_DONE:-$REPO_ROOT/.demo/incremental-done}"

step "INCREMENTAL MIGRATION — one provider per run (migrate → verify → delete its slice)"

# Reset on request: clean buckets/reports/fixture AND forget incremental progress.
if [ "${INCREMENTAL_RESET:-0}" = "1" ]; then
  "$HERE/reset.sh"
  rm -f "$PLAN_FILE" "$DONE_FILE"
fi

# LocalStack up (idempotent).
"$HERE/01-up.sh"
mkdir -p "$(dirname "$PLAN_FILE")"

# --- Plan, built ONCE per cycle. A fresh start is "no plan file yet" OR "the fixture
#     is gone" (demo/reset.sh wipes buckets+fixture but a completed plan would
#     otherwise survive and make us report 'nothing left' against an empty OLD). On a
#     fresh start we drop stale progress, seed OLD if empty, rebuild the fixture, and
#     enumerate the providers in the FULL monolith. Mid-cycle runs reuse the frozen
#     plan, so "k of N" stays stable and a drained provider is never re-processed; OLD
#     is NOT silently reseeded once the cycle completes (INCREMENTAL_RESET=1 restarts). ---
if [ ! -s "$PLAN_FILE" ] || [ ! -d "$FIXTURE_DIR" ]; then
  rm -f "$PLAN_FILE" "$DONE_FILE"
  read -r old_objs _ < <(bucket_stats "$OLD_BUCKET")
  if [ "$old_objs" -eq 0 ]; then "$HERE/02-seed.sh"; fi

  if [ ! -d "$FIXTURE_DIR" ]; then
    note "building provider-map fixture from s3://$OLD_BUCKET"
    node --import tsx "$REPO_ROOT/demo/make-git-fixture.ts" \
      --old "$OLD_BUCKET" --out "$FIXTURE_DIR" --region "$AWS_REGION"
  fi

  note "planning providers by NAME (present in the monolith; public last)…"
  cli map --git-repo "$FIXTURE_DIR" --old "$OLD_BUCKET" --region "$AWS_REGION" >/dev/null 2>&1
  node --import tsx "$REPO_ROOT/demo/plan-providers.ts" "$REPORT_DIR" "$AWS_REGION" >"$PLAN_FILE"
  : >"$DONE_FILE" # fresh plan → empty progress
fi
touch "$DONE_FILE"

mapfile -t PLAN <"$PLAN_FILE"
total=${#PLAN[@]}
if [ "$total" -eq 0 ]; then
  err "no providers found in s3://$OLD_BUCKET — seed it first (demo/02-seed.sh)"
  exit 1
fi

# --- Pick the next provider not yet done. ---
NEXT=""
for p in "${PLAN[@]}"; do
  if ! grep -qxF "$p" "$DONE_FILE"; then
    NEXT="$p"
    break
  fi
done

done_count=$(grep -cve '^$' "$DONE_FILE" || true)

if [ -z "$NEXT" ]; then
  ok "all $total providers migrated — OLD is fully drained. Nothing left to do."
  snapshot "FINAL (OLD drained; every provider in its own bucket)"
  note "start over with: INCREMENTAL_RESET=1 demo/incremental.sh"
  exit 0
fi

step "PROVIDER '$NEXT'  ($((done_count + 1)) of $total)"
snapshot "BEFORE — about to migrate provider '$NEXT'"

note "migrate ONLY provider '$NEXT' (server-side copy of its slice; bytes stay in S3)…"
if out="$(cli migrate --old "$OLD_BUCKET" --git-repo "$FIXTURE_DIR" --region "$AWS_REGION" --provider "$NEXT" 2>&1)"; then
  ok "migrated provider '$NEXT'"
else
  err "$out"
  print_report migrate
  exit 1
fi
print_report migrate

note "verify provider '$NEXT' (deep, scoped to its bucket) — the gate before delete…"
if out="$(cli verify --old "$OLD_BUCKET" --git-repo "$FIXTURE_DIR" --region "$AWS_REGION" --provider "$NEXT" 2>&1)"; then
  ok "GATE PASS for '$NEXT'"
else
  err "$out"
  print_report verify
  printf '%s✗ GATE FAIL — not deleting%s\n' "$C_RED" "$C_RESET"
  exit 1
fi
print_report verify

# Repo plane (BEFORE delete): upgrade ONLY this provider's .dvc files to v3 (md5
# preserved) so the repo points at v3 before the OLD data is drained.
note "upgrade ONLY provider '$NEXT' .dvc files (v2 -> v3 in the git repo)…"
if out="$(cli upgrade --git-repo "$FIXTURE_DIR" --provider "$NEXT" 2>&1)"; then
  ok "upgraded provider '$NEXT' .dvc files to v3"
else
  err "$out"
  print_report upgrade
  exit 1
fi
print_report upgrade

note "delete ONLY provider '$NEXT' objects from s3://$OLD_BUCKET (compares OLD vs the dvc-$NEXT bucket; NO git)…"
if out="$(cli delete --old "$OLD_BUCKET" --region "$AWS_REGION" --provider "$NEXT" --no-dry-run 2>&1)"; then
  ok "drained provider '$NEXT' from OLD — only its migrated objects were removed"
else
  err "$out"
  print_report delete
  exit 1
fi
print_report delete

echo "$NEXT" >>"$DONE_FILE"

snapshot "AFTER — '$NEXT' drained from OLD; the other providers' data is still in OLD"

remaining=$((total - done_count - 1))
step "DONE — provider '$NEXT' migrated, verified, and removed from OLD"
if [ "$remaining" -gt 0 ]; then
  note "$remaining provider(s) left. Run demo/incremental.sh again for the next one."
else
  ok "that was the last provider — OLD is now fully drained."
fi
