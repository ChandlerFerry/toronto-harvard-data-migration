import { describe, expect, it } from "vitest";
import { md5ToKey } from "../../../src/domain/dvcKey.js";
import {
  deleteOldAgainstBuckets,
  listShard,
  md5Prefixes,
  migrateSharded,
  verifySharded,
} from "../../../src/services/sharded.js";
import { verifyLists } from "../../../src/services/verify.js";
import { FakeObjectStore } from "../../support/fakeObjectStore.js";

const A = `00${"1".repeat(30)}`;
const B = `ab${"2".repeat(30)}`;
const C = `ff${"3".repeat(30)}`;
const DIR = `5c${"4".repeat(30)}.dir`;

async function seed(store: FakeObjectStore, bucket: string): Promise<void> {
  await store.ensureBucket(bucket);
  await store.put(bucket, md5ToKey(A, "v2"), "alpha");
  await store.put(bucket, md5ToKey(B, "v3"), "beta-content");
  await store.put(bucket, md5ToKey(C, "v2"), "gamma");
  await store.put(bucket, md5ToKey(DIR, "v2"), '{"files":[]}');
}

describe("md5Prefixes", () => {
  it("generates 16^length prefixes", () => {
    expect(md5Prefixes(1)).toHaveLength(16);
    expect(md5Prefixes(2)).toHaveLength(256);
    expect(md5Prefixes(1)[0]).toBe("0");
    expect(md5Prefixes(1).at(-1)).toBe("f");
  });
  it.each([0, 5, 1.5])("rejects invalid length %s", (n) => {
    expect(() => md5Prefixes(n)).toThrow();
  });
});

describe("listShard", () => {
  it("returns both v2 and v3 objects of an md5 prefix", async () => {
    const s = new FakeObjectStore();
    await s.ensureBucket("b");
    await s.put("b", md5ToKey(A, "v2"), "x");
    await s.put("b", `${"files/md5/00/"}${"9".repeat(30)}`, "y");
    await s.put("b", md5ToKey(C, "v2"), "z");
    const shard0 = await listShard(s, "b", "00");
    expect(shard0.map((o) => o.key).sort()).toEqual(
      [md5ToKey(A, "v2"), `files/md5/00/${"9".repeat(30)}`].sort(),
    );
  });
});

describe("verifySharded provider-split union", () => {
  it("treats a missing destination bucket as empty (does not crash) and still verifies the rest", async () => {
    const s = new FakeObjectStore();
    await s.ensureBucket("old");
    await s.put("old", md5ToKey(A, "v2"), "alpha");
    await s.ensureBucket("dest-real");
    await s.put("dest-real", md5ToKey(A, "v2"), "alpha");

    const vr = await verifySharded(s, "old", s, "dest-real", {
      deep: true,
      shardLength: 2,
      newBuckets: ["dest-real", "dest-missing"],
    });
    expect(vr.ok).toBe(true);
    expect(vr.matchedCount).toBe(1);
  });

  it("still reports a genuinely-absent object as missing when its bucket does not exist", async () => {
    const s = new FakeObjectStore();
    await s.ensureBucket("old");
    await s.put("old", md5ToKey(A, "v2"), "alpha");

    const vr = await verifySharded(s, "old", s, "dest-missing", {
      deep: true,
      shardLength: 2,
      newBuckets: ["dest-missing"],
    });
    expect(vr.ok).toBe(false);
    expect(vr.missing.length).toBe(1);
  });
});

describe("verifySharded", () => {
  it("matches the whole-bucket verify result", async () => {
    const s = new FakeObjectStore();
    await seed(s, "old");
    await seed(s, "new");
    const whole = verifyLists(await s.list("old"), await s.list("new"), { deep: true });
    const sharded = await verifySharded(s, "old", s, "new", { deep: true, shardLength: 2 });
    expect(sharded.ok).toBe(whole.ok);
    expect(sharded.matchedCount).toBe(whole.matched.length);
    expect(sharded.oldCount).toBe(whole.oldCount);
    expect(sharded.deepChecked).toBe(whole.deepChecked);
    expect(sharded.shardsWithGaps).toEqual([]);
  });

  it("reports the shard and entry for a planted gap", async () => {
    const s = new FakeObjectStore();
    await seed(s, "old");
    await seed(s, "new");
    await s.deleteBatch("new", [md5ToKey(B, "v3")]);
    const sharded = await verifySharded(s, "old", s, "new", { shardLength: 2 });
    expect(sharded.ok).toBe(false);
    expect(sharded.shardsWithGaps).toEqual(["ab"]);
    expect(sharded.missing[0]!.md5).toBe(B);
  });
});

describe("provider-scoped (keepMd5) incremental slice", () => {
  const keepB = (md5: string): boolean => md5.startsWith("ab");

  it("migrateSharded copies ONLY kept objects; the rest stay in OLD; scoped verify ok", async () => {
    const s = new FakeObjectStore();
    await seed(s, "old");
    const rep = await migrateSharded({
      store: s,
      oldBucket: "old",
      newBucket: "new-b",
      deep: true,
      shardLength: 2,
      keepMd5: keepB,
    });
    expect(rep.transfer.copied).toBe(1);
    expect(rep.verify.ok).toBe(true);
    expect(rep.verify.matchedCount).toBe(1);
    expect((await s.list("new-b")).map((o) => o.key)).toEqual([md5ToKey(B, "v3")]);
    expect((await s.list("old")).length).toBe(4);
  });

  it("verifySharded scoped is ok even though the other providers are absent from NEW", async () => {
    const s = new FakeObjectStore();
    await seed(s, "old");
    await s.ensureBucket("new-b");
    await s.put("new-b", md5ToKey(B, "v3"), "beta-content");
    const vr = await verifySharded(s, "old", s, "new-b", {
      deep: true,
      shardLength: 2,
      newBuckets: ["new-b"],
      keepMd5: keepB,
    });
    expect(vr.ok).toBe(true);
    expect(vr.oldCount).toBe(1);
    expect(vr.matchedCount).toBe(1);
  });
});

describe("migrateSharded", () => {
  it("copies + verifies hash-for-hash one shard at a time", async () => {
    const s = new FakeObjectStore();
    await seed(s, "old");
    const rep = await migrateSharded({
      store: s,
      oldBucket: "old",
      newBucket: "new",
      deep: true,
      shardLength: 2,
    });
    expect(rep.transfer.copied).toBe(4);
    expect(rep.transfer.errors).toEqual([]);
    expect(rep.verify.ok).toBe(true);
    expect((await s.list("new")).map((o) => o.key).sort()).toEqual(
      (await s.list("old")).map((o) => o.key).sort(),
    );

    const del = await deleteOldAgainstBuckets(s, "old", ["new"], {
      shardLength: 2,
      dryRun: false,
      env: {},
    });
    expect(del.deleted).toBe(4);
    expect((await s.list("old")).length).toBe(0);
  });

  it("does not verify against newBucket when the resolver routes every object away from it", async () => {
    const s = new FakeObjectStore();
    await seed(s, "old");
    await s.ensureBucket("new-a");
    await s.ensureBucket("new-f");

    const rep = await migrateSharded({
      store: s,
      oldBucket: "old",
      newBucket: "new-rest",
      deep: true,
      shardLength: 2,
      resolve: ({ md5, sourceKey }) => {
        const dest = md5.startsWith("ab") ? "new-a" : "new-f";
        return { destBucket: dest, destKey: sourceKey };
      },
    });
    expect(rep.transfer.copied).toBe(4);
    expect(rep.transfer.errors).toEqual([]);
    expect(rep.verify.ok).toBe(true);
    expect(rep.verify.matchedCount).toBe(4);
  });

  it("verifies against the ACTUAL destination buckets when a routing resolver splits objects", async () => {
    const s = new FakeObjectStore();
    await seed(s, "old");
    await s.ensureBucket("new");
    await s.ensureBucket("new-a");
    await s.ensureBucket("new-f");

    const rep = await migrateSharded({
      store: s,
      oldBucket: "old",
      newBucket: "new",
      deep: true,
      shardLength: 2,
      resolve: ({ md5, sourceKey }) => {
        const dest = md5.startsWith("ab") ? "new-a" : md5.startsWith("ff") ? "new-f" : "new";
        return { destBucket: dest, destKey: sourceKey };
      },
    });
    expect(rep.transfer.copied).toBe(4);
    expect(rep.transfer.errors).toEqual([]);

    expect(rep.verify.ok).toBe(true);
    expect(rep.verify.missing).toEqual([]);
    expect(rep.verify.matchedCount).toBe(4);
  });
});
