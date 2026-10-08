import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CliDeps,
  makeDeleteCommand,
  makeMapCommand,
  makeMigrateCommand,
  makeRepointCommand,
  makeVerifyCommand,
} from "../../../src/cli/commands.js";
import { bucketName } from "../../../src/config/sources.js";
import { md5ToKey } from "../../../src/domain/dvcKey.js";
import type { GitDvcEntry, GitHistory } from "../../../src/ports/gitHistory.js";
import type { RepointDeps } from "../../../src/services/repoint.js";
import { FakeObjectStore } from "../../support/fakeObjectStore.js";

const A = "aa11111111111111111111111111111a";
const B = "bb22222222222222222222222222222b";
const C = "cc33333333333333333333333333333c";

const AFFINITY = bucketName("affinity", "us-east-2");
const COINOUT = bucketName("coinout", "us-east-2");
const PUBLIC = bucketName("public", "us-east-2");
const ZEARN = bucketName("zearn", "us-east-2");

const tmps: string[] = [];

function makeDeps(store: FakeObjectStore, reportDir: string, git?: GitHistory): CliDeps {
  return {
    makeStore: () => store,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    reportDir,
    now: () => "T",
    ...(git !== undefined ? { gitHistory: git } : {}),
  };
}

function fakeGit(entries: GitDvcEntry[]): GitHistory {
  return { walk: () => Promise.resolve(entries) };
}
function entry(md5: string, rootDir: string): GitDvcEntry {
  return { md5, rootDir, path: `data/dvc/${rootDir}/f.dvc`, commit: "deadbeef" };
}

const PROVIDERS = [entry(A, "Affinity"), entry(B, "CoinOut")];

async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "cli-"));
  tmps.push(d);
  return d;
}
async function reportFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith(".run-report.json"));
}
async function readReport(dir: string): Promise<{
  summary: Record<string, unknown>;
  rows?: { key: string; md5: string; action: string; destBucket?: string; status: string }[];
}> {
  const files = await reportFiles(dir);
  return JSON.parse(await readFile(join(dir, files[0]!), "utf8"));
}

async function seedMigrated(store: FakeObjectStore, old = "old-remote"): Promise<void> {
  await store.ensureBucket(old);
  await store.put(old, md5ToKey(A, "v2"), "alpha");
  await store.put(old, md5ToKey(B, "v2"), "beta");
  await store.put(old, md5ToKey(C, "v2"), "gamma");
  for (const [bk, md5, val] of [
    [AFFINITY, A, "alpha"],
    [COINOUT, B, "beta"],
    [PUBLIC, C, "gamma"],
  ] as const) {
    await store.ensureBucket(bk);
    await store.put(bk, md5ToKey(md5, "v2"), val);
  }
}

beforeEach(() => {
  process.exitCode = 0;
});
afterEach(async () => {
  process.exitCode = 0;
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("dvc-migrate (provider-split, memory-sharded, deep — the only path)", () => {
  it("scatters the monolith into per-provider buckets, leaving unreferenced objects in OLD", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(A, "v2"), "alpha");
    await store.put("old-remote", md5ToKey(B, "v2"), "beta");
    await store.put("old-remote", md5ToKey(C, "v2"), "gamma");
    const dir = await tmpDir();

    await makeMigrateCommand(makeDeps(store, dir, fakeGit(PROVIDERS))).parseAsync([
      "node",
      "dvc-migrate",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
    ]);

    expect((await store.list(AFFINITY)).map((o) => o.key)).toEqual([md5ToKey(A, "v2")]);
    expect((await store.list(COINOUT)).map((o) => o.key)).toEqual([md5ToKey(B, "v2")]);
    let inPublic = 0;
    try {
      inPublic = (await store.list(PUBLIC)).length;
    } catch {}
    expect(inPublic).toBe(0);
    const { summary } = await readReport(dir);
    expect(summary.copied).toBe(2);
    expect(summary.unreferencedSkipped).toBe(1);
    expect(summary.verifyOk).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("--allow-unreferenced routes objects no .dvc references to public", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(A, "v2"), "alpha");
    await store.put("old-remote", md5ToKey(C, "v2"), "gamma");
    const dir = await tmpDir();

    await makeMigrateCommand(makeDeps(store, dir, fakeGit(PROVIDERS))).parseAsync([
      "node",
      "dvc-migrate",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
      "--allow-unreferenced",
    ]);

    expect((await store.list(PUBLIC)).map((o) => o.key)).toEqual([md5ToKey(C, "v2")]);
    const { summary } = await readReport(dir);
    expect(summary.copied).toBe(2);
    expect(summary.unreferencedSkipped).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  it("does not abort on a .dir absent from OLD; its unrouted members stay in OLD", async () => {
    const DIR = "dd55555555555555555555555555555d.dir";
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(A, "v2"), "alpha");
    await store.put("old-remote", md5ToKey(C, "v2"), "member-of-missing-dir");
    const dir = await tmpDir();

    await makeMigrateCommand(
      makeDeps(store, dir, fakeGit([entry(A, "Affinity"), entry(DIR, "CoinOut")])),
    ).parseAsync(["node", "dvc-migrate", "--old", "old-remote", "--git-repo", "/repo"]);

    expect(process.exitCode).toBe(0);
    expect((await store.list(AFFINITY)).map((o) => o.key)).toEqual([md5ToKey(A, "v2")]);
    const { summary } = await readReport(dir);
    expect(summary.missingDirs).toBe(1);
    expect(summary.unreferencedSkipped).toBe(1);
  });

  it("aborts (exit 1) on a provider conflict, copying nothing", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(A, "v2"), "alpha");
    const dir = await tmpDir();

    await makeMigrateCommand(
      makeDeps(store, dir, fakeGit([entry(A, "Affinity"), entry(A, "Zearn")])),
    ).parseAsync(["node", "dvc-migrate", "--old", "old-remote", "--git-repo", "/repo"]);

    expect(process.exitCode).toBe(1);
    let copied = 0;
    for (const b of [AFFINITY, ZEARN]) {
      try {
        copied += (await store.list(b)).length;
      } catch {}
    }
    expect(copied).toBe(0);
    expect((await readReport(dir)).summary.aborted).toBe(true);
  });

  it("emits failed-copy keys as error rows in the report (exit 1)", async () => {
    const base = new FakeObjectStore();
    await base.ensureBucket("old-remote");
    await base.put("old-remote", md5ToKey(A, "v2"), "alpha");
    await base.put("old-remote", md5ToKey(B, "v2"), "beta");
    const failKey = md5ToKey(A, "v2");
    const store: FakeObjectStore = Object.create(base);
    store.copy = (spec) =>
      spec.sourceKey === failKey ? Promise.reject(new Error("boom")) : base.copy(spec);
    const dir = await tmpDir();

    await makeMigrateCommand(makeDeps(store, dir, fakeGit(PROVIDERS))).parseAsync([
      "node",
      "dvc-migrate",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
    ]);

    const { rows } = await readReport(dir);
    const errorRow = rows?.find((r) => r.key === failKey);
    expect(errorRow?.status).toMatch(/^error/);
    expect(process.exitCode).toBe(1);
  });

  it("ignores a non-positive --concurrency instead of crashing on pLimit(0)", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(A, "v2"), "alpha");
    const dir = await tmpDir();

    await makeMigrateCommand(makeDeps(store, dir, fakeGit(PROVIDERS))).parseAsync([
      "node",
      "dvc-migrate",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
      "--concurrency",
      "0",
    ]);

    expect((await store.list(AFFINITY)).length).toBe(1);
    expect(process.exitCode).toBe(0);
  });

  it("writes an abort report (exit 1) when git history cannot be read", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    const git: GitHistory = { walk: () => Promise.reject(new Error("not a git repository")) };
    const dir = await tmpDir();

    await makeMigrateCommand(makeDeps(store, dir, git)).parseAsync([
      "node",
      "dvc-migrate",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
    ]);

    expect(process.exitCode).toBe(1);
    const { summary } = await readReport(dir);
    expect(summary.aborted).toBe(true);
    expect(summary.reason).toMatch(/not a git repository/);
  });
});

describe("dvc-verify (provider-split union gate)", () => {
  it("verifies OLD against the union of the provider buckets (ok=true)", async () => {
    const store = new FakeObjectStore();
    await seedMigrated(store);
    const dir = await tmpDir();

    await makeVerifyCommand(makeDeps(store, dir, fakeGit(PROVIDERS))).parseAsync([
      "node",
      "dvc-verify",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
    ]);

    expect(process.exitCode).toBe(0);
    const { summary } = await readReport(dir);
    expect(summary.ok).toBe(true);
    expect(summary.matched).toBe(2);
    expect(summary.unreferencedSkipped).toBe(1);
  });

  it("fails (exit 1) when an object is missing from every provider bucket", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(A, "v2"), "alpha");
    await store.put("old-remote", md5ToKey(B, "v2"), "beta");
    await store.ensureBucket(AFFINITY);
    await store.put(AFFINITY, md5ToKey(A, "v2"), "alpha");
    const dir = await tmpDir();

    await makeVerifyCommand(makeDeps(store, dir, fakeGit(PROVIDERS))).parseAsync([
      "node",
      "dvc-verify",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
    ]);

    expect(process.exitCode).toBe(1);
    expect((await readReport(dir)).summary.ok).toBe(false);
  });
});

describe("dvc-delete safety (provider-split)", () => {
  it("is dry-run by DEFAULT: deletes nothing", async () => {
    const store = new FakeObjectStore();
    await seedMigrated(store);
    const dir = await tmpDir();

    await makeDeleteCommand(makeDeps(store, dir)).parseAsync([
      "node",
      "dvc-delete",
      "--old",
      "old-remote",
    ]);

    expect((await store.list("old-remote")).length).toBe(3);
    expect((await readReport(dir)).summary.dryRun).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("with --no-dry-run deletes from OLD and keeps the provider buckets", async () => {
    const store = new FakeObjectStore();
    await seedMigrated(store);
    const dir = await tmpDir();

    await makeDeleteCommand(makeDeps(store, dir, fakeGit(PROVIDERS))).parseAsync([
      "node",
      "dvc-delete",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
      "--no-dry-run",
    ]);

    expect((await store.list("old-remote")).length).toBe(0);
    expect((await store.list(AFFINITY)).length).toBe(1);
    expect((await store.list(COINOUT)).length).toBe(1);
    expect((await store.list(PUBLIC)).length).toBe(1);
    expect(process.exitCode).toBe(0);
  });

  it("leaves un-migrated OLD objects in place (no abort) and drains only the proven ones", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(A, "v2"), "alpha");
    await store.put("old-remote", md5ToKey(B, "v2"), "beta");
    await store.ensureBucket(AFFINITY);
    await store.put(AFFINITY, md5ToKey(A, "v2"), "alpha");
    const dir = await tmpDir();

    await makeDeleteCommand(makeDeps(store, dir, fakeGit(PROVIDERS))).parseAsync([
      "node",
      "dvc-delete",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
      "--no-dry-run",
    ]);

    expect(process.exitCode).toBe(0);
    expect((await store.list("old-remote")).map((o) => o.key)).toEqual([md5ToKey(B, "v2")]);
    expect((await readReport(dir)).summary.deleted).toBe(1);
  });

  it("deep verification refuses to delete when a provider copy is corrupt at the same size", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(A, "v2"), "GOOD");
    await store.ensureBucket(AFFINITY);
    await store.put(AFFINITY, md5ToKey(A, "v2"), "BAD!");
    const dir = await tmpDir();

    await makeDeleteCommand(makeDeps(store, dir, fakeGit(PROVIDERS))).parseAsync([
      "node",
      "dvc-delete",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
      "--no-dry-run",
    ]);

    expect(process.exitCode).toBe(1);
    expect((await store.list("old-remote")).length).toBe(1);
  });

  it("dry-run surfaces corruption: exit 1 so the pre-flight gate fails loudly", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(A, "v2"), "GOOD");
    await store.ensureBucket(AFFINITY);
    await store.put(AFFINITY, md5ToKey(A, "v2"), "BAD!");
    const dir = await tmpDir();

    await makeDeleteCommand(makeDeps(store, dir)).parseAsync([
      "node",
      "dvc-delete",
      "--old",
      "old-remote",
    ]);

    expect(process.exitCode).toBe(1);
    expect((await store.list("old-remote")).length).toBe(1);
    const { summary } = await readReport(dir);
    expect(summary.dryRun).toBe(true);
    expect(summary.corrupt).toBe(1);
  });

  it("--git-repo restores the misroute gate: a private object present only in public is refused", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(A, "v2"), "alpha"); // routed to Affinity per git
    await store.ensureBucket(AFFINITY);
    await store.ensureBucket(PUBLIC);
    await store.put(PUBLIC, md5ToKey(A, "v2"), "alpha"); // misrouted: only copy is in public
    const dir = await tmpDir();

    await makeDeleteCommand(makeDeps(store, dir, fakeGit(PROVIDERS))).parseAsync([
      "node",
      "dvc-delete",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
      "--no-dry-run",
    ]);

    expect(process.exitCode).toBe(1);
    expect((await store.list("old-remote")).length).toBe(1); // left in OLD
    const { rows } = await readReport(dir);
    expect(rows?.map((r) => r.status)).toEqual(["corrupt:misrouted"]);
  });

  it("refuses a production-named OLD bucket (exit 1, nothing deleted)", async () => {
    const OLD = "oi-economictracker-dvc";
    const store = new FakeObjectStore();
    await store.ensureBucket(OLD);
    await store.put(OLD, md5ToKey(A, "v2"), "alpha");
    await store.ensureBucket(AFFINITY);
    await store.put(AFFINITY, md5ToKey(A, "v2"), "alpha");
    const dir = await tmpDir();

    await makeDeleteCommand(makeDeps(store, dir, fakeGit(PROVIDERS))).parseAsync([
      "node",
      "dvc-delete",
      "--old",
      OLD,
      "--git-repo",
      "/repo",
      "--no-dry-run",
    ]);

    expect(process.exitCode).toBe(1);
    expect((await store.list(OLD)).length).toBe(1);
    expect((await readReport(dir)).summary.aborted).toBe(true);
  });

  it("REFUSES --no-dry-run without --git-repo (misroute gate is mandatory for real deletes)", async () => {
    const store = new FakeObjectStore();
    await seedMigrated(store);
    const dir = await tmpDir();

    await makeDeleteCommand(makeDeps(store, dir)).parseAsync([
      "node",
      "dvc-delete",
      "--old",
      "old-remote",
      "--no-dry-run",
    ]);

    expect(process.exitCode).toBe(1);
    expect((await store.list("old-remote")).length).toBe(3);
    const { summary } = await readReport(dir);
    expect(summary.aborted).toBe(true);
    expect(summary.reason).toMatch(/--git-repo/);
  });

  it("--help documents the dry-run safety flags and the misroute gate", () => {
    const help = makeDeleteCommand(makeDeps(new FakeObjectStore(), ".")).helpInformation();
    expect(help).toContain("--no-dry-run");
    expect(help).toContain("--allow-production");
    expect(help).toContain("--provider");
    expect(help).toContain("--git-repo");
  });
});

describe("incremental --provider scoping (single-provider migrate/verify/delete)", () => {
  it("migrate --provider copies ONLY that provider's slice, leaving OLD and other buckets untouched", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(A, "v2"), "alpha");
    await store.put("old-remote", md5ToKey(B, "v2"), "beta");
    await store.put("old-remote", md5ToKey(C, "v2"), "gamma");
    const dir = await tmpDir();

    await makeMigrateCommand(makeDeps(store, dir, fakeGit(PROVIDERS))).parseAsync([
      "node",
      "dvc-migrate",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
      "--provider",
      "coinout",
    ]);

    expect((await store.list(COINOUT)).map((o) => o.key)).toEqual([md5ToKey(B, "v2")]);

    for (const b of [AFFINITY, PUBLIC]) {
      let n = 0;
      try {
        n = (await store.list(b)).length;
      } catch {}
      expect(n).toBe(0);
    }
    expect((await store.list("old-remote")).length).toBe(3);
    const { summary } = await readReport(dir);
    expect(summary.provider).toBe("coinout");
    expect(summary.copied).toBe(1);
    expect(summary.verifyOk).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("verify --provider passes for the migrated provider even when others are absent from NEW", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(A, "v2"), "alpha");
    await store.put("old-remote", md5ToKey(B, "v2"), "beta");
    await store.ensureBucket(AFFINITY);
    await store.put(AFFINITY, md5ToKey(A, "v2"), "alpha");
    const dir = await tmpDir();

    await makeVerifyCommand(makeDeps(store, dir, fakeGit(PROVIDERS))).parseAsync([
      "node",
      "dvc-verify",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
      "--provider",
      "affinity",
    ]);

    expect(process.exitCode).toBe(0);
    const { summary } = await readReport(dir);
    expect(summary.ok).toBe(true);
    expect(summary.matched).toBe(1);
  });

  it("delete --provider --no-dry-run drains ONLY that provider's objects from OLD", async () => {
    const store = new FakeObjectStore();
    await seedMigrated(store);
    const dir = await tmpDir();

    await makeDeleteCommand(makeDeps(store, dir, fakeGit(PROVIDERS))).parseAsync([
      "node",
      "dvc-delete",
      "--old",
      "old-remote",
      "--provider",
      "coinout",
      "--git-repo",
      "/repo",
      "--no-dry-run",
    ]);

    expect(process.exitCode).toBe(0);

    expect((await store.list("old-remote")).map((o) => o.key).sort()).toEqual(
      [md5ToKey(A, "v2"), md5ToKey(C, "v2")].sort(),
    );
    expect((await store.list(COINOUT)).length).toBe(1);
    const { summary } = await readReport(dir);
    expect(summary.provider).toBe("coinout");
    expect(summary.deleted).toBe(1);
  });

  it("aborts (exit 1) on an unknown provider stub, touching nothing", async () => {
    const store = new FakeObjectStore();
    await seedMigrated(store);
    const dir = await tmpDir();

    await makeDeleteCommand(makeDeps(store, dir)).parseAsync([
      "node",
      "dvc-delete",
      "--old",
      "old-remote",
      "--provider",
      "not-a-provider",
      "--no-dry-run",
    ]);

    expect(process.exitCode).toBe(1);
    expect((await store.list("old-remote")).length).toBe(3);
    const { summary } = await readReport(dir);
    expect(summary.aborted).toBe(true);
    expect(summary.reason).toMatch(/unknown provider/);
  });
});

describe("dvc-map gate-failing items in the report", () => {
  const CONFLICT = "cc33333333333333333333333333333c";
  const ORPHAN = "00444444444444444444444444444440";
  const DIR = "dd55555555555555555555555555555d.dir";

  it("writes orphan / conflict / dir-read-error rows so the operator can act on the gate failure", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(CONFLICT, "v2"), "x");
    await store.put("old-remote", md5ToKey(DIR, "v2"), "[]");
    const git = fakeGit([
      entry(CONFLICT, "Affinity"),
      entry(CONFLICT, "Zearn"),
      entry(ORPHAN, "Affinity"),
      entry(DIR, "CoinOut"),
    ]);
    const dir = await tmpDir();

    await makeMapCommand(makeDeps(store, dir, git)).parseAsync([
      "node",
      "dvc-map",
      "--git-repo",
      "/repo",
      "--old",
      "old-remote",
    ]);

    expect(process.exitCode).toBe(1);
    const { rows } = await readReport(dir);
    expect(rows?.find((r) => r.md5 === ORPHAN && r.status.startsWith("orphan"))).toBeDefined();
    expect(rows?.find((r) => r.md5 === CONFLICT && r.status.startsWith("conflict"))).toBeDefined();
    expect(rows?.find((r) => r.md5 === DIR && r.status.startsWith("dir-read-error"))).toBeDefined();
  });

  it("writes an abort report (and exits 1) when git history cannot be read", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    const git: GitHistory = { walk: () => Promise.reject(new Error("not a git repository")) };
    const dir = await tmpDir();

    await makeMapCommand(makeDeps(store, dir, git)).parseAsync([
      "node",
      "dvc-map",
      "--git-repo",
      "/repo",
      "--old",
      "old-remote",
    ]);

    expect(process.exitCode).toBe(1);
    const { summary } = await readReport(dir);
    expect(summary.aborted).toBe(true);
    expect(summary.reason).toMatch(/not a git repository/);
  });
});

describe("fail-closed routing gate (unknown dirs + corrupt .dir)", () => {
  const DIR = "dd55555555555555555555555555555d.dir";

  it("migrate ABORTS (exit 1, nothing copied) on a git folder absent from the provider map", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(A, "v2"), "alpha");
    const dir = await tmpDir();

    await makeMigrateCommand(
      makeDeps(store, dir, fakeGit([entry(A, "Mystery Source")])),
    ).parseAsync(["node", "dvc-migrate", "--old", "old-remote", "--git-repo", "/repo"]);

    expect(process.exitCode).toBe(1);
    const { summary, rows } = await readReport(dir);
    expect(summary.aborted).toBe(true);
    expect(rows?.some((r) => r.status === "unknown-dir:Mystery Source")).toBe(true);

    let copied = 0;
    try {
      copied = (await store.list(PUBLIC)).length;
    } catch {}
    expect(copied).toBe(0);
  });

  it("migrate with --allow-unknown-dirs consciously routes the unknown folder to public", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(A, "v2"), "alpha");
    const dir = await tmpDir();

    await makeMigrateCommand(
      makeDeps(store, dir, fakeGit([entry(A, "Mystery Source")])),
    ).parseAsync([
      "node",
      "dvc-migrate",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
      "--allow-unknown-dirs",
    ]);

    expect(process.exitCode).toBe(0);
    expect((await store.list(PUBLIC)).map((o) => o.key)).toEqual([md5ToKey(A, "v2")]);
  });

  it("verify ABORTS (exit 1) on an unknown folder, without --allow-unknown-dirs", async () => {
    const store = new FakeObjectStore();
    await seedMigrated(store);
    const dir = await tmpDir();

    await makeVerifyCommand(makeDeps(store, dir, fakeGit([entry(A, "Mystery Source")]))).parseAsync(
      ["node", "dvc-verify", "--old", "old-remote", "--git-repo", "/repo"],
    );

    expect(process.exitCode).toBe(1);
    expect((await readReport(dir)).summary.aborted).toBe(true);
  });

  it("migrate ABORTS (exit 1) on an unreadable .dir object (would route members to public)", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old-remote");
    await store.put("old-remote", md5ToKey(DIR, "v2"), "[]");
    const dir = await tmpDir();

    await makeMigrateCommand(makeDeps(store, dir, fakeGit([entry(DIR, "CoinOut")]))).parseAsync([
      "node",
      "dvc-migrate",
      "--old",
      "old-remote",
      "--git-repo",
      "/repo",
    ]);

    expect(process.exitCode).toBe(1);
    const { summary, rows } = await readReport(dir);
    expect(summary.aborted).toBe(true);
    expect(rows?.some((r) => r.status.startsWith("dir-read-error"))).toBe(true);
  });
});

describe("dvc-repoint (per-out remote: field, repo plane)", () => {
  const P_PUB = "/repo/data/dvc/ACS 2014-2018 5-Year County/a.zip.dvc";
  const P_KRONOS = "/repo/data/dvc/Kronos/k.zip.dvc";
  const P_MYSTERY = "/repo/data/dvc/Mystery Source/m.dvc";
  const v2 = "outs:\n- md5: f7e27dd28eccf234f317305238aa2634\n  size: 703808\n  path: a.zip\n";
  const v1 = `md5: deadbeef\nouts:\n- md5: ${C}\n  path: c.csv\n`;

  function repointDeps(files: Map<string, string>): RepointDeps {
    return {
      listDvcFiles: () => Promise.resolve([...files.keys()]),
      readFile: (p) => Promise.resolve(files.get(p) ?? ""),
      writeFile: (p, c) => {
        files.set(p, c);
        return Promise.resolve();
      },
    };
  }
  const depsWith = (files: Map<string, string>, reportDir: string): CliDeps => ({
    ...makeDeps(new FakeObjectStore(), reportDir),
    repoint: repointDeps(files),
  });
  const run = (files: Map<string, string>, dir: string, ...args: string[]) =>
    makeRepointCommand(depsWith(files, dir)).parseAsync([
      "node",
      "dvc-repoint",
      "--git-repo",
      "/repo",
      ...args,
    ]);

  it("sets remote: <provider> on each .dvc WITHOUT touching the hash format", async () => {
    const files = new Map([
      [P_PUB, v2],
      [P_KRONOS, v2],
    ]);
    const dir = await tmpDir();

    await run(files, dir);

    expect(files.get(P_PUB)).toMatch(/remote: public/);
    expect(files.get(P_KRONOS)).toMatch(/remote: kronos/);
    expect(files.get(P_KRONOS)).not.toMatch(/hash:/);
    const { summary, rows } = await readReport(dir);
    expect(summary.repointed).toBe(2);
    expect(rows?.some((r) => r.key === P_KRONOS && r.status === "repointed:kronos")).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("is idempotent: a second run reports already-repointed and writes nothing new", async () => {
    const files = new Map([[P_KRONOS, v2]]);
    const dir = await tmpDir();
    await run(files, dir);
    const after = files.get(P_KRONOS);
    await rm(dir, { recursive: true, force: true });
    const dir2 = await tmpDir();

    await run(files, dir2);

    expect(files.get(P_KRONOS)).toBe(after);
    expect((await readReport(dir2)).summary.already).toBe(1);
  });

  it("--dry-run reports without writing any .dvc", async () => {
    const files = new Map([[P_KRONOS, v2]]);
    const dir = await tmpDir();

    await run(files, dir, "--dry-run");

    expect(files.get(P_KRONOS)).toBe(v2);
    expect((await readReport(dir)).summary.dryRun).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("--provider scopes the repoint to that provider's folder(s), leaving others untouched", async () => {
    const files = new Map([
      [P_PUB, v2],
      [P_KRONOS, v2],
    ]);
    const dir = await tmpDir();

    await run(files, dir, "--provider", "kronos");

    expect(files.get(P_KRONOS)).toMatch(/remote: kronos/);
    expect(files.get(P_PUB)).toBe(v2);
    const { summary } = await readReport(dir);
    expect(summary.provider).toBe("kronos");
    expect(summary.repointed).toBe(1);
  });

  it("--provider rejects an unknown stub (exit 1, abort report, nothing written)", async () => {
    const files = new Map([[P_KRONOS, v2]]);
    const dir = await tmpDir();

    await run(files, dir, "--provider", "nope");

    expect(process.exitCode).toBe(1);
    expect((await readReport(dir)).summary.aborted).toBe(true);
    expect(files.get(P_KRONOS)).toBe(v2);
  });

  it("refuses a folder absent from the provider map unless --allow-unknown-dirs", async () => {
    const files = new Map([[P_MYSTERY, v2]]);
    const dir = await tmpDir();

    await run(files, dir);

    expect(process.exitCode).toBe(1);
    expect(files.get(P_MYSTERY)).toBe(v2);
    const { rows } = await readReport(dir);
    expect(rows?.[0]?.status).toMatch(/^error:.*Mystery Source/);
  });

  it("--allow-unknown-dirs points an unknown folder at public (matching migrate's routing)", async () => {
    const files = new Map([[P_MYSTERY, v2]]);
    const dir = await tmpDir();

    await run(files, dir, "--allow-unknown-dirs");

    expect(files.get(P_MYSTERY)).toMatch(/remote: public/);
    expect(process.exitCode).toBe(0);
  });

  it("fails loud (exit 1) and records an unsupported .dvc as an error", async () => {
    const files = new Map([["/repo/data/dvc/Kronos/c.csv.dvc", v1]]);
    const dir = await tmpDir();

    await run(files, dir);

    const { summary } = await readReport(dir);
    expect(summary.errors).toBe(1);
    expect(process.exitCode).toBe(1);
  });
});
