#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# REPO PLANE (separate from the object-store data plane): point every `.dvc` out at
# its provider's DVC remote by adding `remote: <provider>`. The hash format is left
# alone — DVC 3 reads v2 outs (no `hash:`) from the legacy key layout migrate copied.
# Pure-YAML — no `dvc` binary, no checked-out data needed. Operates on the git
# fixture; in production point --git-repo at the real code repo's working tree.
#   demo/06-repoint.sh                     # repoint the whole fixture
#   PROVIDER=earnin demo/06-repoint.sh     # scope to one provider's .dvc files
source "$(dirname "$0")/lib.sh"

step "REPOINT — set each .dvc's remote to its provider bucket (repo plane)"

if [ ! -d "$FIXTURE_DIR" ]; then
  err "no git fixture at $FIXTURE_DIR — run demo/03-map.sh (or demo/all.sh) first"
  exit 1
fi

scope=()
[ -n "${PROVIDER:-}" ] && scope=(--provider "$PROVIDER")
sample="$(find "$FIXTURE_DIR/data/dvc" -name '*.dvc' | sort | head -1)"

note "dry-run first (preview — writes nothing)…"
cli repoint --git-repo "$FIXTURE_DIR" "${scope[@]}" --dry-run >/dev/null 2>&1 || true
print_report repoint

note "writing remote: <provider> into each .dvc (hash format untouched)…"
if out="$(cli repoint --git-repo "$FIXTURE_DIR" "${scope[@]}" 2>&1)"; then
  ok "repoint complete"
else
  err "$out"; print_report repoint; exit 1
fi
print_report repoint

# Prove the change is minimal: one `+  remote: <provider>` line per file.
if [ -n "$sample" ]; then
  rel="${sample#"$FIXTURE_DIR/"}"
  printf '%ssample repoint (git diff %s):%s\n' "$C_BOLD" "$rel" "$C_RESET"
  git -C "$FIXTURE_DIR" diff -- "$rel" 2>/dev/null | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' || true
fi
