import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3ObjectStore } from "../../src/adapters/s3ObjectStore.js";
import { type DestResolver, buildPlan } from "../../src/domain/plan.js";
import { deleteOld } from "../../src/services/deleteOld.js";
import { type ReportEnvelope, writeRunReport } from "../../src/services/runReport.js";
import { transfer } from "../../src/services/transfer.js";
import { verifyMany } from "../../src/services/verify.js";
import { type LocalStackHandle, startLocalStack } from "../localstack.js";
import { type SandboxEntry, collectSandboxEntries, seedSandbox } from "../support/seedSandbox.js";

const SEED_COUNT = Number(process.env.SEED_COUNT ?? 90);

const SPLIT_BUCKETS = ["split-affinity", "split-coinout", "split-public"] as const;
function destFor(md5: string): string {
  let h = 0;
  for (const ch of md5) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SPLIT_BUCKETS[h % SPLIT_BUCKETS.length]!;
}

describe("E2E: provider-split migrate -> multi-bucket verify -> guarded delete (LocalStack)", () => {
  let ls: LocalStackHandle;
  let store: S3ObjectStore;
  let entries: SandboxEntry[];
  const tmps: string[] = [];

  beforeAll(async () => {
    ls = await startLocalStack();
    store = new S3ObjectStore(ls.client, { region: "us-east-2" });
    entries = await collectSandboxEntries({ limit: SEED_COUNT });
  });

  afterAll(async () => {
    for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
    await ls?.stop();
  });

  it("splits objects across buckets, verifies the union, deletes OLD, writes a report", async () => {
    const OLD = "old-split-remote";
    await seedSandbox(store, OLD, entries);
    const keys = (await store.list(OLD)).map((o) => o.key);

    const resolve: DestResolver = ({ md5, sourceKey }) => ({
      destBucket: destFor(md5),
      destKey: sourceKey,
    });
    const plan = buildPlan(OLD, keys, resolve);

    const transferReport = await transfer(store, plan);
    expect(transferReport.errors).toEqual([]);
    expect(transferReport.copied).toBe(keys.length);

    for (const item of plan.items) {
      const head = await store.head(item.destBucket, item.destKey);
      expect(head.size).toBeGreaterThanOrEqual(0);
    }

    const vr = await verifyMany(store, OLD, store, [...SPLIT_BUCKETS], {
      plannedKeys: keys,
      deep: true,
    });
    expect(vr.ok).toBe(true);
    expect(vr.matched.length).toBe(keys.length);

    const dir = await mkdtemp(join(tmpdir(), "e2e-"));
    tmps.push(dir);
    const env: ReportEnvelope = {
      kind: "migrate",
      createdAt: "T",
      summary: { old: OLD, buckets: SPLIT_BUCKETS.length, total: keys.length, verifyOk: vr.ok },
      rows: plan.items.map((i) => ({
        key: i.sourceKey,
        md5: i.md5,
        action: "copy",
        destBucket: i.destBucket,
        status: "copied",
      })),
    };
    const written = await writeRunReport(dir, "e2e-split", env);
    expect((await readdir(dir)).filter((f) => f.includes("e2e-split")).length).toBe(2);
    expect(written.csvPath).toBeDefined();

    const del = await deleteOld(store, OLD, vr, { dryRun: false, env: {} });
    expect(del.deleted.length).toBe(keys.length);
    expect((await store.list(OLD)).length).toBe(0);

    let sum = 0;
    for (const b of SPLIT_BUCKETS) sum += (await store.list(b)).length;
    expect(sum).toBe(keys.length);
  });
});
