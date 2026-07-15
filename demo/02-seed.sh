#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# Seed the OLD monolithic remote from the local DVC sandbox.
#   default : a few md5 shards (fast, seconds)   -> SEED_SHARDS="00 0a ..."
#   full    : all 2742 objects (~1-2 min)        -> SEED_FULL=1 demo/02-seed.sh
source "$(dirname "$0")/lib.sh"

step "SEED — load the legacy monolithic remote (s3://$OLD_BUCKET)"

if [ ! -d "$SANDBOX_DIR" ]; then
  err "sandbox not found: $SANDBOX_DIR (set SANDBOX_DIR)"
  exit 1
fi

awsls s3 mb "s3://$OLD_BUCKET" 2>/dev/null || true

if [ "${SEED_FULL:-0}" = "1" ]; then
  note "seeding ALL objects from $SANDBOX_DIR (this takes ~1-2 min)…"
  awsls s3 sync "$SANDBOX_DIR" "s3://$OLD_BUCKET" --only-show-errors
else
  note "seeding md5 shards [$SEED_SHARDS]…"
  for sh in $SEED_SHARDS; do
    # v2 layout (ab/...) and v3 layout (files/md5/ab/...); skip shards not present.
    if [ -d "$SANDBOX_DIR/$sh" ]; then
      awsls s3 cp "$SANDBOX_DIR/$sh" "s3://$OLD_BUCKET/$sh" --recursive --only-show-errors
    fi
    if [ -d "$SANDBOX_DIR/files/md5/$sh" ]; then
      awsls s3 cp "$SANDBOX_DIR/files/md5/$sh" "s3://$OLD_BUCKET/files/md5/$sh" --recursive --only-show-errors
    fi
  done
fi

read -r objs bytes < <(bucket_stats "$OLD_BUCKET")
ok "seeded s3://$OLD_BUCKET : $objs objects, $bytes bytes"
