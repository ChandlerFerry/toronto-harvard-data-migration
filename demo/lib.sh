#!/usr/bin/env bash
# Shared demo environment + helpers. SOURCE this from the other demo scripts:
#   source "$(dirname "$0")/lib.sh"
# It points the AWS CLI + the migration CLIs at LocalStack and defines the
# bucket/path variables and the snapshot helper used for before/after.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- LocalStack endpoint + throwaway creds (identical CLI works on real AWS by
#     simply NOT exporting AWS_ENDPOINT_URL). ---
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_REGION="${AWS_REGION:-us-east-2}"

# --- Demo knobs (override via env). ---
OLD_BUCKET="${OLD_BUCKET:-old-demo}"                       # the legacy monolithic remote
SANDBOX_DIR="${SANDBOX_DIR:-$REPO_ROOT/../oi-example-dvc-s3-remote}"
FIXTURE_DIR="${FIXTURE_DIR:-$REPO_ROOT/.demo/git-fixture}" # synthetic git provider map
SEED_SHARDS="${SEED_SHARDS:-00 0a 1b 4f a3 ff}"            # md5 shards to seed for a fast demo
export REPORT_DIR="${REPORT_DIR:-$REPO_ROOT/reports}"

# Provider buckets the demo writes to (real `dvc-` names; PRODUCTION-guarded on delete).
PROVIDER_BUCKET_PREFIX="dvc-"
# New-account id baked into the S3 account-regional bucket names
# (`<prefix>-<src>-<accountId>-<region>-an`); override via env if needed.
ACCOUNT_ID="${ACCOUNT_ID:-305901448049}"

# Full account-regional bucket name for a source stub — must match the code's
# bucketName() so the demo can target a specific provider bucket exactly.
provider_bucket() {
  printf '%s-%s-%s-%s-an\n' "${PROVIDER_BUCKET_PREFIX%-}" "$1" "$ACCOUNT_ID" "$AWS_REGION"
}

# --- Color (auto-disabled when stdout is not a TTY, or NO_COLOR is set). ---
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''
fi

# Bold-cyan section header with a rule (the visual anchor between steps).
step() { printf '\n%s%s━━━ %s ━━━%s\n' "$C_BOLD" "$C_CYAN" "$*" "$C_RESET"; }
# Green success line.
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
# Dim secondary/footnote line.
note() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
# Red error line (used when a captured CLI run failed).
err()  { printf '%s%s%s\n' "$C_RED" "$*" "$C_RESET" >&2; }

# `aws` against LocalStack.
awsls() { aws --endpoint-url "$AWS_ENDPOINT_URL" --region "$AWS_REGION" "$@"; }

# Runner for the migration CLI subcommands (map/migrate/verify/delete/upgrade).
cli() { pnpm -s exec tsx "$REPO_ROOT/src/cli/main.ts" "$@"; }

# Object count + total bytes for a bucket ("0 0" if absent/empty). Robust to the
# bucket not existing yet (before the migrate creates the provider buckets).
bucket_stats() {
  awsls s3 ls "s3://$1" --recursive --summarize 2>/dev/null | awk '
    /Total Objects:/{o=$3} /Total Size:/{s=$3}
    END{printf "%s %s\n", (o==""?0:o), (s==""?0:s)}'
}

# All existing provider buckets (sorted).
provider_buckets() {
  awsls s3 ls 2>/dev/null | awk '{print $3}' | grep "^${PROVIDER_BUCKET_PREFIX}" | sort || true
}

# Print a labeled before/after table: OLD bucket (yellow) + every provider bucket
# (green). Header bold; rule dim.
snapshot() {
  local label="${1:-snapshot}" b objs bytes color
  printf '\n%s%s──────── %s ────────%s\n' "$C_BOLD" "$C_CYAN" "$label" "$C_RESET"
  printf '%s%-54s %10s %16s%s\n' "$C_BOLD" "BUCKET" "OBJECTS" "BYTES" "$C_RESET"
  for b in "$OLD_BUCKET" $(provider_buckets); do
    read -r objs bytes < <(bucket_stats "$b")
    if [ "$b" = "$OLD_BUCKET" ]; then color="$C_YELLOW"; else color="$C_GREEN"; fi
    printf '%s%-54s%s %10s %16s\n' "$color" "$b" "$C_RESET" "$objs" "$bytes"
  done
  printf '%s──────────────────────────────────────────────────────────────────────────────────%s\n' "$C_DIM" "$C_RESET"
}

# Pretty-print the latest run report of a given kind: the JSON SUMMARY only (the
# per-object `rows` array can be thousands of lines — left in the file). Replaces
# the raw single-line pino log with legible, indented JSON.
print_report() {
  local kind="$1" f
  f="$(ls -t "$REPORT_DIR/${kind}-"*.run-report.json 2>/dev/null | head -1 || true)"
  if [ -z "$f" ]; then note "(no $kind report found in $REPORT_DIR)"; return 0; fi
  printf '%s%s%s report%s\n' "$C_BOLD" "$C_BLUE" "$kind" "$C_RESET"
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = { kind: r.kind, summary: r.summary };
    if (Array.isArray(r.rows)) v.rowCount = r.rows.length;
    process.stdout.write(JSON.stringify(v, null, 2) + "\n");
  ' "$f"
  note "  full report (incl. per-object rows): $f"
}
