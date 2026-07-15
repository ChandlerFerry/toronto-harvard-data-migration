import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3ObjectStore } from "../../src/adapters/s3ObjectStore.js";
import { deleteOldSharded, migrateSharded, verifySharded } from "../../src/services/sharded.js";
import { type LocalStackHandle, startLocalStack } from "../localstack.js";
import { type SandboxEntry, collectSandboxEntries, seedSandbox } from "../support/seedSandbox.js";

const SEED_COUNT = Number(process.env.SEED_COUNT ?? 120);

describe("Sharded pipeline on real S3 ListObjectsV2 (LocalStack)", () => {
  let ls: LocalStackHandle;
  let store: S3ObjectStore;
  let entries: SandboxEntry[];

  beforeAll(async () => {
    ls = await startLocalStack();
    store = new S3ObjectStore(ls.client, { region: "us-east-2" });
    entries = await collectSandboxEntries({ limit: SEED_COUNT });
  });

  afterAll(async () => {
    await ls?.stop();
  });

  it("sharded migrate -> verify -> delete over the sandbox's v2/v3/.dir mix", async () => {
    const OLD = "old-sharded";
    const NEW = "new-sharded";
    await seedSandbox(store, OLD, entries);

    const rep = await migrateSharded({
      store,
      oldBucket: OLD,
      newBucket: NEW,
      deep: true,
      shardLength: 2,
    });
    expect(rep.transfer.errors).toEqual([]);
    expect(rep.transfer.copied).toBe(entries.length);
    expect(rep.verify.ok).toBe(true);
    expect(rep.verify.matchedCount).toBe(entries.length);

    expect(rep.verify.oldCount).toBe(entries.length);

    const vr = await verifySharded(store, OLD, store, NEW, { deep: true, shardLength: 2 });
    expect(vr.ok).toBe(true);
    expect(vr.matchedCount).toBe(entries.length);

    const del = await deleteOldSharded(store, OLD, NEW, {
      shardLength: 2,
      dryRun: false,
      env: {},
    });
    expect(del.deleted).toBe(entries.length);
    expect((await store.list(OLD)).length).toBe(0);
    expect((await store.list(NEW)).length).toBe(entries.length);
  });
});
