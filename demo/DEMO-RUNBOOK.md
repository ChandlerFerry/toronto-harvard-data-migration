# Client Demo Runbook — DVC Migration on LocalStack

A ~10-minute live walkthrough that proves the migration end-to-end on a laptop,
with **no AWS account and zero risk**. LocalStack stands in for S3; every command
is the real production CLI. The story to tell: *we copy one monolithic remote into
per-provider buckets server-side and prove it hash-for-hash — the source is never
touched.*

Every step is a **one-line script** in [`../demo/`](../demo). They are idempotent
and `set -euo pipefail`, so the demo is reliable to re-run live. Each script just
wraps the real `dvc-map` / `dvc-migrate` / `dvc-verify` / `dvc-delete` CLIs — run
them by hand if you prefer (the scripts echo what they invoke). The demo is
**non-destructive by default**: the delete step only *dry-runs* the gate, leaving
OLD intact. Pass `DEMO_DELETE=1` to actually drain OLD. A separate
[`demo/chaos.sh`](../demo/chaos.sh) deliberately breaks the migration four ways and
proves every safety gate **refuses** and then **recovers**.

> **Bucket names** carry the S3 **account-regional namespace** suffix the real
> buckets use: `dvc-<provider>-305901448049-us-east-2-an` (the
> illustrative tables below abbreviate to the `dvc-<provider>`
> stem). The names are derived in one place (`config/sources.ts → bucketName`) and
> reconciled against `tracker-infra` by an automated test.

---

## What you'll demonstrate

1. **Map** — derive `md5 → provider → bucket` from git history of the `.dvc` files,
   joined with the object store. Validates loudly (orphans/conflicts → exit 1).
2. **Migrate (provider split)** — one monolithic OLD remote is scattered into
   per-provider buckets (`dvc-<provider>`) by server-side copy
   (bytes never touch the machine).
3. **Verify** — every OLD object proven present and byte-identical in the *union*
   of the per-provider buckets (hash-for-hash). This is the gate that would have to
   pass before any deletion.
4. **Source stays intact** — the demo never deletes. (Draining OLD is the separate
   production `dvc-delete` step, which re-runs this same gate and aborts on any gap;
   see [`RUNBOOK.md`](RUNBOOK.md).)
5. **Scales** — the identical command is automatically memory-sharded, so it runs
   flat for tens of millions of objects.

---

## 0. Prerequisites (once)

- Docker (Rancher Desktop is fine), Node ≥ 24, `pnpm`, and the AWS CLI.
- The sample data at `../oi-example-dvc-s3-remote` (2742 objects, 6.6 GB).

```bash
cd harvard-data-migration
pnpm install
```

> Every demo script sources [`demo/lib.sh`](../demo/lib.sh), which points the AWS
> CLI and the migration CLIs at LocalStack. Override any default via env, e.g.
> `OLD_BUCKET=old-demo`, `SEED_SHARDS="00 0a 1b"`, `SEED_FULL=1`.

---

## TL;DR — the whole demo in one command

```bash
demo/all.sh                 # up → seed → map → migrate(split) → verify → upgrade(.dvc v2→v3) → delete-GATE (dry-run)
DEMO_DELETE=1 demo/all.sh   # …and actually drain OLD in the delete step
demo/chaos.sh               # break it 4 ways; prove each gate refuses + recovers
```

`demo/all.sh` runs the full happy path and prints its own **BEFORE** and **AFTER**
tables. It leaves **OLD intact** unless `DEMO_DELETE=1`. The step-by-step sections
below are the same commands if you'd rather narrate each one.

---

## 1. Start LocalStack

```bash
demo/01-up.sh
```

Brings up the S3 mock on `:4566` and waits until it's healthy.

> Talking point: *"LocalStack is a local S3. The exact same CLI runs against real
> AWS by simply not setting `AWS_ENDPOINT_URL`."*

---

## 2. Seed the OLD (monolithic) remote

```bash
demo/02-seed.sh                 # a few md5 shards — seconds (fast for a live demo)
SEED_FULL=1 demo/02-seed.sh     # all 2742 objects — ~1–2 min (more impressive)
```

Expected (fast mode): `seeded s3://old-demo : 68 objects, 33601036 bytes`.

> Talking point: *"This is a real DVC remote — content-addressed objects, both the
> v2 `ab/…` and v3 `files/md5/ab/…` layouts, plus `.dir` directory objects, all in
> ONE legacy bucket."*

---

## 3. Show the BEFORE

```bash
demo/snapshot.sh BEFORE
```

```
──────── BEFORE ────────
BUCKET                                OBJECTS            BYTES
old-demo                                   68         33601036
```

One monolithic bucket; no provider buckets exist yet.

---

## 4. Build + validate the provider mapping

```bash
demo/03-map.sh
```

This synthesizes a tiny git repo of `.dvc` files referencing the **real seeded
md5s** (grouped under real provider folders), then runs the actual `dvc-map`:

```
provider -> bucket routing (from the latest map report):
  dvc-affinity       14
  dvc-coinout        13
  dvc-earnin         13
  dvc-intuit         13
  dvc-kronos         13
  dvc-public          2
  orphans=0 conflicts=0 unreferenced=2
```

> Talking point: *"The split key comes from git history of the `.dvc` files, not a
> guess. `dvc-map` is a gate — any orphan md5 (referenced but missing) or provider
> conflict (one md5 in two providers) fails it with exit 1. Here it's clean. The two
> `unreferenced` objects are the `.dir` directory objects, which route to `public`."*

---

## 5. Migrate OLD → per-provider buckets (server-side copy + verify)

```bash
demo/04-migrate.sh
```

It prints BEFORE/AFTER itself and runs:

```bash
dvc-migrate --old old-demo --git-repo .demo/git-fixture
```

```
──────── AFTER migrate ────────
BUCKET                                OBJECTS            BYTES
old-demo                                   68         33601036
dvc-affinity               14         10751758
dvc-coinout                13          3151309
dvc-earnin                 13          1195120
dvc-intuit                 13         12400085
dvc-kronos                 13          6077637
dvc-public                  2            25127
```

Log line: `... split=true copied=68 skipped=0 errors=0 verifyOk=true ...`

> Talking points:
> - *"One bucket in, six buckets out — routed by the mapping. The objects moved
>   **bucket-to-bucket inside S3** (`CopyObject`); the bytes never came down to this
>   machine. In production that means no big EC2 and zero in-region transfer cost."*
> - *"Every object is copied **verbatim** — the key and hash are preserved, so the
>   object layout is unchanged (no normalization). It's a pure data move; migrate
>   does NOT touch `.dvc` files. The v2 → v3 `.dvc` upgrade is a **separate**
>   command, `dvc-upgrade` (step 7), run on the code repo before the delete. md5 is
>   preserved either way, so OLD stays deletable."*
> - *"Deep ETag verification (always on) proved each object byte-for-byte. OLD is
>   untouched — migrate never deletes."*
> - *Scale:* the command is already memory-sharded (one md5-prefix shard at a time),
>   so this exact invocation runs flat for tens of millions of objects.

---

## 6. Verify — the hash-for-hash gate

```bash
demo/05-verify.sh
```

Runs `dvc-verify --old old-demo --git-repo …` against the **union** of the provider
buckets:

```
... buckets=6 ok=true matched=68 missing=0 ...
verify exit code: 0  (0 = every object proven in NEW)
```

> Talking point: *"This is the gate. md5 is globally unique, so an object is proven
> if it's byte-identical in ANY destination bucket. Deletion is impossible unless
> this says every single object is present and identical."*

---

---

## 7. Repoint — upgrade the git repo's `.dvc` files to v3 (BEFORE delete)

```bash
demo/06-upgrade.sh                              # upgrade the whole fixture
SUBDIR=data/dvc/Earnin demo/06-upgrade.sh       # scope to one provider's .dvc files
```

This is the **repo plane** — separate from the object-store data plane. It upgrades
outdated `.dvc` files in the git repo from **v2 → v3** in place by adding
`hash: md5` (pure-YAML, md5 preserved, no `dvc` binary or checked-out data needed).
The fixture is a deliberate mix of v2 and v3, so you see both counts:

```
before: 44 v2 (.dvc without hash) + 22 v3 already current
... upgraded: 44, alreadyV3: 22, errors: 0
sample upgrade (git diff ...): +  hash: md5
 44 files changed, 44 insertions(+)
```

> Talking point: *"The pointer upgrade is a one-line diff per file — `+ hash: md5`
> — and the md5 is untouched, so it's a no-risk metadata bump. It runs BEFORE the
> delete: upgrade the repo to v3, confirm a build works, THEN drain the old data.
> A true v1 `.dvc` (`wdir`/`deps`/multi-out) fails loud instead of being mangled."*

## 8. The delete gate (dry-run by default)

```bash
demo/07-delete.sh                 # re-verify + DRY-RUN delete: shows the target count, removes nothing
DEMO_DELETE=1 demo/07-delete.sh   # actually drain OLD (provider buckets kept)
```

`dvc-delete` re-runs the full verify gate (now including the **destination
assertion** — each object must be present in its *correctly-routed* bucket, not
merely somewhere in the union), then deletes from OLD only the proven set. It is
dry-run by default and refuses production-named buckets without an explicit
override (see [`RUNBOOK.md`](RUNBOOK.md) §2).

> Talking point: *"Delete can only ever remove what's already proven in the right
> NEW bucket. A misrouted object — say a private provider's file that landed in the
> public bucket — fails the gate and blocks the delete, so the source is never
> dropped on a bad copy."*

## 9. Consumer proof — real `dvc pull` from the migrated buckets

```bash
demo/08-dvc-pull.sh   # needs the `dvc` binary (v3+) on PATH
```

Spins up a throwaway DVC repo per test, points its remote at a provider bucket
(LocalStack `endpointurl`), shows `dvc cache dir` (empty before, content-addressed
after), then pulls one object of each storage layout and md5-verifies the result.

> **KNOWN RED (by design):** the v3-layout pull passes; the **v2-layout pull
> FAILS**. A `.dvc` upgraded to v3 by `dvc-upgrade` makes DVC look only under
> `files/md5/…`, but the verbatim migrate leaves v2-layout objects at their
> `xx/yyy…` keys — DVC reports "missing cache files". The same object pulls fine
> with its original v2 `.dvc`. This is the empirical answer to the open question in
> [`plans/2026-06-17-dvc-v3-migration.md`](plans/2026-06-17-dvc-v3-migration.md):
> a repointed repo DOES need v3-layout objects in the remote. Until the engine
> decision lands (layout backfill in migrate vs. gating upgrade), this step exits 1
> and `demo/all.sh` ends red at step 08.

## 10. Chaos test — break it, watch it refuse, watch it recover

```bash
demo/chaos.sh
```

Brings up a clean verified baseline, then injects four faults and proves the gate
**refuses** each (exit 1, OLD never dropped) and then **recovers** by re-migrating:

1. **Unknown provider folder** — a folder absent from the provider map. `migrate`
   aborts rather than silently routing it to `public` (the data-exposure trap).
   Recovery: re-run with the correct folder names (or `--allow-unknown-dirs`).
2. **Same-size corruption** — a NEW copy overwritten with same-size garbage. Deep
   ETag verify catches it; delete refuses. Recovery: re-migrate re-copies it.
3. **Missing object** — an object deleted from a provider bucket. Union verify
   catches the gap; delete refuses. Recovery: re-migrate restores it.
4. **Misroute** — a provider's object moved into the `public` bucket. The
   destination assertion catches it (present in the union, but wrong bucket);
   verify fails. Recovery: re-migrate copies it back to the correct bucket.

> Talking point: *"Every failure mode degrades safe: the gate refuses, OLD is never
> touched, and re-running the idempotent migrate repairs the state."*

---

## 11. Reset / cleanup

```bash
demo/reset.sh    # wipe buckets + reports + fixture, keep LocalStack up (re-run demo)
demo/down.sh     # stop LocalStack and remove its volume
```

---

## The scripts at a glance

| Script | Does |
|---|---|
| `demo/01-up.sh` | start LocalStack, wait for health |
| `demo/02-seed.sh` | seed OLD monolith from the sandbox (`SEED_FULL=1` for all 2742) |
| `demo/snapshot.sh [label]` | print OLD + every provider bucket (the before/after table) |
| `demo/03-map.sh` | build git fixture + run real `dvc-map` (provider routing + validation) |
| `demo/04-migrate.sh` | `dvc-migrate` (monolith → per-provider) with before/after |
| `demo/05-verify.sh` | `dvc-verify` (the gate, union of buckets + destination assertion) |
| `demo/06-upgrade.sh` | `dvc-upgrade` — upgrade the git repo's v2 `.dvc` files to v3 (`SUBDIR=` to scope) |
| `demo/07-delete.sh` | `dvc-delete` gate — dry-run by default; `DEMO_DELETE=1` drains OLD |
| `demo/08-dvc-pull.sh` | real `dvc pull` consumer proof per storage layout (v2 currently RED — see §9) |
| `demo/incremental.sh` | ONE provider per run: migrate → verify → upgrade → delete its slice |
| `demo/chaos.sh` | break the migration 4 ways; prove each gate refuses + recovers |
| `demo/reset.sh` / `demo/down.sh` | clean slate / stop LocalStack |
| `demo/all.sh` | up → seed → map → migrate → verify → upgrade → delete-gate → dvc-pull (dry-run; `DEMO_DELETE=1` to drain) |

---

## 11. The scale story (slide, not a live run)

Show the measured memory curve — a whole-bucket buffer OOMs, while the sharded path
the tool always uses runs flat:

| objects | whole-bucket buffer | sharded (automatic) |
|---:|---|---|
| 10 M | out-of-memory crash | **515 MB** |
| 50 M | ~60 GB → crash | **1.4 GB** |

> Talking point: *"5 TB of these files is ~2 million objects; even 50 million stays
> under 1.5 GB of RAM. It runs on a small instance — the same `demo/04-migrate.sh`
> command, just pointed at the real bucket: provider routing one md5-prefix shard at
> a time, scattered to the provider buckets."*

---

## FAQ / likely client questions

- **"Does this touch our production data during the demo?"** No — LocalStack is a
  local sandbox; nothing leaves the laptop. (The provider buckets carry the real
  Ohio names to show the true mapping, but they live only in LocalStack.)
- **"What if the machine crashes mid-run?"** Re-run the same command. Copy is
  idempotent (already-copied objects are skipped, corrupt ones re-copied); delete is
  idempotent and re-verifies first. No data loss at any point.
- **"Big files?"** Objects > 5 GiB copy via multipart automatically; bytes still
  never transit the machine.
- **"How long for the real 5 TB?"** See the estimate below — roughly tens of minutes
  for the copy at reasonable concurrency; we calibrate with a one-source pilot before
  committing a firm number.

---

## Transfer-time estimate for 5 TB (at the demo's average file size)

**Object count.** The demo is 6.6 GiB across 2742 objects → **avg ≈ 2.43 MiB/object**.
So 5 TB at that average is:

```
5 TB ÷ 2.43 MiB  ≈  2.0–2.2 million objects
```

**The bottleneck is request rate, not bandwidth.** We use server-side `CopyObject`:
S3 copies bytes internally, so there is no 5 TB to push through a network — the time
is just *how many CopyObject calls per second* we sustain. Each object = one call.

```
time  ≈  object_count ÷ sustained_copies_per_second
sustained_copies_per_second  ≈  concurrency ÷ per_copy_latency   (until S3's ceiling)
```

S3 scales to 3,500 COPY/sec **per prefix**, and DVC keys spread across 256 hash
prefixes — so the ceiling (~hundreds of thousands/sec) is never the limit; our chosen
concurrency is. Realistic real-S3 estimate for ~2.1 M objects:

| sustained rate | implies | **copy wall-time** |
|---:|---|---:|
| 500 copies/sec | low concurrency (~64) | ~70 min |
| 1,000 copies/sec | moderate (~128) | **~35 min** |
| 2,000 copies/sec | high (~256+) | ~18 min |

So the **copy is roughly 15–70 minutes** (≈ half an hour at moderate concurrency).
`verify` (sharded) is mostly listing — a few minutes. `delete` is a separate, later
run (DELETE requests are free, batched 1,000/call) — also minutes.

**Caveats / how we'll firm it up:**
- The LocalStack demo tops out at ~450 copies/sec — that's the *mock's* single-container
  ceiling (it doesn't scale with concurrency), **not** predictive of real S3, which
  does scale with concurrency.
- Real latency/throughput depends on object-size mix and instance network — so before
  committing, run a **one-source pilot**: migrate a single provider and read the run
  report's `copied` count ÷ wall-time → real copies/sec → multiply out to 5 TB. Tune
  `--concurrency` to taste.
