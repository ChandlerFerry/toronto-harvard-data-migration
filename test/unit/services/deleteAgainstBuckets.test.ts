import { describe, expect, it } from "vitest";
import { ProductionGuardError } from "../../../src/config/guards.js";
import { bucketName } from "../../../src/config/sources.js";
import { md5ToKey } from "../../../src/domain/dvcKey.js";
import { deleteOldAgainstBuckets, migrateSharded } from "../../../src/services/sharded.js";
import { FakeObjectStore } from "../../support/fakeObjectStore.js";

// md5s whose first two hex land them in distinct shards.
const A = "aa11111111111111111111111111111a";
const B = "bb22222222222222222222222222222b";
const C = "cc33333333333333333333333333333c";
const E = "ee0000000000000000000000000000ee";

const REGION = "us-east-2";
const AFFINITY = bucketName("affinity", REGION);
const COINOUT = bucketName("coinout", REGION);
const PUBLIC = bucketName("public", REGION);
const EARNIN = bucketName("earnin", REGION);

const OLD = "old-demo"; // not a production-named bucket → guard is satisfied for deletes.
const noEnv = { env: {} as NodeJS.ProcessEnv };

/** Lists one bucket's objects with a multipart-style composite ETag (`<md5>-2`). */
class CompositeEtagStore extends FakeObjectStore {
  constructor(private readonly compositeBucket: string) {
    super();
  }
  override async list(bucket: string, prefix?: string) {
    const out = await super.list(bucket, prefix);
    return bucket === this.compositeBucket ? out.map((o) => ({ ...o, etag: `${o.etag}-2` })) : out;
  }
}

describe("deleteOldAgainstBuckets — git-free, object-store-driven delete", () => {
  it("STILL deletes after the .dvc repoints: upload → migrate → update NEW via git → delete", async () => {
    // (1) Upload a file to old-demo (the OLD monolith).
    const store = new FakeObjectStore();
    await store.ensureBucket(OLD);
    await store.put(OLD, md5ToKey(A, "v2"), "report-v1");

    // (2) Migrate it (the real migrate path) into its provider bucket — verbatim copy.
    const rep = await migrateSharded({
      store,
      oldBucket: OLD,
      newBucket: AFFINITY,
      resolve: ({ sourceKey }) => ({ destBucket: AFFINITY, destKey: sourceKey }),
      deep: true,
      shardLength: 2,
    });
    expect(rep.verify.ok).toBe(true);
    expect((await store.list(AFFINITY)).map((o) => o.key)).toEqual([md5ToKey(A, "v2")]);

    // (3) "Update the data in the new bucket via git": the .dvc repoints A → B and a
    //     `dvc push` uploads the NEW content (md5 B) into the SAME provider bucket. We
    //     model exactly that S3 side effect — delete consults NO git and NO .dvc.
    await store.put(AFFINITY, md5ToKey(B, "v3"), "report-v2");

    // (4) Delete STILL drains A from OLD: A is proven byte-identical in the provider
    //     bucket. (The old git-driven gate aborted here — git now points only at B.)
    const del = await deleteOldAgainstBuckets(store, OLD, [AFFINITY], { dryRun: false, ...noEnv });
    expect(del.deleted).toBe(1);
    expect((await store.list(OLD)).length).toBe(0); // OLD drained
    expect((await store.list(AFFINITY)).map((o) => o.key).sort()).toEqual(
      [md5ToKey(A, "v2"), md5ToKey(B, "v3")].sort(), // NEW intact: A + the repointed B
    );
  });

  it("dry-run is the DEFAULT: reports the target count, deletes nothing", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket(OLD);
    await store.put(OLD, md5ToKey(A, "v2"), "alpha");
    await store.ensureBucket(AFFINITY);
    await store.put(AFFINITY, md5ToKey(A, "v2"), "alpha");

    const del = await deleteOldAgainstBuckets(store, OLD, [AFFINITY], noEnv);
    expect(del.dryRun).toBe(true);
    expect(del.deleted).toBe(0);
    expect(del.targetCount).toBe(1);
    expect((await store.list(OLD)).length).toBe(1);
  });

  it("targets ONE provider bucket: a misrouted object is NOT deleted under the wrong provider", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket(OLD);
    await store.put(OLD, md5ToKey(E, "v2"), "payroll");
    await store.ensureBucket(PUBLIC);
    await store.put(PUBLIC, md5ToKey(E, "v2"), "payroll"); // a private object misrouted into public

    // Draining provider=earnin: the object is not in dvc-earnin → left untouched in OLD.
    const wrong = await deleteOldAgainstBuckets(store, OLD, [EARNIN], { dryRun: false, ...noEnv });
    expect(wrong.deleted).toBe(0);
    expect((await store.list(OLD)).length).toBe(1);

    // Draining provider=public: it IS byte-identical in dvc-public → drained (accepted
    // per the per-provider-bucket model; the misroute is a migrate-time routing concern).
    const right = await deleteOldAgainstBuckets(store, OLD, [PUBLIC], { dryRun: false, ...noEnv });
    expect(right.deleted).toBe(1);
    expect((await store.list(OLD)).length).toBe(0);
  });

  it("REFUSES a same-size-but-corrupt provider copy (deep ETag) — never deletes it", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket(OLD);
    await store.put(OLD, md5ToKey(A, "v2"), "GOOD");
    await store.ensureBucket(AFFINITY);
    await store.put(AFFINITY, md5ToKey(A, "v2"), "BAD!"); // same size (4), different bytes

    const del = await deleteOldAgainstBuckets(store, OLD, [AFFINITY], { dryRun: false, ...noEnv });
    expect(del.deleted).toBe(0);
    expect(del.corrupt).toHaveLength(1);
    expect(del.corrupt[0]!.reason).toBe("etag-mismatch");
    expect((await store.list(OLD)).length).toBe(1); // OLD intact
  });

  it("union invariant: a corrupt copy in ANY targeted bucket refuses the delete, in either bucket order", async () => {
    for (const buckets of [
      [AFFINITY, COINOUT],
      [COINOUT, AFFINITY],
    ]) {
      const store = new FakeObjectStore();
      await store.ensureBucket(OLD);
      await store.put(OLD, md5ToKey(A, "v2"), "alpha");
      await store.ensureBucket(AFFINITY);
      await store.put(AFFINITY, md5ToKey(A, "v2"), "alpha"); // intact copy
      await store.ensureBucket(COINOUT);
      await store.put(COINOUT, md5ToKey(A, "v2"), "alph!"); // same-size corrupt copy

      const del = await deleteOldAgainstBuckets(store, OLD, buckets, { dryRun: false, ...noEnv });
      expect(del.deleted).toBe(0);
      expect((await store.list(OLD)).length).toBe(1); // left in OLD
      expect(del.corrupt).toHaveLength(1); // reported exactly once
      expect(del.corrupt[0]!.reason).toBe("etag-mismatch");
    }
  });

  it("expectBucketByMd5: refuses (misrouted) an object whose only byte-identical copy is in the WRONG bucket", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket(OLD);
    await store.put(OLD, md5ToKey(E, "v2"), "payroll");
    await store.ensureBucket(EARNIN);
    await store.ensureBucket(PUBLIC);
    await store.put(PUBLIC, md5ToKey(E, "v2"), "payroll"); // private object misrouted into public

    const del = await deleteOldAgainstBuckets(store, OLD, [EARNIN, PUBLIC], {
      dryRun: false,
      expectBucketByMd5: () => EARNIN,
      ...noEnv,
    });
    expect(del.deleted).toBe(0);
    expect((await store.list(OLD)).length).toBe(1); // left in OLD
    expect(del.corrupt).toHaveLength(1);
    expect(del.corrupt[0]!.reason).toBe("misrouted");
    expect(del.corrupt[0]!.expectedBucket).toBe(EARNIN);
    expect(del.corrupt[0]!.foundBuckets).toEqual([PUBLIC]);
  });

  it("expectBucketByMd5: deletes when the routed bucket holds the proven copy (extra copies elsewhere OK)", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket(OLD);
    await store.put(OLD, md5ToKey(E, "v2"), "payroll");
    await store.ensureBucket(EARNIN);
    await store.put(EARNIN, md5ToKey(E, "v2"), "payroll");
    await store.ensureBucket(PUBLIC);
    await store.put(PUBLIC, md5ToKey(E, "v2"), "payroll");

    const del = await deleteOldAgainstBuckets(store, OLD, [EARNIN, PUBLIC], {
      dryRun: false,
      expectBucketByMd5: () => EARNIN,
      ...noEnv,
    });
    expect(del.deleted).toBe(1);
    expect(del.corrupt).toHaveLength(0);
    expect((await store.list(OLD)).length).toBe(0);
  });

  it("leaves un-migrated OLD objects in place (no abort) and drains the proven ones", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket(OLD);
    await store.put(OLD, md5ToKey(A, "v2"), "alpha");
    await store.put(OLD, md5ToKey(B, "v2"), "beta");
    await store.put(OLD, md5ToKey(C, "v2"), "gamma"); // in NO provider bucket → must survive (no abort)
    await store.ensureBucket(AFFINITY);
    await store.put(AFFINITY, md5ToKey(A, "v2"), "alpha");
    await store.ensureBucket(COINOUT);
    await store.put(COINOUT, md5ToKey(B, "v2"), "beta");

    const del = await deleteOldAgainstBuckets(store, OLD, [AFFINITY, COINOUT], {
      dryRun: false,
      ...noEnv,
    });
    expect(del.deleted).toBe(2);
    expect((await store.list(OLD)).map((o) => o.key)).toEqual([md5ToKey(C, "v2")]); // C survives
  });

  it("a provider bucket that does not exist contributes nothing (no crash)", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket(OLD);
    await store.put(OLD, md5ToKey(A, "v2"), "alpha");
    // EARNIN bucket never created.
    const del = await deleteOldAgainstBuckets(store, OLD, [EARNIN], { dryRun: false, ...noEnv });
    expect(del.deleted).toBe(0);
    expect((await store.list(OLD)).length).toBe(1);
  });

  it("dry-run previews a production-named OLD bucket WITHOUT the override", async () => {
    const PROD = "oi-economictracker-dvc";
    const store = new FakeObjectStore();
    await store.ensureBucket(PROD);
    await store.put(PROD, md5ToKey(A, "v2"), "alpha");
    await store.ensureBucket(AFFINITY);
    await store.put(AFFINITY, md5ToKey(A, "v2"), "alpha");

    const del = await deleteOldAgainstBuckets(store, PROD, [AFFINITY], noEnv);
    expect(del.dryRun).toBe(true);
    expect(del.targetCount).toBe(1);
    expect(del.deleted).toBe(0);
    expect((await store.list(PROD)).length).toBe(1);
  });

  it("guards the OLD bucket: refuses a production-named delete target", async () => {
    const PROD = "oi-economictracker-dvc";
    const store = new FakeObjectStore();
    await store.ensureBucket(PROD);
    await store.put(PROD, md5ToKey(A, "v2"), "alpha");
    await store.ensureBucket(AFFINITY);
    await store.put(AFFINITY, md5ToKey(A, "v2"), "alpha"); // would-be deletable → reach the guard

    await expect(
      deleteOldAgainstBuckets(store, PROD, [AFFINITY], { dryRun: false, ...noEnv }),
    ).rejects.toBeInstanceOf(ProductionGuardError);
    expect((await store.list(PROD)).length).toBe(1); // nothing deleted
  });

  it("surfaces deepEtagSkipped: a multipart-composite provider ETag deletes on size+key, flagged not byte-proven", async () => {
    const store = new CompositeEtagStore(AFFINITY);
    await store.ensureBucket(OLD);
    await store.put(OLD, md5ToKey(A, "v2"), "alpha"); // OLD keeps a single-part ETag
    await store.ensureBucket(AFFINITY);
    await store.put(AFFINITY, md5ToKey(A, "v2"), "alpha"); // same bytes, listed with a composite ETag

    const del = await deleteOldAgainstBuckets(store, OLD, [AFFINITY], { dryRun: false, ...noEnv });
    expect(del.deleted).toBe(1); // size+key tolerant (the documented multipart fallback)
    expect(del.deepEtagSkipped).toBe(1); // but flagged: NOT byte-proven
    expect((await store.list(OLD)).length).toBe(0);
  });
});
