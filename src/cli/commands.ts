import { Command } from "commander";
import { GitHistoryCli } from "../adapters/gitHistoryCli.js";
import type { Logger } from "../adapters/logger.js";
import { type LoadedConfig, loadConfigFile } from "../config/configFile.js";
import { type Region, bucketName } from "../config/sources.js";
import type { GitDvcEntry, GitHistory } from "../ports/gitHistory.js";
import type { ObjectStore } from "../ports/objectStore.js";
import {
  type MappingValidationError,
  assertMappingValid,
  buildMapping,
} from "../services/mapping.js";
import { type RepointDeps, repointAll } from "../services/repoint.js";
import {
  type ReportEnvelope,
  type ReportKind,
  type ReportRow,
  writeRunReport,
} from "../services/runReport.js";
import { deleteOldAgainstBuckets, migrateSharded, verifySharded } from "../services/sharded.js";
import { type SplitMapping, buildSplitMapping, expandDirMembers } from "../services/split.js";

const parseInt10 = (v: string): number => Number.parseInt(v, 10);

function isPositiveInt(n: number | undefined): n is number {
  return n !== undefined && Number.isInteger(n) && n > 0;
}

export interface CliDeps {
  makeStore: (region: string) => ObjectStore;
  logger: Pick<Logger, "info" | "warn" | "error">;
  reportDir: string;
  now: () => string;
  gitHistory?: GitHistory;

  repoint?: RepointDeps;
}

function parseRegion(value: string): Region {
  if (value === "us-east-1" || value === "us-east-2") return value;
  throw new Error(`Unsupported region: ${value} (use us-east-1 or us-east-2)`);
}

interface CommonOptions {
  old: string;
  gitRepo: string;
  config: string;
  subdir: string;
  region: string;
  shardLength?: number;
  reportDir: string;
  allowUnknownDirs: boolean;
  allowUnreferenced: boolean;
  provider?: string;
  commit?: string;
}

async function abortRun(
  deps: CliDeps,
  reportDir: string,
  kind: ReportKind,
  ts: string,
  summary: Record<string, unknown>,
  reason: string,
  rows?: ReportRow[],
): Promise<null> {
  deps.logger.error({ reason }, `${kind} aborted: ${reason}`);
  await writeRunReport(reportDir, `${kind}-${ts}`, {
    kind,
    createdAt: ts,
    summary: { ...summary, aborted: true, reason },
    ...(rows !== undefined ? { rows } : {}),
  });
  process.exitCode = 1;
  return null;
}

const commitOptionHelp =
  "walk ONLY this commit's tree (sha, branch or tag) instead of every commit on every ref; objects named only by other commits count as unreferenced and are not copied";

const commitSummary = (commit: string | undefined): { commit?: string } =>
  commit !== undefined ? { commit } : {};

const failedCommitSummary = (
  requested: string | undefined,
  resolved: string | undefined,
): { commit?: string; requestedCommit?: string } => {
  if (resolved !== undefined) return { commit: resolved };
  return requested !== undefined ? { requestedCommit: requested } : {};
};

async function resolveWalkCommit(
  deps: CliDeps,
  git: GitHistory,
  gitRepo: string,
  requested: string | undefined,
  kind: ReportKind,
): Promise<string | undefined> {
  if (requested === undefined) return undefined;
  const commit = await git.resolveCommit(gitRepo, requested);
  deps.logger.info(
    { commit, requested },
    `${kind}: walking only commit ${commit} (--commit ${requested}); objects named only by other commits count as unreferenced`,
  );
  return commit;
}

const configOptionHelp =
  "config file holding the providers, folder table, winner list and ignore list (e.g. config/retina-routing.json)";

const configSummary = (loaded: LoadedConfig): { config: { path: string; sha256: string } } => ({
  config: { path: loaded.path, sha256: loaded.sha256 },
});

async function loadConfigOrAbort(
  deps: CliDeps,
  path: string,
  reportDir: string,
  kind: ReportKind,
  ts: string,
): Promise<LoadedConfig | null> {
  try {
    const loaded = await loadConfigFile(path);
    deps.logger.info(configSummary(loaded), `${kind}: using config ${loaded.path}`);
    return loaded;
  } catch (err) {
    return abortRun(deps, reportDir, kind, ts, { config: { path } }, (err as Error).message);
  }
}

const unknownProvider = (stub: string, loaded: LoadedConfig): string =>
  `unknown provider "${stub}" (expected one of: ${loaded.config.providers.join(", ")})`;

function withCommonOptions(cmd: Command, deps: CliDeps): Command {
  return cmd
    .requiredOption("--old <bucket>", "source (OLD) monolithic bucket to migrate from")
    .requiredOption(
      "--git-repo <dir>",
      "code repo whose git history is the md5 -> provider mapping",
    )
    .requiredOption("--config <path>", configOptionHelp)
    .option("--subdir <path>", "subtree containing .dvc files", "data/dvc")
    .option("--region <region>", "AWS region (us-east-1|us-east-2)", "us-east-2")
    .option(
      "--shard-length <n>",
      "md5 prefix length for memory sharding (2..4; default 2 = 256 shards)",
      parseInt10,
    )
    .option(
      "--allow-unknown-dirs",
      "route git folders absent from the provider map to public instead of aborting (fail-closed by default)",
      false,
    )
    .option(
      "--allow-unreferenced",
      "route OLD objects that no .dvc in git history references to public (by default they stay in OLD)",
      false,
    )
    .option(
      "--provider <stub>",
      "scope the run to ONE provider's bucket (incremental, single-provider migrate/verify/delete); the other providers' objects are left untouched",
    )
    .option("--commit <commit>", commitOptionHelp)
    .option("--report-dir <dir>", "directory for run reports", deps.reportDir);
}

interface ProviderScope {
  keepMd5: (md5: string) => boolean;
  targetBucket: string;
}

async function providerScopeOrAbort(
  deps: CliDeps,
  split: SplitMapping,
  region: Region,
  o: CommonOptions,
  kind: ReportKind,
  ts: string,
  loaded: LoadedConfig,
): Promise<ProviderScope | null> {
  const stub = o.provider ?? "";
  if (!loaded.config.isProvider(stub)) {
    const summary = { old: o.old, ...configSummary(loaded) };
    return abortRun(deps, o.reportDir, kind, ts, summary, unknownProvider(stub, loaded));
  }
  const targetBucket = bucketName(stub, region);
  return { keepMd5: (md5) => split.predictBucket(md5) === targetBucket, targetBucket };
}

// Objects no .dvc references would fall back to public; keep them in OLD unless the
// operator opts in. Unreferenced md5s predict public, so scoped non-public runs never count them.
function routedFilter(
  split: ResolvedSplit,
  scope: ProviderScope | null,
  allowUnreferenced: boolean,
): { keepMd5: (md5: string) => boolean; unreferenced: Set<string> } {
  const unreferenced = new Set<string>();
  const keepMd5 = (md5: string): boolean => {
    if (scope !== null && !scope.keepMd5(md5)) return false;
    if (allowUnreferenced || split.providerByMd5.has(md5)) return true;
    unreferenced.add(md5);
    return false;
  };
  return { keepMd5, unreferenced };
}

function warnUnreferenced(deps: CliDeps, kind: ReportKind, unreferenced: Set<string>): void {
  if (unreferenced.size === 0) return;
  deps.logger.warn(
    { unreferenced: unreferenced.size },
    `${kind}: skipped ${unreferenced.size} unreferenced md5(s); they stay in OLD (no .dvc in git history references them; see map's unreferenced rows) — pass --allow-unreferenced to route them to public`,
  );
}

type ResolvedSplit = SplitMapping & { missingDirs: string[]; commit?: string };

async function resolveSplitOrAbort(
  deps: CliDeps,
  store: ObjectStore,
  region: Region,
  o: CommonOptions,
  kind: ReportKind,
  ts: string,
  loaded: LoadedConfig,
): Promise<ResolvedSplit | null> {
  const git = deps.gitHistory ?? new GitHistoryCli();
  const { config } = loaded;

  if (o.commit !== undefined && o.allowUnreferenced) {
    const reason =
      "--commit cannot be combined with --allow-unreferenced: on a one-commit walk every object named only by other commits is unreferenced and would be routed to public";
    const summary = { old: o.old, requestedCommit: o.commit, ...configSummary(loaded) };
    return abortRun(deps, o.reportDir, kind, ts, summary, reason);
  }

  let entries: GitDvcEntry[];
  let commit: string | undefined;
  try {
    commit = await resolveWalkCommit(deps, git, o.gitRepo, o.commit, kind);
    entries = await git.walk(o.gitRepo, o.subdir, commit);
  } catch (err) {
    const summary = {
      old: o.old,
      gitRepo: o.gitRepo,
      ...failedCommitSummary(o.commit, commit),
      ...configSummary(loaded),
    };
    return abortRun(deps, o.reportDir, kind, ts, summary, (err as Error).message);
  }

  const dirMd5s = entries.map((e) => e.md5).filter((m) => m.endsWith(".dir"));
  const { members, missingDirs, dirReadErrors } = await expandDirMembers(
    store,
    o.old,
    dirMd5s,
    config.ignoredMd5s,
  );
  const split = buildSplitMapping({ config, gitEntries: entries, dirMembers: members, region });

  const abortSummary = { old: o.old, ...commitSummary(commit), ...configSummary(loaded) };
  const abort = (reason: string, rows: ReportRow[]): Promise<null> =>
    abortRun(deps, o.reportDir, kind, ts, abortSummary, reason, rows);

  if (split.conflicts.length > 0) {
    return abort(
      `${split.conflicts.length} provider conflict(s) — an md5 maps to >1 provider (ambiguous routing)`,
      split.conflicts.map((c) => ({
        key: "",
        md5: c.md5,
        action: "map",
        status: `conflict:${c.providers.join("|")}`,
      })),
    );
  }

  if (split.unknownDirs.length > 0 && o.allowUnknownDirs !== true) {
    return abort(
      `${split.unknownDirs.length} git folder(s) absent from the provider map — would route to public by fallback; pass --allow-unknown-dirs to permit`,
      split.unknownDirs.map((d) => ({
        key: "",
        md5: "",
        action: "map",
        status: `unknown-dir:${d}`,
      })),
    );
  }

  if (dirReadErrors.length > 0) {
    return abort(
      `${dirReadErrors.length} unreadable .dir object(s) — members cannot be routed (would fall to public)`,
      dirReadErrors.map((e) => ({
        key: "",
        md5: e.dirMd5,
        action: "map",
        status: `dir-read-error:${e.error}`,
      })),
    );
  }

  if (split.unknownDirs.length > 0) {
    deps.logger.warn(
      { unknownDirs: split.unknownDirs.length, dirs: split.unknownDirs },
      `${kind}: routing ${split.unknownDirs.length} unknown folder(s) to public (--allow-unknown-dirs)`,
    );
  }
  if (missingDirs.length > 0) {
    deps.logger.warn(
      { missingDirs },
      `${kind}: ${missingDirs.length} .dir object(s) referenced in git are absent from OLD (never pushed); their members cannot be routed and count as unreferenced`,
    );
  }
  return { ...split, missingDirs, ...commitSummary(commit) };
}

interface MigrateOptions extends CommonOptions {
  concurrency?: number;
}

export function makeMigrateCommand(deps: CliDeps): Command {
  return withCommonOptions(
    new Command("dvc-migrate")
      .description(
        "Migrate a monolithic DVC remote into per-provider buckets (verbatim server-side copy, memory-sharded), then deep-verify. Does NOT delete and does NOT touch .dvc files (use repoint to point the .dvc files at the new buckets).",
      )
      .option("--concurrency <n>", "copy concurrency", parseInt10),
    deps,
  ).action(async (o: MigrateOptions) => {
    const region = parseRegion(o.region);
    const store = deps.makeStore(region);
    const ts = deps.now();

    const loaded = await loadConfigOrAbort(deps, o.config, o.reportDir, "migrate", ts);
    if (loaded === null) return;

    const split = await resolveSplitOrAbort(deps, store, region, o, "migrate", ts, loaded);
    if (split === null) return;

    let scope: ProviderScope | null = null;
    if (o.provider !== undefined) {
      scope = await providerScopeOrAbort(deps, split, region, o, "migrate", ts, loaded);
      if (scope === null) return;
    }
    const { keepMd5, unreferenced } = routedFilter(split, scope, o.allowUnreferenced);

    const rep = await migrateSharded({
      store,
      oldBucket: o.old,

      newBucket: scope?.targetBucket ?? split.destBuckets[0] ?? o.old,
      resolve: split.resolve,
      deep: true,
      keepMd5,
      ...(isPositiveInt(o.concurrency) ? { concurrency: o.concurrency } : {}),
      ...(o.shardLength !== undefined ? { shardLength: o.shardLength } : {}),
    });

    const env: ReportEnvelope = {
      kind: "migrate",
      createdAt: ts,
      summary: {
        old: o.old,
        ...configSummary(loaded),
        ...commitSummary(split.commit),
        ...(scope !== null ? { provider: o.provider } : {}),
        buckets: scope !== null ? 1 : split.destBuckets.length,
        shards: rep.shards,
        total: rep.transfer.total,
        copied: rep.transfer.copied,
        skipped: rep.transfer.skipped,
        errors: rep.transfer.errors.length,
        verifyOk: rep.verify.ok,
        missing: rep.verify.missing.length,
        unreferencedSkipped: unreferenced.size,
        missingDirs: split.missingDirs.length,
      },

      rows: rep.transfer.errors.map((e) => ({
        key: e.item.sourceKey,
        md5: e.item.md5,
        action: "copy",
        destBucket: e.item.destBucket,
        status: `error:${e.error}`,
      })),
    };
    const written = await writeRunReport(o.reportDir, `migrate-${ts}`, env);
    deps.logger.info({ ...env.summary, report: written.jsonPath }, "migrate complete");
    warnUnreferenced(deps, "migrate", unreferenced);
    if (!rep.verify.ok || rep.transfer.errors.length > 0) process.exitCode = 1;
  });
}

export function makeVerifyCommand(deps: CliDeps): Command {
  return withCommonOptions(
    new Command("dvc-verify").description(
      "Verify every OLD object is present + byte-identical in the per-provider bucket union (the delete gate). Memory-sharded.",
    ),
    deps,
  ).action(async (o: CommonOptions) => {
    const region = parseRegion(o.region);
    const store = deps.makeStore(region);
    const ts = deps.now();

    const loaded = await loadConfigOrAbort(deps, o.config, o.reportDir, "verify", ts);
    if (loaded === null) return;

    const split = await resolveSplitOrAbort(deps, store, region, o, "verify", ts, loaded);
    if (split === null) return;

    let scope: ProviderScope | null = null;
    if (o.provider !== undefined) {
      scope = await providerScopeOrAbort(deps, split, region, o, "verify", ts, loaded);
      if (scope === null) return;
    }
    const { keepMd5, unreferenced } = routedFilter(split, scope, o.allowUnreferenced);

    const newBuckets = scope !== null ? [scope.targetBucket] : split.destBuckets;
    const vr = await verifySharded(store, o.old, store, newBuckets[0] ?? o.old, {
      deep: true,
      ...(o.shardLength !== undefined ? { shardLength: o.shardLength } : {}),
      newBuckets,
      expectBucketByMd5: split.predictBucket,
      keepMd5,
    });
    const env: ReportEnvelope = {
      kind: "verify",
      createdAt: ts,
      summary: {
        old: o.old,
        ...configSummary(loaded),
        ...commitSummary(split.commit),
        ...(scope !== null ? { provider: o.provider } : {}),
        buckets: newBuckets.length,
        shards: vr.shards,
        ok: vr.ok,
        matched: vr.matchedCount,

        missing: vr.missing.length,
        missingTruncated: vr.missingTruncated,
        shardsWithGaps: vr.shardsWithGaps.length,
        deepEtagSkipped: vr.deepEtagSkipped,
        unreferencedSkipped: unreferenced.size,
        missingDirs: split.missingDirs.length,
      },
      rows: vr.missing.map((m) => ({
        key: m.key,
        md5: m.md5,
        action: "verify",
        status: `missing:${m.reason}`,
      })),
    };
    const written = await writeRunReport(o.reportDir, `verify-${ts}`, env);
    deps.logger.info({ ...env.summary, report: written.jsonPath }, "verify complete");
    warnUnreferenced(deps, "verify", unreferenced);
    if (!vr.ok) process.exitCode = 1;
  });
}

interface DeleteOptions {
  old: string;
  config: string;
  region: string;
  provider?: string;
  gitRepo?: string;
  commit?: string;
  subdir: string;
  allowUnknownDirs: boolean;
  shardLength?: number;
  reportDir: string;
  dryRun: boolean;
  allowProduction: boolean;
  allowSizeOnly: boolean;
}

function withDeleteOptions(cmd: Command, deps: CliDeps): Command {
  return cmd
    .requiredOption("--old <bucket>", "source (OLD) bucket to drain proven-migrated objects from")
    .requiredOption("--config <path>", configOptionHelp)
    .option("--region <region>", "AWS region (us-east-1|us-east-2)", "us-east-2")
    .option(
      "--provider <stub>",
      "drain ONLY this provider's bucket from OLD (incremental, one provider at a time); omit to drain every provider's bucket",
    )
    .option(
      "--git-repo <dir>",
      "code repo whose git history is the md5 -> provider routing; an object proven only in the WRONG bucket is refused as misrouted (REQUIRED with --no-dry-run)",
    )
    .option("--commit <commit>", `${commitOptionHelp} (requires --git-repo)`)
    .option("--subdir <path>", "subtree containing .dvc files", "data/dvc")
    .option(
      "--allow-unknown-dirs",
      "route git folders absent from the provider map to public instead of aborting (fail-closed by default)",
      false,
    )
    .option(
      "--shard-length <n>",
      "md5 prefix length for memory sharding (2..4; default 2 = 256 shards)",
      parseInt10,
    )
    .option("--dry-run", "preview only (default)", true)
    .option("--no-dry-run", "ACTUALLY delete (disables the dry-run default)")
    .option("--allow-production", "permit a production-named OLD bucket target", false)
    .option(
      "--allow-size-only",
      "also delete objects proven by size+key only (multipart ETags cannot be byte-compared); refused by default",
      false,
    )
    .option("--report-dir <dir>", "directory for run reports", deps.reportDir);
}

export function makeDeleteCommand(deps: CliDeps): Command {
  return withDeleteOptions(
    new Command("dvc-delete").description(
      "Delete from OLD every object proven byte-identical across the per-provider bucket union — compares object stores (new files vs old files). Dry-run by DEFAULT; --no-dry-run actually deletes and requires --git-repo so misrouted objects are refused. Memory-sharded.",
    ),
    deps,
  ).action(async (o: DeleteOptions) => {
    const region = parseRegion(o.region);
    const store = deps.makeStore(region);
    const ts = deps.now();

    const loaded = await loadConfigOrAbort(deps, o.config, o.reportDir, "delete", ts);
    if (loaded === null) return;
    const base = { old: o.old, ...configSummary(loaded) };

    if (o.provider !== undefined && !loaded.config.isProvider(o.provider)) {
      await abortRun(deps, o.reportDir, "delete", ts, base, unknownProvider(o.provider, loaded));
      return;
    }
    if (!o.dryRun && o.gitRepo === undefined) {
      const reason =
        "--no-dry-run requires --git-repo: the misroute gate must run before anything is deleted";
      await abortRun(deps, o.reportDir, "delete", ts, { ...base, dryRun: false }, reason);
      return;
    }
    if (o.commit !== undefined && o.gitRepo === undefined) {
      const reason = "--commit requires --git-repo: it names a commit in that repo";
      await abortRun(deps, o.reportDir, "delete", ts, base, reason);
      return;
    }

    let providerBuckets: string[];
    let provider: string | undefined;
    if (o.provider !== undefined) {
      provider = o.provider;
      providerBuckets = [bucketName(o.provider, region)];
    } else {
      providerBuckets = [...loaded.config.providers.filter((s) => s !== "public"), "public"].map(
        (s) => bucketName(s, region),
      );
    }

    let split: ResolvedSplit | null = null;
    if (o.gitRepo !== undefined) {
      split = await resolveSplitOrAbort(
        deps,
        store,
        region,
        { ...o, gitRepo: o.gitRepo, allowUnreferenced: false },
        "delete",
        ts,
        loaded,
      );
      if (split === null) return;
    } else {
      deps.logger.warn(
        { old: o.old },
        "delete (dry-run): no --git-repo — misroute assertion DISABLED; objects are proven by presence in any targeted bucket",
      );
    }

    try {
      const del = await deleteOldAgainstBuckets(store, o.old, providerBuckets, {
        deep: true,
        ...(o.shardLength !== undefined ? { shardLength: o.shardLength } : {}),
        ...(split !== null ? { expectBucketByMd5: split.predictBucket } : {}),
        dryRun: o.dryRun,
        allowProduction: o.allowProduction,
        allowSizeOnly: o.allowSizeOnly,
      });
      const env: ReportEnvelope = {
        kind: "delete",
        createdAt: ts,
        summary: {
          ...base,
          ...commitSummary(split?.commit),
          ...(provider !== undefined ? { provider } : {}),
          buckets: providerBuckets.length,
          shards: del.shards,
          dryRun: del.dryRun,
          targetCount: del.targetCount,
          deleted: del.deleted,
          corrupt: del.corrupt.length,

          deepEtagSkipped: del.deepEtagSkipped,
        },

        ...(del.corrupt.length > 0
          ? {
              rows: del.corrupt.map((m) => ({
                key: m.key,
                md5: m.md5,
                action: "delete",
                status: `corrupt:${m.reason}`,
              })),
            }
          : {}),
      };
      const written = await writeRunReport(o.reportDir, `delete-${ts}`, env);
      deps.logger.info({ ...env.summary, report: written.jsonPath }, "delete complete");
      if (del.deepEtagSkipped > 0) {
        deps.logger.warn(
          { deepEtagSkipped: del.deepEtagSkipped, report: written.jsonPath },
          o.allowSizeOnly
            ? "delete: some objects verified by size+key only (multipart ETag) — not byte-proven"
            : "delete: refused objects provable by size+key only (multipart ETag) — pass --allow-size-only to delete them",
        );
      }
      if (del.corrupt.length > 0) {
        deps.logger.warn(
          { ...env.summary, report: written.jsonPath },
          "delete refused corrupt/misrouted/size-only object(s): left in OLD",
        );
        process.exitCode = 1;
      }
    } catch (err) {
      const summary = { ...base, dryRun: o.dryRun };
      await abortRun(deps, o.reportDir, "delete", ts, summary, (err as Error).message);
    }
  });
}

interface MapOptions {
  gitRepo: string;
  config: string;
  old: string;
  subdir: string;
  region: string;
  reportDir: string;
  allowUnknownDirs: boolean;
  commit?: string;
}

export function makeMapCommand(deps: CliDeps): Command {
  return new Command("dvc-map")
    .description("Build the md5 -> provider -> bucket mapping from git history + the OLD store.")
    .requiredOption("--git-repo <dir>", "path to the code repo whose git history is walked")
    .requiredOption("--old <bucket>", "OLD object store bucket to list")
    .requiredOption("--config <path>", configOptionHelp)
    .option("--subdir <path>", "subtree containing .dvc files", "data/dvc")
    .option("--region <region>", "AWS region (us-east-1|us-east-2)", "us-east-2")
    .option("--commit <commit>", commitOptionHelp)
    .option(
      "--allow-unknown-dirs",
      "do not exit non-zero when a git folder is absent from the provider map (routes to public)",
      false,
    )
    .option("--report-dir <dir>", "directory for run reports", deps.reportDir)
    .action(async (o: MapOptions) => {
      const region = parseRegion(o.region);
      const store = deps.makeStore(region);
      const git = deps.gitHistory ?? new GitHistoryCli();
      const ts = deps.now();

      const loaded = await loadConfigOrAbort(deps, o.config, o.reportDir, "map", ts);
      if (loaded === null) return;
      const { config } = loaded;

      let result: ReturnType<typeof buildMapping>;
      let commit: string | undefined;
      try {
        commit = await resolveWalkCommit(deps, git, o.gitRepo, o.commit, "map");
        const entries = await git.walk(o.gitRepo, o.subdir, commit);
        const storeKeys = (await store.list(o.old)).map((x) => x.key);
        const dirMd5s = entries.map((e) => e.md5).filter((m) => m.endsWith(".dir"));
        const { members: dirMembers, dirReadErrors } = await expandDirMembers(
          store,
          o.old,
          dirMd5s,
          config.ignoredMd5s,
        );
        result = buildMapping({
          config,
          gitEntries: entries,
          storeKeys,
          region,
          dirMembers,
          dirReadErrors,
        });
      } catch (err) {
        const summary = {
          old: o.old,
          gitRepo: o.gitRepo,
          ...failedCommitSummary(o.commit, commit),
          ...configSummary(loaded),
        };
        await abortRun(deps, o.reportDir, "map", ts, summary, (err as Error).message);
        return;
      }

      const env: ReportEnvelope = {
        kind: "map",
        createdAt: ts,
        summary: {
          ...configSummary(loaded),
          ...commitSummary(commit),
          buckets: result.providerCounts,
          orphans: result.orphanMd5s.length,
          conflicts: result.conflicts.length,
          unreferenced: result.unreferencedKeys.length,
          unknownDirs: result.unknownDirs.length,
          dirReadErrors: result.dirReadErrors.length,
        },
        rows: [
          ...result.mapped.map((m) => ({
            key: m.sourceKey,
            md5: m.md5,
            action: "map",
            destBucket: m.destBucket,
            status: result.unreferencedKeys.includes(m.sourceKey) ? "unreferenced" : "mapped",
          })),
          ...result.unknownDirs.map((d) => ({
            key: "",
            md5: "",
            action: "map",
            status: `unknown-dir:${d}`,
          })),

          ...result.orphanMd5s.map((md5) => ({ key: "", md5, action: "map", status: "orphan" })),
          ...result.conflicts.map((c) => ({
            key: "",
            md5: c.md5,
            action: "map",
            status: `conflict:${c.providers.join("|")}`,
          })),
          ...result.dirReadErrors.map((e) => ({
            key: "",
            md5: e.dirMd5,
            action: "map",
            status: `dir-read-error:${e.error}`,
          })),
        ],
      };
      const written = await writeRunReport(o.reportDir, `map-${ts}`, env);
      deps.logger.info({ ...env.summary, report: written.jsonPath }, "map complete");

      try {
        assertMappingValid(result);
      } catch (err) {
        deps.logger.error(
          { err: (err as MappingValidationError).message },
          "mapping validation failed",
        );
        process.exitCode = 1;
      }

      if (result.unknownDirs.length > 0 && o.allowUnknownDirs !== true) {
        deps.logger.error(
          { unknownDirs: result.unknownDirs.length, dirs: result.unknownDirs },
          "map: git folder(s) absent from the provider map would route to public — pass --allow-unknown-dirs to permit",
        );
        process.exitCode = 1;
      }
    });
}

interface RepointCliOptions {
  gitRepo: string;
  config: string;
  subdir: string;
  provider?: string;
  allowUnknownDirs: boolean;
  reportDir: string;
  dryRun: boolean;
}

export function makeRepointCommand(deps: CliDeps): Command {
  return new Command("dvc-repoint")
    .description(
      "Point each .dvc out at its provider's DVC remote (sets `remote: <provider>`; the hash format is left alone so v2 outs keep reading the legacy key layout). Writes the files unless --dry-run. The named remotes must exist in .dvc/config.",
    )
    .requiredOption("--git-repo <dir>", "code repo whose .dvc files are repointed in place")
    .requiredOption("--config <path>", configOptionHelp)
    .option("--subdir <path>", "subtree containing .dvc files", "data/dvc")
    .option(
      "--provider <stub>",
      "repoint ONLY the .dvc files under this provider's folder(s); omit to repoint the whole subtree",
    )
    .option(
      "--allow-unknown-dirs",
      "point folders absent from the provider map at public instead of failing (matches migrate --allow-unknown-dirs)",
      false,
    )
    .option("--dry-run", "preview the repoint WITHOUT writing any .dvc", false)
    .option("--report-dir <dir>", "directory for run reports", deps.reportDir)
    .action(async (o: RepointCliOptions) => {
      const ts = deps.now();
      const loaded = await loadConfigOrAbort(deps, o.config, o.reportDir, "repoint", ts);
      if (loaded === null) return;
      const base = { gitRepo: o.gitRepo, ...configSummary(loaded) };
      if (deps.repoint === undefined) {
        await abortRun(deps, o.reportDir, "repoint", ts, base, "no repoint deps wired");
        return;
      }
      if (o.provider !== undefined && !loaded.config.isProvider(o.provider)) {
        const reason = unknownProvider(o.provider, loaded);
        await abortRun(deps, o.reportDir, "repoint", ts, base, reason);
        return;
      }

      let entries: Awaited<ReturnType<typeof repointAll>>;
      try {
        entries = await repointAll(deps.repoint, o.gitRepo, o.subdir, loaded.config, {
          dryRun: o.dryRun,
          allowUnknownDirs: o.allowUnknownDirs,
          ...(o.provider !== undefined ? { provider: o.provider } : {}),
        });
      } catch (err) {
        await abortRun(deps, o.reportDir, "repoint", ts, base, (err as Error).message);
        return;
      }

      const count = (status: string): number => entries.filter((e) => e.status === status).length;
      const errors = count("error");
      const env: ReportEnvelope = {
        kind: "repoint",
        createdAt: ts,
        summary: {
          ...base,
          ...(o.provider !== undefined ? { provider: o.provider } : {}),
          dryRun: o.dryRun,
          repointed: count("repointed"),
          already: count("already"),
          errors,
        },
        rows: entries
          .filter((e) => e.status !== "already")
          .map((e) => ({
            key: e.path,
            md5: "",
            action: "repoint",
            status: e.status === "error" ? `error:${e.error}` : `repointed:${e.remote}`,
          })),
      };
      const written = await writeRunReport(o.reportDir, `repoint-${ts}`, env);
      deps.logger.info({ ...env.summary, report: written.jsonPath }, "repoint complete");
      if (errors > 0) process.exitCode = 1;
    });
}
