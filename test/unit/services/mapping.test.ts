import { describe, expect, it } from "vitest";
import { bucketName } from "../../../src/config/sources.js";
import { md5ToKey } from "../../../src/domain/dvcKey.js";
import type { GitDvcEntry } from "../../../src/ports/gitHistory.js";
import {
  MappingValidationError,
  assertMappingValid,
  buildMapping,
  resolveDirMembers,
} from "../../../src/services/mapping.js";
import { FakeObjectStore } from "../../support/fakeObjectStore.js";

const A = "a0000000000000000000000000000001";
const B = "b0000000000000000000000000000002";
const D = "d0000000000000000000000000000003.dir";
const M1 = "10000000000000000000000000000004";
const M2 = "20000000000000000000000000000005";
const X = "90000000000000000000000000000006";
const Z = "c0000000000000000000000000000007";

const entry = (md5: string, rootDir: string): GitDvcEntry => ({
  md5,
  rootDir,
  path: `data/dvc/${rootDir}/f.dvc`,
  commit: "deadbeef",
});

const baseGit: GitDvcEntry[] = [
  entry(A, "Affinity"),
  entry(B, "Burning Glass"),
  entry(D, "CoinOut"),
];

const OHIO = (stub: string): string => bucketName(stub, "us-east-2");

const storeKeys = [
  md5ToKey(A, "v2"),
  md5ToKey(B, "v2"),
  md5ToKey(D, "v2"),
  md5ToKey(M1, "v2"),
  md5ToKey(M2, "v2"),
  md5ToKey(X, "v2"),
  "README.md",
];

describe("buildMapping", () => {
  it("routes objects to corrected bucket names and expands dir members", () => {
    const result = buildMapping({
      gitEntries: baseGit,
      storeKeys,
      region: "us-east-2",
      dirMembers: { [D]: [M1, M2] },
    });

    const byMd5 = new Map(result.mapped.map((m) => [m.md5, m.destBucket]));
    expect(byMd5.get(A)).toBe(OHIO("affinity"));
    expect(byMd5.get(B)).toBe(OHIO("lightcast"));
    expect(byMd5.get(D)).toBe(OHIO("coinout"));

    expect(byMd5.get(M1)).toBe(OHIO("coinout"));
    expect(byMd5.get(M2)).toBe(OHIO("coinout"));

    expect(byMd5.get(X)).toBe(OHIO("public"));

    expect(result.unreferencedKeys).toEqual([md5ToKey(X, "v2")]);
    expect(result.orphanMd5s).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.providerCounts[OHIO("coinout")]).toBe(3);
    expect(() => assertMappingValid(result)).not.toThrow();
  });

  it("fails loudly on a planted orphan md5 (git references it, store lacks it)", () => {
    const result = buildMapping({
      gitEntries: [...baseGit, entry(Z, "Affinity")],
      storeKeys,
      region: "us-east-2",
      dirMembers: { [D]: [M1, M2] },
    });
    expect(result.orphanMd5s).toContain(Z);
    expect(() => assertMappingValid(result)).toThrow(MappingValidationError);
  });

  it("detects an md5 mapped to two providers", () => {
    const result = buildMapping({
      gitEntries: [entry(A, "Affinity"), entry(A, "Zearn")],
      storeKeys: [md5ToKey(A, "v2")],
      region: "us-east-2",
    });
    expect(result.conflicts).toEqual([{ md5: A, providers: ["Affinity", "Zearn"] }]);
    expect(() => assertMappingValid(result)).toThrow(MappingValidationError);
  });
});

describe("resolveDirMembers", () => {
  it("reads .dir objects from the store and returns member md5s", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old");
    const dirKey = md5ToKey(D, "v2");
    await store.put(
      "old",
      dirKey,
      `[{"md5":"${M1}","relpath":"a.csv"},{"md5":"${M2}","relpath":"b/c.csv"}]`,
    );
    const members = await resolveDirMembers(
      store,
      "old",
      [dirKey, "README.md"],
      [D, "missing.dir"],
    );
    expect(members.members).toEqual({ [D]: [M1, M2] });
    expect(members.dirReadErrors).toEqual([]);
  });

  it("records (not throws on) a malformed .dir object and continues", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old");
    const goodKey = md5ToKey(D, "v2");
    const badMd5 = "e0000000000000000000000000000008.dir";
    const badKey = md5ToKey(badMd5, "v2");
    await store.put(
      "old",
      goodKey,
      `[{"md5":"${M1}","relpath":"a.csv"},{"md5":"${M2}","relpath":"b/c.csv"}]`,
    );

    await store.put("old", badKey, "[]");

    const result = await resolveDirMembers(store, "old", [goodKey, badKey], [D, badMd5]);

    expect(result.members).toEqual({ [D]: [M1, M2] });
    expect(result.dirReadErrors.map((e) => e.dirMd5)).toEqual([badMd5]);
  });
});

describe("buildMapping dirReadErrors", () => {
  it("fails assertMappingValid when a dir read error is threaded in", () => {
    const result = buildMapping({
      gitEntries: baseGit,
      storeKeys,
      region: "us-east-2",
      dirMembers: { [D]: [M1, M2] },
      dirReadErrors: [{ dirMd5: D, error: "empty .dir entries" }],
    });
    expect(result.dirReadErrors).toEqual([{ dirMd5: D, error: "empty .dir entries" }]);
    expect(() => assertMappingValid(result)).toThrow(MappingValidationError);
  });
});
