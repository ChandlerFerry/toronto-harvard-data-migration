import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ProductionGuardError } from "../../../src/config/guards.js";
import { bucketName } from "../../../src/config/sources.js";
import { md5ToKey } from "../../../src/domain/dvcKey.js";
import { buildPlan, identityResolver } from "../../../src/domain/plan.js";
import { VerificationGapError, deleteOld } from "../../../src/services/deleteOld.js";
import { transfer } from "../../../src/services/transfer.js";
import { verify, verifyMany } from "../../../src/services/verify.js";
import { FakeObjectStore } from "../../support/fakeObjectStore.js";

const A = "aa11111111111111111111111111111a";
const B = "bb22222222222222222222222222222b";
const C = "cc33333333333333333333333333333c";
const DIR = "dd44444444444444444444444444444d.dir";

const OLD = "old-remote";
const NEW = "new-remote";

class FlakyCopyStore extends FakeObjectStore {
  private failsLeft: number;
  constructor(fails: number) {
    super();
    this.failsLeft = fails;
  }
  override copy(spec: Parameters<FakeObjectStore["copy"]>[0]): Promise<void> {
    if (this.failsLeft > 0) {
      this.failsLeft -= 1;
      return Promise.reject({ name: "SlowDown" });
    }
    return super.copy(spec);
  }
}

const fastRetry = { retry: { sleep: () => Promise.resolve(), random: () => 0, baseDelayMs: 1 } };

async function seedOld(store: FakeObjectStore): Promise<string[]> {
  await store.ensureBucket(OLD);
  const entries: Array<[string, string]> = [
    [md5ToKey(A, "v2"), "alpha"],
    [md5ToKey(B, "v2"), "beta-content"],
    [md5ToKey(C, "v2"), "gamma"],
    [md5ToKey(DIR, "v2"), '{"files":[]}'],
  ];
  for (const [key, body] of entries) await store.put(OLD, key, body);
  return entries.map(([key]) => key);
}

describe("transfer", () => {
  let store: FakeObjectStore;
  let keys: string[];

  beforeEach(async () => {
    store = new FakeObjectStore();
    keys = await seedOld(store);
  });

  it("copies every planned object server-side (incl .dir)", async () => {
    const plan = buildPlan(OLD, keys, identityResolver(NEW));
    const report = await transfer(store, plan);
    expect(report.total).toBe(4);
    expect(report.copied).toBe(4);
    expect(report.skipped).toBe(0);
    expect(report.errors).toEqual([]);
    expect((await store.list(NEW)).map((o) => o.key).sort()).toEqual([...keys].sort());
  });

  it("is idempotent: a second run skips already-present (byte-identical) objects", async () => {
    const plan = buildPlan(OLD, keys, identityResolver(NEW));
    await transfer(store, plan);
    const second = await transfer(store, plan);
    expect(second.copied).toBe(0);
    expect(second.skipped).toBe(4);
  });

  it("self-heals: re-copies a same-size but corrupt destination instead of skipping", async () => {
    const s = new FakeObjectStore();
    await s.ensureBucket(OLD);
    await s.ensureBucket(NEW);
    const key = md5ToKey(A, "v2");
    await s.put(OLD, key, "GOOD");
    await s.put(NEW, key, "BAD!");
    const r = await transfer(s, buildPlan(OLD, [key], identityResolver(NEW)));
    expect(r.copied).toBe(1);
    expect(r.skipped).toBe(0);
    expect(new TextDecoder().decode(await s.getBytes(NEW, key))).toBe("GOOD");
  });

  it("retries a transient copy failure with backoff (no hard error)", async () => {
    const s = new FlakyCopyStore(2);
    await s.ensureBucket(OLD);
    const key = md5ToKey(A, "v2");
    await s.put(OLD, key, "x");
    const r = await transfer(s, buildPlan(OLD, [key], identityResolver(NEW)), fastRetry);
    expect(r.errors).toEqual([]);
    expect(r.copied).toBe(1);
  });

  it("records a hard error only after exhausting retries", async () => {
    const s = new FlakyCopyStore(99);
    await s.ensureBucket(OLD);
    const key = md5ToKey(A, "v2");
    await s.put(OLD, key, "x");
    const r = await transfer(s, buildPlan(OLD, [key], identityResolver(NEW)), {
      maxRetries: 2,
      ...fastRetry,
    });
    expect(r.copied).toBe(0);
    expect(r.errors).toHaveLength(1);
  });
});

describe("verify", () => {
  let store: FakeObjectStore;
  let keys: string[];

  beforeEach(async () => {
    store = new FakeObjectStore();
    keys = await seedOld(store);
    await transfer(store, buildPlan(OLD, keys, identityResolver(NEW)));
  });

  it("passes when NEW matches OLD hash-for-hash", async () => {
    const report = await verify(store, OLD, store, NEW);
    expect(report.ok).toBe(true);
    expect(report.matched.length).toBe(4);
    expect(report.missing).toEqual([]);
    expect(report.oldCount).toBe(4);
    expect(report.newCount).toBe(4);
  });

  it("tolerates a v3 destination layout for the same md5", async () => {
    const s = new FakeObjectStore();
    await s.ensureBucket(OLD);
    await s.ensureBucket(NEW);
    await s.put(OLD, md5ToKey(A, "v2"), "same");
    await s.put(NEW, md5ToKey(A, "v3"), "same");
    const report = await verify(s, OLD, s, NEW);
    expect(report.ok).toBe(true);
    expect(report.matched).toEqual([md5ToKey(A, "v2")]);
  });

  it("reports a missing object and fails when NEW is incomplete", async () => {
    await store.deleteBatch(NEW, [md5ToKey(B, "v2")]);
    const report = await verify(store, OLD, store, NEW);
    expect(report.ok).toBe(false);
    expect(report.missing).toHaveLength(1);
    expect(report.missing[0]!.md5).toBe(B);
  });

  it("deep mode (etag cross-check) passes when OLD and NEW bytes are identical", async () => {
    const s = new FakeObjectStore();
    await s.ensureBucket(OLD);
    await s.ensureBucket(NEW);
    const body = "deep-mode-content";
    const md5 = createHash("md5").update(body).digest("hex");
    await s.put(OLD, md5ToKey(md5, "v2"), body);
    await s.put(NEW, md5ToKey(md5, "v3"), body);
    const report = await verify(s, OLD, s, NEW, { deep: true });
    expect(report.ok).toBe(true);
    expect(report.deepChecked).toBe(1);
  });

  it("deep mode (etag cross-check) catches same-size corruption the size-check misses", async () => {
    const s = new FakeObjectStore();
    await s.ensureBucket(OLD);
    await s.ensureBucket(NEW);
    const good = "AAAA";
    const md5 = createHash("md5").update(good).digest("hex");
    const key = md5ToKey(md5, "v2");
    await s.put(OLD, key, good);
    await s.put(NEW, key, "BBBB");
    expect((await verify(s, OLD, s, NEW)).ok).toBe(true);
    expect((await verify(s, OLD, s, NEW, { deep: true })).ok).toBe(false);
  });

  it("deep mode flags a same-size corrupt copy even when an intact same-md5 copy exists", async () => {
    const s = new FakeObjectStore();
    await s.ensureBucket(OLD);
    await s.ensureBucket(NEW);
    const good = "GOOD";
    const md5 = createHash("md5").update(good).digest("hex");
    await s.put(OLD, md5ToKey(md5, "v2"), good);
    await s.put(NEW, md5ToKey(md5, "v2"), "BAD!");
    await s.put(NEW, md5ToKey(md5, "v3"), good);
    expect((await verify(s, OLD, s, NEW)).ok).toBe(true);
    const deep = await verify(s, OLD, s, NEW, { deep: true });
    expect(deep.ok).toBe(false);
  });
});

describe("verifyMany (provider split)", () => {
  it("verifies OLD against the union of several NEW buckets", async () => {
    const s = new FakeObjectStore();
    await s.ensureBucket(OLD);
    await s.put(OLD, md5ToKey(A, "v2"), "a");
    await s.put(OLD, md5ToKey(B, "v2"), "bb");
    await s.ensureBucket("nb1");
    await s.ensureBucket("nb2");
    await s.put("nb1", md5ToKey(A, "v2"), "a");
    await s.put("nb2", md5ToKey(B, "v3"), "bb");
    const r = await verifyMany(s, OLD, s, ["nb1", "nb2"], { deep: true });
    expect(r.ok).toBe(true);
    expect(r.matched.length).toBe(2);
  });

  it("flags an object missing from every NEW bucket", async () => {
    const s = new FakeObjectStore();
    await s.ensureBucket(OLD);
    await s.put(OLD, md5ToKey(A, "v2"), "a");
    await s.put(OLD, md5ToKey(B, "v2"), "bb");
    await s.ensureBucket("nb1");
    await s.put("nb1", md5ToKey(A, "v2"), "a");
    const r = await verifyMany(s, OLD, s, ["nb1"]);
    expect(r.ok).toBe(false);
    expect(r.missing[0]!.md5).toBe(B);
  });
});

describe("deleteOld", () => {
  let store: FakeObjectStore;
  let keys: string[];

  beforeEach(async () => {
    store = new FakeObjectStore();
    keys = await seedOld(store);
    await transfer(store, buildPlan(OLD, keys, identityResolver(NEW)));
  });

  it("dry-run (default) deletes nothing but reports targets", async () => {
    const report = await verify(store, OLD, store, NEW);
    const del = await deleteOld(store, OLD, report);
    expect(del.dryRun).toBe(true);
    expect(del.deleted).toEqual([]);
    expect(del.targetCount).toBe(4);
    expect((await store.list(OLD)).length).toBe(4);
  });

  it("with --no-dry-run removes verified objects from OLD", async () => {
    const report = await verify(store, OLD, store, NEW);
    const del = await deleteOld(store, OLD, report, { dryRun: false });
    expect(del.dryRun).toBe(false);
    expect(del.deleted.sort()).toEqual([...keys].sort());
    expect((await store.list(OLD)).length).toBe(0);
    expect((await store.list(NEW)).length).toBe(4);
  });

  it("ABORTS (throws) when verification has any gap — never deletes unverified", async () => {
    await store.deleteBatch(NEW, [md5ToKey(B, "v2")]);
    const report = await verify(store, OLD, store, NEW);
    await expect(deleteOld(store, OLD, report, { dryRun: false })).rejects.toBeInstanceOf(
      VerificationGapError,
    );
    expect((await store.list(OLD)).length).toBe(4);
  });

  it("refuses to delete from a production-named bucket even when fully verified", async () => {
    const prod = bucketName("coinout", "us-east-2");
    await store.ensureBucket(prod);

    await store.put(prod, md5ToKey(A, "v2"), "alpha");
    await store.put(prod, md5ToKey(B, "v2"), "beta-content");
    await store.put(prod, md5ToKey(C, "v2"), "gamma");
    await store.put(prod, md5ToKey(DIR, "v2"), '{"files":[]}');
    const report = await verify(store, prod, store, NEW);
    expect(report.ok).toBe(true);
    await expect(deleteOld(store, prod, report, { dryRun: false, env: {} })).rejects.toBeInstanceOf(
      ProductionGuardError,
    );
  });
});
