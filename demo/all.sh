#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# One-shot demo: up -> seed -> map -> migrate -> verify -> upgrade (v2->v3 .dvc
# upgrade in the git repo) -> delete-GATE (dry-run).
# Non-destructive by DEFAULT — OLD is left intact (the delete step only dry-runs the
# gate). Set DEMO_DELETE=1 to actually drain OLD in the delete step.
# Each step is also runnable on its own (demo/01-up.sh ... demo/07-delete.sh), and
# demo/chaos.sh proves the safety gates refuse a broken state and recover.
#   demo/all.sh                 # fast: a few md5 shards, dry-run delete only
#   SEED_FULL=1 demo/all.sh     # all 2742 objects
#   DEMO_DELETE=1 demo/all.sh   # also drain OLD (destructive) in the delete step
set -euo pipefail
HERE="$(dirname "$0")"
source "$HERE/lib.sh"   # color + helpers for the banner/footer below

step "DVC MIGRATION DEMO — monolith → per-provider split on LocalStack"

"$HERE/01-up.sh"
"$HERE/reset.sh"        # clean slate (idempotent re-runs)
"$HERE/02-seed.sh"
"$HERE/snapshot.sh" "BEFORE (monolith seeded, no provider buckets yet)"
"$HERE/03-map.sh"
"$HERE/04-migrate.sh"
"$HERE/05-verify.sh"
"$HERE/06-upgrade.sh"  # repo plane: upgrade the git repo's v2 .dvc files to v3 (before delete)
"$HERE/07-delete.sh"   # dry-run gate by default; DEMO_DELETE=1 actually drains OLD
"$HERE/08-dvc-pull.sh" # consumer proof: real `dvc pull` from the provider buckets
"$HERE/snapshot.sh" "AFTER migrate + verify (data split; OLD intact unless DEMO_DELETE=1)"

step "DONE"
ok "data split + verified + delete gate exercised; .dvc files upgraded to v3."
note "chaos test (break + recover): demo/chaos.sh   •   reports: ./reports/   •   stop: demo/down.sh"
