#!/usr/bin/env bash
# Re-exec under bash when started via `sh` (these scripts need bash: pipefail, arrays).
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
# CONSUMER PROOF (real `dvc` binary): after migrate + upgrade (+ delete of OLD),
# can a real DVC client still pull data from its per-provider bucket?
# Empirically answers the plan's open question: does a v3 `.dvc` (hash: md5)
# pull an object stored at a v2 layout key, or only at files/md5/…?
# Also demonstrates `dvc cache dir` and what lands in the local cache.
# Requires: the `dvc` binary (v3+) and a completed demo/04-migrate.sh run.
source "$(dirname "$0")/lib.sh"

step "DVC PULL — real DVC client pulls from the migrated provider buckets"

if ! command -v dvc >/dev/null 2>&1; then
  err "dvc binary not found — install DVC v3+ (https://dvc.org/doc/install) to run this step"
  exit 1
fi
if [ ! -d "$FIXTURE_DIR" ]; then
  err "no git fixture at $FIXTURE_DIR — run demo/03-map.sh (or demo/all.sh) first"
  exit 1
fi
note "dvc $(dvc --version)"

CONSUMER_ROOT="$REPO_ROOT/.demo/dvc-consumer"
rm -rf "$CONSUMER_ROOT"

# Which layout does a provider bucket hold this md5 under? Prints "v3", "v2" or "".
object_layout() {
  local bucket="$1" md5="$2"
  if awsls s3api head-object --bucket "$bucket" --key "files/md5/${md5:0:2}/${md5:2}" >/dev/null 2>&1; then
    echo v3
  elif awsls s3api head-object --bucket "$bucket" --key "${md5:0:2}/${md5:2}" >/dev/null 2>&1; then
    echo v2
  fi
}

# pull_one <label> <dvc-file> <bucket> <md5>
pull_one() {
  local label="$1" dvcfile="$2" bucket="$3" md5="$4"
  local dir="$CONSUMER_ROOT/$label"
  mkdir -p "$dir"
  git -C "$dir" init -q
  (
    cd "$dir"
    dvc init -q
    dvc config core.analytics false
    dvc remote add -d origin "s3://$bucket" -q
    dvc remote modify origin endpointurl "$AWS_ENDPOINT_URL"
    dvc remote modify origin region "$AWS_REGION"
    cp "$dvcfile" .
    note "  cache dir: $(dvc cache dir)  (empty before pull)"
    if dvc pull "$(basename "$dvcfile")" >"$dir/.pull-err" 2>&1; then
      local data="${dvcfile##*/}"; data="${data%.dvc}"
      local got; got="$(md5sum "$data" | awk '{print $1}')"
      if [ "$got" = "$md5" ]; then
        ok "$label: pulled $data from s3://$bucket — md5 verified ($md5)"
      else
        err "$label: pulled but md5 MISMATCH (want $md5, got $got)"; return 1
      fi
      note "  cache now holds:"
      find "$(dvc cache dir)" -type f | sed 's/^/    /'
    else
      err "$label: dvc pull FAILED from s3://$bucket for md5 $md5"
      sed 's/^/    /' "$dir/.pull-err" | head -5 >&2
      return 1
    fi
  )
}

# Pick one .dvc per storage layout (v2 `xx/yyy…`, v3 `files/md5/…`) so the pull is
# proven against both layouts the verbatim migrate preserves.
v2_file="" v2_bucket="" v2_md5=""
v3_file="" v3_bucket="" v3_md5=""
while IFS= read -r f; do
  [ -n "$v2_file" ] && [ -n "$v3_file" ] && break
  md5="$(basename "$f" .bin.dvc)"
  provider="$(basename "$(dirname "$f")" | tr '[:upper:]' '[:lower:]')"
  bucket="$(provider_bucket "$provider")"
  case "$(object_layout "$bucket" "$md5")" in
    v2) [ -z "$v2_file" ] && { v2_file="$f"; v2_bucket="$bucket"; v2_md5="$md5"; } ;;
    v3) [ -z "$v3_file" ] && { v3_file="$f"; v3_bucket="$bucket"; v3_md5="$md5"; } ;;
  esac
done < <(find "$FIXTURE_DIR/data/dvc" -name '*.bin.dvc' | sort)

status=0
if [ -n "$v3_file" ]; then
  note "v3-layout object (files/md5/…): $(basename "$v3_file") → $v3_bucket"
  pull_one v3-layout "$v3_file" "$v3_bucket" "$v3_md5" || status=1
else
  note "(no v3-layout object found in the provider buckets — skipped)"
fi
if [ -n "$v2_file" ]; then
  note "v2-layout object (xx/yyy…): $(basename "$v2_file") → $v2_bucket"
  pull_one v2-layout "$v2_file" "$v2_bucket" "$v2_md5" || status=1
else
  note "(no v2-layout object found in the provider buckets — skipped)"
fi

if [ "$status" -ne 0 ]; then
  err "consumer pull FAILED for at least one layout — the repointed .dvc files may need v3-layout objects in the remote"
  exit 1
fi
ok "real DVC client can pull the migrated data end-to-end"
