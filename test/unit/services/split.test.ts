import { describe, expect, it } from "vitest";
import { bucketName } from "../../../src/config/sources.js";
import { md5ToKey } from "../../../src/domain/dvcKey.js";
import type { GitDvcEntry } from "../../../src/ports/gitHistory.js";
import { buildSplitMapping, expandDirMembers } from "../../../src/services/split.js";
import { FakeObjectStore } from "../../support/fakeObjectStore.js";

const OHIO = (stub: string): string => bucketName(stub, "us-east-2");

const A = "a0000000000000000000000000000001";
const B = "b0000000000000000000000000000002";
const C = "c0000000000000000000000000000003";
const D = "d0000000000000000000000000000004.dir";
const M1 = "10000000000000000000000000000005";

const entry = (md5: string, rootDir: string): GitDvcEntry => ({
  md5,
  rootDir,
  path: `data/dvc/${rootDir}/f.dvc`,
  commit: "deadbeef",
});

describe("buildSplitMapping", () => {
  it("builds a resolver that routes each md5 to its provider bucket (unmatched -> public)", () => {
    const { resolve } = buildSplitMapping({
      gitEntries: [entry(A, "Affinity"), entry(B, "CoinOut")],
      region: "us-east-2",
    });

    expect(resolve({ md5: A, sourceKey: md5ToKey(A, "v2") })).toEqual({
      destBucket: OHIO("affinity"),
      destKey: md5ToKey(A, "v2"),
    });
    expect(resolve({ md5: B, sourceKey: md5ToKey(B, "v3") }).destBucket).toBe(OHIO("coinout"));

    expect(resolve({ md5: C, sourceKey: md5ToKey(C, "v2") }).destBucket).toBe(OHIO("public"));
  });

  it("reports the distinct destination bucket set (always including public) for the verify/delete union", () => {
    const { destBuckets } = buildSplitMapping({
      gitEntries: [entry(A, "Affinity"), entry(B, "CoinOut")],
      region: "us-east-2",
    });
    expect(destBuckets).toEqual([OHIO("affinity"), OHIO("coinout"), OHIO("public")]);
  });

  it("expands dir members so they inherit the directory's provider", () => {
    const { resolve } = buildSplitMapping({
      gitEntries: [entry(D, "CoinOut")],
      dirMembers: { [D]: [M1] },
      region: "us-east-2",
    });
    expect(resolve({ md5: M1, sourceKey: md5ToKey(M1, "v2") }).destBucket).toBe(OHIO("coinout"));
  });

  it("surfaces an md5 mapped to two providers as a conflict (ambiguous routing)", () => {
    const { conflicts } = buildSplitMapping({
      gitEntries: [entry(A, "Affinity"), entry(A, "Zearn")],
      region: "us-east-2",
    });
    expect(conflicts).toEqual([{ md5: A, providers: ["Affinity", "Zearn"] }]);
  });
});

describe("expandDirMembers", () => {
  it("reads .dir objects by their computed key (v3 or v2) without a full listing", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old");

    await store.put("old", md5ToKey(D, "v3"), `[{"md5":"${M1}","relpath":"a.csv"}]`);

    const result = await expandDirMembers(store, "old", [D]);
    expect(result.members).toEqual({ [D]: [M1] });
    expect(result.dirReadErrors).toEqual([]);
  });

  it("records a dir-read error for a .dir hash absent from the store instead of throwing", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old");
    const result = await expandDirMembers(store, "old", [D]);
    expect(result.members).toEqual({});
    expect(result.dirReadErrors.map((e) => e.dirMd5)).toEqual([D]);
  });
});
