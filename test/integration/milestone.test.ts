import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3ObjectStore } from "../../src/adapters/s3ObjectStore.js";
import { VerificationGapError, deleteOld } from "../../src/services/deleteOld.js";
import { migrate } from "../../src/services/migrate.js";
import { verify } from "../../src/services/verify.js";
import { type LocalStackHandle, startLocalStack } from "../localstack.js";
import { type SandboxEntry, collectSandboxEntries, seedSandbox } from "../support/seedSandbox.js";

const SEED_COUNT = Number(process.env.SEED_COUNT ?? 120);

describe("MILESTONE: sandbox migrate -> verify -> guarded delete on LocalStack", () => {
  let ls: LocalStackHandle;
  let store: S3ObjectStore;
  let entries: SandboxEntry[];

  beforeAll(async () => {
    ls = await startLocalStack();
    store = new S3ObjectStore(ls.client, { region: "us-east-2" });
    entries =
      process.env.SEED_FULL === "1"
        ? await collectSandboxEntries()
        : await collectSandboxEntries({ limit: SEED_COUNT });
  });

  afterAll(async () => {
    await ls?.stop();
  });

  it("samples real sandbox objects including a .dir directory object", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.key.endsWith(".dir"))).toBe(true);
  });

  it("migrates hash-for-hash, deep-verifies, dry-runs, then deletes OLD under guard", async () => {
    const OLD = "old-dvc-remote";
    const NEW = "new-dvc-remote";
    await seedSandbox(store, OLD, entries);

    const report = await migrate({ store, oldBucket: OLD, newBucket: NEW, deep: true });
    expect(report.transfer.errors).toEqual([]);
    expect(report.transfer.copied).toBe(entries.length);
    expect(report.verify.ok).toBe(true);
    expect(report.verify.matched.length).toBe(entries.length);
    expect(report.verify.deepChecked).toBe(entries.length);

    const oldKeys = (await store.list(OLD)).map((o) => o.key).sort();
    const newKeys = (await store.list(NEW)).map((o) => o.key).sort();
    expect(newKeys).toEqual(oldKeys);

    const dry = await deleteOld(store, OLD, report.verify, { env: {} });
    expect(dry.dryRun).toBe(true);
    expect((await store.list(OLD)).length).toBe(entries.length);

    const del = await deleteOld(store, OLD, report.verify, { dryRun: false, env: {} });
    expect(del.dryRun).toBe(false);
    expect(del.deleted.length).toBe(entries.length);
    expect((await store.list(OLD)).length).toBe(0);
    expect((await store.list(NEW)).length).toBe(entries.length);
  });

  it("ABORTS delete when any object is missing from NEW (negative test)", async () => {
    const OLD = "old-neg-remote";
    const NEW = "new-neg-remote";
    await seedSandbox(store, OLD, entries);
    await migrate({ store, oldBucket: OLD, newBucket: NEW });

    const victim = (await store.list(NEW))[0]!.key;
    await store.deleteBatch(NEW, [victim]);

    const report = await verify(store, OLD, store, NEW);
    expect(report.ok).toBe(false);
    expect(report.missing.length).toBe(1);

    await expect(deleteOld(store, OLD, report, { dryRun: false, env: {} })).rejects.toBeInstanceOf(
      VerificationGapError,
    );

    expect((await store.list(OLD)).length).toBe(entries.length);
  });
});
