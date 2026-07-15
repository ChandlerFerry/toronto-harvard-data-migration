#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# REPO PLANE (separate from the object-store data plane): upgrade outdated `.dvc`
# files in the git repo from v2 -> v3 in place (adds `hash: md5`, md5 preserved).
# Pure-YAML — no `dvc` binary, no checked-out data needed. Operates on the git
# fixture; in production point --git-repo at the real code repo's working tree.
#   demo/06-upgrade.sh                 # upgrade the whole fixture
#   SUBDIR=data/dvc/Earnin demo/06-upgrade.sh   # scope to one provider's .dvc files
source "$(dirname "$0")/lib.sh"

step "REPOINT — upgrade outdated .dvc files in the git repo to v3 (repo plane)"

if [ ! -d "$FIXTURE_DIR" ]; then
  err "no git fixture at $FIXTURE_DIR — run demo/03-map.sh (or demo/all.sh) first"
  exit 1
fi

SUBDIR="${SUBDIR:-data/dvc}"
scan_dir="$FIXTURE_DIR/$SUBDIR"

# Count v2 (no `hash: md5`) vs v3 before, and grab one v2 file to show its diff.
v2_before=$(grep -rL 'hash: md5' "$scan_dir" --include='*.dvc' 2>/dev/null | wc -l | tr -d ' ')
v3_before=$(grep -rl 'hash: md5' "$scan_dir" --include='*.dvc' 2>/dev/null | wc -l | tr -d ' ')
sample="$(grep -rL 'hash: md5' "$scan_dir" --include='*.dvc' 2>/dev/null | head -1 || true)"
note "before: $v2_before v2 (.dvc without hash) + $v3_before v3 already current"

note "dry-run first (preview — writes nothing)…"
cli upgrade --git-repo "$FIXTURE_DIR" --subdir "$SUBDIR" --dry-run >/dev/null 2>&1 || true
print_report upgrade

note "upgrading v2 .dvc files in place (v3 ones are skipped; md5 unchanged)…"
if out="$(cli upgrade --git-repo "$FIXTURE_DIR" --subdir "$SUBDIR" 2>&1)"; then
  ok "upgrade complete"
else
  err "$out"; print_report upgrade; exit 1
fi
print_report upgrade

# Prove the change is minimal: one `+  hash: md5` line per upgraded file.
if [ -n "$sample" ]; then
  rel="${sample#"$FIXTURE_DIR/"}"
  printf '%ssample upgrade (git diff %s):%s\n' "$C_BOLD" "$rel" "$C_RESET"
  git -C "$FIXTURE_DIR" diff -- "$rel" 2>/dev/null | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' || true
  printf '%s' "$C_DIM"; git -C "$FIXTURE_DIR" diff --stat -- "$SUBDIR" 2>/dev/null | tail -1; printf '%s' "$C_RESET"
fi

v2_after=$(grep -rL 'hash: md5' "$scan_dir" --include='*.dvc' 2>/dev/null | wc -l | tr -d ' ')
ok "after: $v2_after v2 remaining (expect 0) — every .dvc under $SUBDIR is now v3"
