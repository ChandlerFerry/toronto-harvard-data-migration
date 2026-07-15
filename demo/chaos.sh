#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# CHAOS demo: deliberately break the migration four ways and prove each safety gate
# REFUSES (never deletes / never silently misroutes), then recover and prove the
# gate passes again. Self-contained: brings up a clean migrated baseline first.
#
#   demo/chaos.sh              # fast (a few md5 shards)
#   SEED_FULL=1 demo/chaos.sh  # all sandbox objects
#
# The four injections (war-room plan §Phase E, ranked by bug-exposure value):
#   1. unknown provider folder  -> routing gate aborts (would leak to public)
#   2. corrupt NEW copy (same size) -> deep-ETag verify refuses to delete
#   3. missing NEW object       -> git-free delete leaves it safe in OLD (not a delete target)
#   4. misrouted object (in public, not its provider bucket) -> destination assertion refuses
set -euo pipefail
HERE="$(dirname "$0")"
source "$HERE/lib.sh"

GOOD_FIXTURE="$FIXTURE_DIR"
BAD_FIXTURE="${FIXTURE_DIR}-bad"

# Run a migration CLI expecting it to REFUSE (non-zero exit). Fail the demo loudly
# if the gate let the broken state through — that would be the real bug.
expect_refuse() {
  local label="$1"; shift
  if out="$(cli "$@" 2>&1)"; then
    err "✗ CHAOS REGRESSION: '$label' did NOT refuse — the gate let a broken state through!"
    printf '%s\n' "$out"
    exit 1
  fi
  ok "gate REFUSED as designed: $label"
}

# Run a migration CLI expecting success (recovery).
expect_ok() {
  local label="$1"; shift
  if out="$(cli "$@" 2>&1)"; then
    ok "recovered: $label"
  else
    err "✗ recovery failed: $label"; printf '%s\n' "$out"; exit 1
  fi
}

# Re-copy OLD -> provider buckets (idempotent, content-aware) to repair a fault.
remigrate() { cli migrate --old "$OLD_BUCKET" --git-repo "$GOOD_FIXTURE" --region "$AWS_REGION" >/dev/null; }
reverify()  { cli verify  --old "$OLD_BUCKET" --git-repo "$GOOD_FIXTURE" --region "$AWS_REGION" >/dev/null; }

# Pick one real object in a NON-public provider bucket (so moving it to public is a
# genuine misroute). Sets SAMPLE_BUCKET / SAMPLE_KEY.
pick_provider_sample() {
  local pub b k
  pub="$(provider_bucket public)"
  for b in $(provider_buckets); do
    [ "$b" = "$pub" ] && continue
    # NB: no --max-items (it appends a pagination-token line to --output text);
    # --query Contents[0].Key already returns just the first key.
    k="$(awsls s3api list-objects-v2 --bucket "$b" \
          --query 'Contents[0].Key' --output text 2>/dev/null | head -n1 || true)"
    if [ -n "$k" ] && [ "$k" != "None" ]; then SAMPLE_BUCKET="$b"; SAMPLE_KEY="$k"; return 0; fi
  done
  err "no objects in any non-public provider bucket (seed more shards?)"; return 1
}

# ---- Clean baseline -------------------------------------------------------------
step "CHAOS — bring up a clean, verified baseline first"
"$HERE/01-up.sh"
"$HERE/reset.sh"
rm -rf "$BAD_FIXTURE"
"$HERE/02-seed.sh"
"$HERE/03-map.sh"
"$HERE/04-migrate.sh"
"$HERE/05-verify.sh"

# ---- 1. Unknown provider folder -------------------------------------------------
step "CHAOS 1/4 — an unknown provider folder must NOT silently leak to public"
note "synthesizing a fixture with a bogus 'Mystery Source' folder (absent from the provider map)…"
node --import tsx "$HERE/make-git-fixture.ts" \
  --old "$OLD_BUCKET" --out "$BAD_FIXTURE" --region "$AWS_REGION" \
  --providers "Affinity,Mystery Source"
expect_refuse "migrate on unknown folder" \
  migrate --old "$OLD_BUCKET" --git-repo "$BAD_FIXTURE" --region "$AWS_REGION"
print_report migrate
note "recovery: re-run with the CORRECT provider folders (the real fix)…"
expect_ok "migrate with the corrected fixture" \
  migrate --old "$OLD_BUCKET" --git-repo "$GOOD_FIXTURE" --region "$AWS_REGION"
reverify; ok "baseline re-verified"

# ---- 2. Same-size corruption ----------------------------------------------------
step "CHAOS 2/4 — a same-size corrupt NEW copy must block the delete (deep ETag)"
pick_provider_sample
sz="$(awsls s3api head-object --bucket "$SAMPLE_BUCKET" --key "$SAMPLE_KEY" \
       --query ContentLength --output text)"
note "overwriting s3://$SAMPLE_BUCKET/$SAMPLE_KEY with $sz bytes of garbage (same size)…"
head -c "$sz" /dev/zero | tr '\0' 'X' > /tmp/chaos-corrupt.bin
awsls s3 cp /tmp/chaos-corrupt.bin "s3://$SAMPLE_BUCKET/$SAMPLE_KEY" --only-show-errors
expect_refuse "verify with a corrupt copy" \
  verify --old "$OLD_BUCKET" --git-repo "$GOOD_FIXTURE" --region "$AWS_REGION"
print_report verify
note "recovery: re-migrate re-copies the corrupt object (content-aware skip detects it)…"
remigrate; reverify; ok "corruption repaired, gate passes"

# ---- 3. Missing NEW object ------------------------------------------------------
step "CHAOS 3/4 — an object missing from NEW is NOT drained from OLD (left safe; per-object, no abort)"
pick_provider_sample
note "deleting s3://$SAMPLE_BUCKET/$SAMPLE_KEY from NEW (simulating a not-yet-migrated object)…"
awsls s3 rm "s3://$SAMPLE_BUCKET/$SAMPLE_KEY" --only-show-errors
# The git-free delete keys off each provider bucket's contents: an object absent there is
# simply not a delete target (it stays safe in OLD) rather than aborting the whole run.
expect_ok "dry-run delete tolerates the missing object (no abort; it is just not targeted)" \
  delete --old "$OLD_BUCKET" --region "$AWS_REGION"
print_report delete
note "recovery: re-migrate restores it…"
remigrate; reverify; ok "missing object restored, gate passes"

# ---- 4. Misroute (right object, wrong bucket) -----------------------------------
step "CHAOS 4/4 — an object in the WRONG provider bucket must be caught (not just 'present somewhere')"
pick_provider_sample
PUB="$(provider_bucket public)"
note "moving s3://$SAMPLE_BUCKET/$SAMPLE_KEY into the PUBLIC bucket (a private→public misroute)…"
awsls s3 cp "s3://$SAMPLE_BUCKET/$SAMPLE_KEY" "s3://$PUB/$SAMPLE_KEY" --only-show-errors
awsls s3 rm "s3://$SAMPLE_BUCKET/$SAMPLE_KEY" --only-show-errors
expect_refuse "verify with a misrouted object (present in public, not its provider bucket)" \
  verify --old "$OLD_BUCKET" --git-repo "$GOOD_FIXTURE" --region "$AWS_REGION"
print_report verify
note "recovery: re-migrate copies it back to the CORRECT bucket…"
remigrate; reverify; ok "misroute repaired, gate passes"

# ---- Done -----------------------------------------------------------------------
rm -rf "$BAD_FIXTURE"; rm -f /tmp/chaos-corrupt.bin
step "CHAOS DONE"
ok "all four safety behaviors held (refused or left OLD safe) and recovered cleanly."
note "exercised: unknown-dir routing • deep-ETag corruption • missing-object left-safe • wrong-bucket misroute"
