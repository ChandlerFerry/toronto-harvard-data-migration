#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# Print the OLD + per-provider bucket object/byte counts. Run it any time to show
# state; the canonical "before" and "after" of the whole demo:
#   demo/snapshot.sh BEFORE      # OLD full, no provider buckets yet
#   demo/snapshot.sh AFTER       # OLD drained, provider buckets populated
source "$(dirname "$0")/lib.sh"
snapshot "${1:-snapshot}"
