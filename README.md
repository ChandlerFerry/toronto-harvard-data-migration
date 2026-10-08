
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
dvcm map --old "$OLD_BUCKET" --git-repo "$GIT_REPO"
```
`map` exits 1 on orphans (in git but never pushed to OLD: nothing to copy, review them),
conflicts or unreadable `.dir` objects (these two also abort `migrate`). Check its `unreferenced` count:
those OLD objects are referenced by no `.dvc` under `data/dvc` in any commit (e.g. `dvc.lock`-only
outputs, `.dvc` files outside `data/dvc`, unparseable `.dvc` YAML). `migrate`/`verify` leave them in
OLD. Review the `unreferenced` rows in the map report, and pass `--allow-unreferenced` to the
`public` migrate/verify only if they belong in public.

4. Migrate & Verify (one provider at a time)
```
dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider affinity
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider affinity

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider coinout
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider coinout

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider earnin
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider earnin

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider homebase
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider homebase

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider intuit
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider intuit

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider kronos
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider kronos

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider lightcast
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider lightcast

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider paychex
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider paychex

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider womply
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider womply

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider zearn
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider zearn

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider public
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider public
```

5. Verify all
```
dvcm verify --old "$OLD_BUCKET" --git-repo "$GIT_REPO"
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

dvcm repoint --git-repo "$GIT_REPO" --dry-run
dvcm repoint --git-repo "$GIT_REPO"
git -C "$GIT_REPO" add .dvc/config data/dvc
git -C "$GIT_REPO" commit -m "chore: point dvc outputs at per-provider remotes"
```
Smoke-test with `dvc pull` in a fresh clone (the "no default remote set" warning is expected). Older commits have no `remote:` field: pull them with
`dvc pull -r <provider>`. New `.dvc` files need it too: re-run `dvcm repoint` (idempotent).

7. Delete / Real Delete (`--no-dry-run` requires `--git-repo`)
```
dvcm delete --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider affinity
```
```
dvcm delete --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --no-dry-run --allow-production
```
Objects whose ETags can't be compared (multipart uploads, > 5 GB copies) are refused and reported
as `corrupt:size-only` (exit 1). Spot-check a few from the report, then delete them:
```
dvcm delete --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --no-dry-run --allow-production --allow-size-only
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
