import { describe, expect, it } from "vitest";
import { bucketName } from "../../../src/config/sources.js";
import { md5ToKey } from "../../../src/domain/dvcKey.js";
import type { GitDvcEntry } from "../../../src/ports/gitHistory.js";
import {
  MappingValidationError,
  assertMappingValid,
  buildMapping,
  resolveProviderByMd5,
} from "../../../src/services/mapping.js";
import { expandDirMembers } from "../../../src/services/split.js";
import { retinaConfig } from "../../support/config.js";
import { FakeObjectStore } from "../../support/fakeObjectStore.js";

const A = "a0000000000000000000000000000001";
const B = "b0000000000000000000000000000002";
const D = "d0000000000000000000000000000003.dir";
const M1 = "10000000000000000000000000000004";
const M2 = "20000000000000000000000000000005";
const X = "90000000000000000000000000000006";
const Z = "c0000000000000000000000000000007";
const EMPTY_FILE = "d41d8cd98f00b204e9800998ecf8427e";
const EMPTY_DIR = "d751713988987e9331980363e24189ce.dir";

const config = retinaConfig();
const pinned = (md5: string, folder: string) =>
  retinaConfig({ conflictWinners: [{ md5, folder, note: "test" }] });

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
      config,
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
      config,
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
      config,
      gitEntries: [entry(A, "Affinity"), entry(A, "Zearn")],
      storeKeys: [md5ToKey(A, "v2")],
      region: "us-east-2",
    });
    expect(result.conflicts).toEqual([{ md5: A, providers: ["Affinity", "Zearn"] }]);
    expect(() => assertMappingValid(result)).toThrow(MappingValidationError);
  });

  it("never routes an md5 on the ignore list, even when two providers name it", () => {
    const result = buildMapping({
      config,
      gitEntries: [
        entry(A, "Affinity"),
        entry(D, "CoinOut"),
        entry(EMPTY_FILE, "Earnin"),
        entry(EMPTY_FILE, "QCEW"),
        entry(EMPTY_DIR, "Earnin"),
        entry(EMPTY_DIR, "Homebase"),
      ],
      dirMembers: { [D]: [M1, EMPTY_FILE] },
      storeKeys: [A, D, M1, EMPTY_FILE, EMPTY_DIR].map((md5) => md5ToKey(md5, "v2")),
      region: "us-east-2",
    });
    expect(result.conflicts).toEqual([]);
    expect(result.orphanMd5s).toEqual([]);
    expect(result.unreferencedKeys).toEqual([
      md5ToKey(EMPTY_FILE, "v2"),
      md5ToKey(EMPTY_DIR, "v2"),
    ]);
    expect(() => assertMappingValid(result)).not.toThrow();
  });

  it("treats nothing as ignored when the ignore list is empty", () => {
    const result = buildMapping({
      config: retinaConfig({ ignoredMd5s: [] }),
      gitEntries: [entry(EMPTY_FILE, "Earnin"), entry(EMPTY_FILE, "QCEW")],
      storeKeys: [md5ToKey(EMPTY_FILE, "v2")],
      region: "us-east-2",
    });
    expect(result.conflicts).toEqual([{ md5: EMPTY_FILE, providers: ["Earnin", "QCEW"] }]);
  });
});

describe("winner list", () => {
  it("routes a listed md5 to its winner whatever order the folders are walked in", () => {
    for (const order of [
      ["Affinity", "Zearn"],
      ["Zearn", "Affinity"],
    ]) {
      const entries = order.map((folder) => entry(A, folder));
      const result = resolveProviderByMd5(entries, {}, pinned(A, "Zearn"));
      expect(result.conflicts).toEqual([]);
      expect(result.providerByMd5.get(A)).toBe("Zearn");
    }
  });

  it("routes the members of a listed .dir to the winner", () => {
    const entries = [entry(D, "Affinity"), entry(D, "CoinOut")];
    const result = resolveProviderByMd5(entries, { [D]: [M1, M2] }, pinned(D, "CoinOut"));
    expect(result.conflicts).toEqual([]);
    expect(result.providerByMd5.get(M1)).toBe("CoinOut");
    expect(result.providerByMd5.get(M2)).toBe("CoinOut");
  });

  it("still reports a conflict on an md5 that is not listed", () => {
    const entries = [entry(B, "Affinity"), entry(B, "Zearn")];
    const result = resolveProviderByMd5(entries, {}, pinned(A, "Zearn"));
    expect(result.conflicts).toEqual([{ md5: B, providers: ["Affinity", "Zearn"] }]);
  });

  it("sends a listed md5 to the winner's bucket through buildMapping", () => {
    const result = buildMapping({
      config: pinned(A, "Zearn"),
      gitEntries: [entry(A, "Affinity"), entry(A, "Zearn")],
      storeKeys: [md5ToKey(A, "v2")],
      region: "us-east-2",
    });
    expect(result.conflicts).toEqual([]);
    expect(result.mapped.map((m) => m.destBucket)).toEqual([OHIO("zearn")]);
    expect(() => assertMappingValid(result)).not.toThrow();
  });
});

describe("expandDirMembers (shared by map and migrate)", () => {
  it("reads .dir objects from the store and returns member md5s", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old");
    const dirKey = md5ToKey(D, "v2");
    await store.put(
      "old",
      dirKey,
      `[{"md5":"${M1}","relpath":"a.csv"},{"md5":"${M2}","relpath":"b/c.csv"}]`,
    );
    const members = await expandDirMembers(store, "old", [D], config.ignoredMd5s);
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

    const result = await expandDirMembers(store, "old", [D, badMd5], config.ignoredMd5s);

    expect(result.members).toEqual({ [D]: [M1, M2] });
    expect(result.dirReadErrors.map((e) => e.dirMd5)).toEqual([badMd5]);
  });

  it("skips a .dir on the ignore list instead of recording a read error", async () => {
    const store = new FakeObjectStore();
    await store.ensureBucket("old");
    await store.put("old", md5ToKey(EMPTY_DIR, "v2"), "[]");

    const result = await expandDirMembers(store, "old", [EMPTY_DIR], config.ignoredMd5s);

    expect(result).toEqual({ members: {}, missingDirs: [], dirReadErrors: [] });
  });
});

describe("buildMapping dirReadErrors", () => {
  it("fails assertMappingValid when a dir read error is threaded in", () => {
    const result = buildMapping({
      config,
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
