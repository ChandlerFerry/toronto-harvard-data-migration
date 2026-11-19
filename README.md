
## IAM (No delete access)
```
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetObject"
      ],
      "Resource": [
        "arn:aws:s3:::<REAL_OLD_BUCKET>",
        "arn:aws:s3:::<REAL_OLD_BUCKET>/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:ListBucket",
        "s3:GetObject",
        "s3:PutObject",
        "s3:AbortMultipartUpload"
      ],
      "Resource": [
        "arn:aws:s3:::dvc-*"
      ]
    }
  ]
}
```

## Runbook
1. Setup
```
curl -fsSL https://fnm.vercel.app/install | bash
curl -fsSL https://get.pnpm.io/install.sh | sh -
# open a new shell so fnm and pnpm are on PATH
fnm install 24
fnm use 24

pip install "dvc[s3]"
```
```
git clone <dvc-file-repo>
```

2. Install the CLI (builds `dist/` and links `dvcm` onto your PATH)
```
pnpm install
pnpm build
pnpm link --global

dvcm --help
```
During development, run straight from source instead: `pnpm dvcm <command> ...`

3. Plan/Validate
```
export AWS_REGION=us-east-2   # dvcm defaults to --region us-east-2; pass --region if this changes
export OLD_BUCKET=oi-economictracker-dvc
export GIT_REPO=./<dvc-file-repo>   # the repo cloned in step 1
export CONFIG=./config/retina-routing.json  # required by every command: see "Config file" below
dvcm map --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG"
```
`map` exits 1 on orphans (in git but never pushed to OLD: nothing to copy, review them),
conflicts or unreadable `.dir` objects (these two also abort `migrate`). Check its `unreferenced` count:
those OLD objects are referenced by no `.dvc` under `data/dvc` in any commit (e.g. `dvc.lock`-only
outputs, `.dvc` files outside `data/dvc`, unparseable `.dvc` YAML). `migrate`/`verify` leave them in
OLD. Review the `unreferenced` rows in the map report, and pass `--allow-unreferenced` to the
`public` migrate/verify only if they belong in public.

4. Migrate & Verify (one provider at a time)
```
dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider affinity
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider affinity

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider coinout
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider coinout

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider earnin
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider earnin

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider homebase
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider homebase

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider intuit
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider intuit

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider kronos
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider kronos

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider lightcast
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider lightcast

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider paychex
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider paychex

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider womply
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider womply

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider zearn
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider zearn

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider public
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider public
```

5. Verify all
```
dvcm verify --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG"
```

6. Repoint the repo (before delete)

Do NOT add `hash: md5` to v2 `.dvc` files (no `dvc cache migrate --dvc-files`): migrate copies
keys verbatim, and DVC 3 only finds v2 objects at the legacy `xx/yyy…` key when the out has no `hash:`.
```
cd "$GIT_REPO"
for p in affinity coinout earnin homebase intuit kronos lightcast paychex womply zearn public; do
  dvc remote add -f "$p" "s3://dvc-$p-305901448049-$AWS_REGION-an"
done
dvc remote default --unset
cd -

dvcm repoint --git-repo "$GIT_REPO" --config "$CONFIG" --dry-run
dvcm repoint --git-repo "$GIT_REPO" --config "$CONFIG"
git -C "$GIT_REPO" add .dvc/config data/dvc
git -C "$GIT_REPO" commit -m "chore: point dvc outputs at per-provider remotes"
```
Smoke-test with `dvc pull` in a fresh clone (the "no default remote set" warning is expected). Older commits have no `remote:` field: pull them with
`dvc pull -r <provider>`. New `.dvc` files need it too: re-run `dvcm repoint` (idempotent).

7. Delete / Real Delete (`--no-dry-run` requires `--git-repo`)
```
dvcm delete --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --provider affinity
```
```
dvcm delete --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --no-dry-run --allow-production
```
Objects whose ETags can't be compared (multipart uploads, > 5 GB copies) are refused and reported
as `corrupt:size-only` (exit 1). Spot-check a few from the report, then delete them:
```
dvcm delete --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --no-dry-run --allow-production --allow-size-only
```

The role above has no delete access. The delete step needs a role that also allows
`s3:DeleteObject` on OLD:
```
{
  "Effect": "Allow",
  "Action": [
    "s3:ListBucket",
    "s3:GetObject",
    "s3:DeleteObject"
  ],
  "Resource": [
    "arn:aws:s3:::<REAL_OLD_BUCKET>",
    "arn:aws:s3:::<REAL_OLD_BUCKET>/*"
  ]
}
```

## One-commit runs (`--commit`)
By default `map`, `migrate`, `verify` and `delete` walk every commit on every ref. With
`--commit <sha|branch|tag>` they walk only that commit's tree: every `.dvc` file in it, not just
the files that commit changed.
```
dvcm map     --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --commit origin/main
dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --commit origin/main
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --config "$CONFIG" --commit origin/main
```
- The checks (conflicts, unknown folders, unreadable `.dir` objects) see only that commit.
- Objects named only by other commits count as unreferenced: `migrate` does not copy them, so they
  stay in OLD until a run without `--commit`.
- `delete` removes from OLD whatever is proven in NEW, so give it the same `--commit` as the
  `migrate` that did the copying. After a full `migrate`, run `delete` without it: with it, history
  objects already in public are deleted from OLD and those in other buckets are refused as misrouted.
- It is refused together with `--allow-unreferenced`, which would send all of that history to public.
- The name is resolved once per command. The sha is logged and written to the run report as
  `summary.commit`; pass a sha to keep the same view across commands.
- An md5 the commit names is routed by the folder that commit has it under. If another commit names
  it under a different folder, the later full run reports a conflict, and its `conflictWinners` entry
  has to name the folder used here, because the object is already in that bucket.
- `repoint` has no `--commit`: it edits the checked-out files.

## Config file
Every command requires `--config <path>`. The file holds everything the tool knows about the
repo being migrated, so none of it is hardcoded: `config/retina-routing.json` is the one for RETINA.
```
{
  "providers": ["affinity", "public"],
  "folders": { "Affinity": "affinity", "UI Claims": "public" },
  "ignoredMd5s": [{ "md5": "d41d8cd98f00b204e9800998ecf8427e", "note": "zero-byte file" }],
  "conflictWinners": [{ "md5": "<md5>", "folder": "UI Claims", "note": "<file>, also under Affinity" }]
}
```
- `providers`: one bucket each (`dvc-<provider>-<account>-<region>-an`). Must include `public`.
- `folders`: top-level folder under `data/dvc` -> provider. Matched ignoring case and surrounding
  spaces. A folder missing here is an unknown folder and stops `migrate`.
- `ignoredMd5s`: md5s treated as if no `.dvc` named them, so they count as unreferenced: they stay
  in OLD (or go to public with the rest under `--allow-unreferenced`). An ignored `.dir` is not read.
- `conflictWinners`: for an md5 named under more than one folder, the folder whose provider
  receives it. `migrate`, `verify`, `delete` and `repoint` all follow it.

The file is validated before any S3 call or `.dvc` write, and any problem aborts the run:
unreadable or malformed JSON, an unknown or missing key, an entry without a note, a badly formed
md5, a provider that is not lowercase letters and digits, a provider listed twice, a folder routed
to an unlisted provider, a folder named `public` routed anywhere else, two folders that differ only
by case, an md5 listed twice or on both lists, a winner naming a folder that is not in `folders`.
Every run report records the file's path and sha256 under `summary.config`, so you can confirm
each step used the same file.
