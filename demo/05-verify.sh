#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# The delete gate: prove every OLD object is present + byte-identical somewhere in
# the per-provider bucket union. Exit 0 / ok=true means it is safe to delete OLD.
source "$(dirname "$0")/lib.sh"

step "VERIFY — every OLD object byte-identical in the provider-bucket union (the gate)"

if out="$(cli verify --old "$OLD_BUCKET" --git-repo "$FIXTURE_DIR" --region "$AWS_REGION" 2>&1)"; then
  print_report verify
  ok "GATE PASS — every object proven in NEW (safe to delete OLD)"
else
  err "$out"; print_report verify
  printf '%s✗ GATE FAIL — do NOT delete%s\n' "$C_RED" "$C_RESET"; exit 1
fi
