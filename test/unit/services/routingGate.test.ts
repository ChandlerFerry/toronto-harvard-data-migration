import { describe, expect, it } from "vitest";
import { bucketName } from "../../../src/config/sources.js";
import { md5ToKey } from "../../../src/domain/dvcKey.js";
import type { GitDvcEntry } from "../../../src/ports/gitHistory.js";
import { VerificationGapError } from "../../../src/services/deleteOld.js";
import { deleteOldSharded, migrateSharded, verifySharded } from "../../../src/services/sharded.js";
import { buildSplitMapping } from "../../../src/services/split.js";
import { FakeObjectStore } from "../../support/fakeObjectStore.js";

const EARNIN = "ee0000000000000000000000000000ee";
const PAYCHEX = "fa0000000000000000000000000000fa";
const UNREF = "cc0000000000000000000000000000cc";

const entry = (md5: string, rootDir: string): GitDvcEntry => ({
  md5,
  rootDir,
  path: `data/dvc/${rootDir}/f.dvc`,
  commit: "deadbeef",
});
const B = (stub: string): string => bucketName(stub, "us-east-2");

describe("unknownDirs gate (fail-closed routing)", () => {
  it("flags a git folder absent from the provider map as an unknown dir", () => {
    const split = buildSplitMapping({
      gitEntries: [entry(EARNIN, "Earnin"), entry(PAYCHEX, "Definitely Not A Source")],
      region: "us-east-2",
    });
    expect(split.unknownDirs).toEqual(["Definitely Not A Source"]);
  });

  it("a misspelled private folder is unknown (would fall to public) — the CointOut trap", () => {
    const split = buildSplitMapping({
      gitEntries: [entry(EARNIN, "CointOut")],
      region: "us-east-2",
    });
    expect(split.unknownDirs).toEqual(["CointOut"]);

    expect(split.resolve({ md5: EARNIN, sourceKey: md5ToKey(EARNIN, "v2") }).destBucket).toBe(
      B("public"),
    );
  });

  it("known folders (provider or public) produce no unknown dirs", () => {
    const split = buildSplitMapping({
      gitEntries: [entry(EARNIN, "Earnin"), entry(PAYCHEX, "JOLTS")],
      region: "us-east-2",
    });
    expect(split.unknownDirs).toEqual([]);
  });
});

describe("predictBucket / destination assertion (Phase C)", () => {
  it("predicts the per-provider bucket from md5 alone", () => {
    const split = buildSplitMapping({ gitEntries: [entry(EARNIN, "Earnin")], region: "us-east-2" });
    expect(split.predictBucket(EARNIN)).toBe(B("earnin"));
    expect(split.predictBucket(UNREF)).toBe(B("public"));
  });

  it("verify WITHOUT the assertion is blind to a misroute (the latent gap)", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old");
    await store.put("old", md5ToKey(EARNIN, "v2"), "payroll");
    await store.ensureBucket(B("public"));
    await store.put(B("public"), md5ToKey(EARNIN, "v2"), "payroll");

    const split = buildSplitMapping({ gitEntries: [entry(EARNIN, "Earnin")], region: "us-east-2" });
    const blind = await verifySharded(store, "old", store, B("public"), {
      deep: true,
      newBuckets: split.destBuckets,
    });
    expect(blind.ok).toBe(true);
  });

  it("verify WITH the assertion catches the misroute (private object found only in public)", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old");
    await store.put("old", md5ToKey(EARNIN, "v2"), "payroll");
    await store.ensureBucket(B("public"));
    await store.put(B("public"), md5ToKey(EARNIN, "v2"), "payroll");

    const split = buildSplitMapping({ gitEntries: [entry(EARNIN, "Earnin")], region: "us-east-2" });
    const vr = await verifySharded(store, "old", store, B("public"), {
      deep: true,
      newBuckets: split.destBuckets,
      expectBucketByMd5: split.predictBucket,
    });

    expect(vr.ok).toBe(false);
    const gap = vr.missing.find((m) => m.md5 === EARNIN);
    expect(gap?.reason).toBe("misrouted");
    expect(gap?.expectedBucket).toBe(B("earnin"));
    expect(gap?.foundBuckets).toEqual([B("public")]);
  });

  it("delete REFUSES (throws) when an object is misrouted — OLD is not destroyed", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old");
    await store.put("old", md5ToKey(EARNIN, "v2"), "payroll");
    await store.ensureBucket(B("public"));
    await store.put(B("public"), md5ToKey(EARNIN, "v2"), "payroll");

    const split = buildSplitMapping({ gitEntries: [entry(EARNIN, "Earnin")], region: "us-east-2" });
    await expect(
      deleteOldSharded(store, "old", B("public"), {
        deep: true,
        dryRun: false,
        newBuckets: split.destBuckets,
        expectBucketByMd5: split.predictBucket,
      }),
    ).rejects.toBeInstanceOf(VerificationGapError);
    expect((await store.list("old")).length).toBe(1);
  });
});

describe("private-provider routing with no real data (Phase D synthetic round-trip)", () => {
  it("scatters synthetic private-provider objects to their per-provider buckets and verifies", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old");
    await store.put("old", md5ToKey(EARNIN, "v2"), "e-bytes");
    await store.put("old", md5ToKey(PAYCHEX, "v2"), "p-bytes");
    await store.put("old", md5ToKey(UNREF, "v2"), "u-bytes");

    const split = buildSplitMapping({
      gitEntries: [entry(EARNIN, "Earnin"), entry(PAYCHEX, "Paychex")],
      region: "us-east-2",
    });

    const rep = await migrateSharded({
      store,
      oldBucket: "old",
      newBucket: split.destBuckets[0]!,
      resolve: split.resolve,
      deep: true,
    });

    expect(rep.verify.ok).toBe(true);

    expect((await store.list(B("earnin"))).map((o) => o.key)).toEqual([md5ToKey(EARNIN, "v2")]);
    expect((await store.list(B("paychex"))).map((o) => o.key)).toEqual([md5ToKey(PAYCHEX, "v2")]);
    expect((await store.list(B("public"))).map((o) => o.key)).toEqual([md5ToKey(UNREF, "v2")]);
  });
});
