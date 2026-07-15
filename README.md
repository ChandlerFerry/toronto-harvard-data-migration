

## Runbook
1. Setup
```
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 24

curl -fsSL https://get.pnpm.io/install.sh | sh -

pip install dvc
```
```
git clone <non-sandbox-dvc-file-repo>
```

2. Install the CLI (builds `dist/` and links `dvcm` onto your PATH)
```
pnpm install
pnpm build
pnpm link --global

dvcm --help
```
During development, run straight from source instead: `pnpm dvcm <command> ...`

1. Plan/Validate
```
export AWS_REGION=us-east-2
export OLD_BUCKET=oi-economictracker-dvc
export GIT_REPO=./tracker-dvc-sandbox
dvcm map --old "$OLD_BUCKET" --git-repo "$GIT_REPO"
```

1. Migrate & Verify
2. Verify even more things
```
dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider affinity
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider affinity
dvcm upgrade --git-repo "$GIT_REPO" --provider affinity

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider coinout
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider coinout
dvcm upgrade --git-repo "$GIT_REPO" --provider coinout

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider earnin
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider earnin
dvcm upgrade --git-repo "$GIT_REPO" --provider earnin

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider homebase
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider homebase
dvcm upgrade --git-repo "$GIT_REPO" --provider homebase

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider intuit
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider intuit
dvcm upgrade --git-repo "$GIT_REPO" --provider intuit

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider kronos
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider kronos
dvcm upgrade --git-repo "$GIT_REPO" --provider kronos

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider lightcast
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider lightcast
dvcm upgrade --git-repo "$GIT_REPO" --provider lightcast

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider paychex
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider paychex
dvcm upgrade --git-repo "$GIT_REPO" --provider paychex

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider womply
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider womply
dvcm upgrade --git-repo "$GIT_REPO" --provider womply

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider zearn
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider zearn
dvcm upgrade --git-repo "$GIT_REPO" --provider zearn

dvcm migrate --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider public
dvcm verify  --old "$OLD_BUCKET" --git-repo "$GIT_REPO" --provider public
dvcm upgrade --git-repo "$GIT_REPO" --provider public
```

1. Verify all
```
dvcm verify --old "$OLD_BUCKET" --git-repo "$GIT_REPO"
```

1. Delete / Real Delete
```
dvcm delete --old "$OLD_BUCKET" --provider affinity
```
```
dvcm delete --old "$OLD_BUCKET" --no-dry-run --allow-production
```