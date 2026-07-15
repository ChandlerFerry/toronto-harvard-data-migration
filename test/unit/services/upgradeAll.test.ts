import { describe, expect, it } from "vitest";
import { parseDotDvc } from "../../../src/domain/dotDvcFile.js";
import { type UpgradeAllDeps, upgradeAll } from "../../../src/services/upgrade.js";

const MD5_A = "aa11111111111111111111111111111a";
const MD5_B = "bb22222222222222222222222222222b";
const MD5_C = "cc33333333333333333333333333333c";

const SUB = "data/dvc";
const REPO = "/repo";
const P_V2 = `${REPO}/${SUB}/Affinity/a.csv.dvc`;
const P_V3 = `${REPO}/${SUB}/UI Claims/raw.dvc`;
const P_V1 = `${REPO}/${SUB}/Kronos/c.csv.dvc`;

const v2 = (md5: string) => `outs:\n- md5: ${md5}\n  size: 703808\n  path: a.csv\n`;
const v3 = (md5: string) =>
  `outs:\n- md5: ${md5}.dir\n  size: 8566368\n  nfiles: 5\n  path: raw\n  hash: md5\n`;
const v1 = (md5: string) => `md5: deadbeef\nouts:\n- md5: ${md5}\n  path: c.csv\n`;

function makeDeps(files: Map<string, string>): UpgradeAllDeps {
  return {
    listDvcFiles: () => Promise.resolve([...files.keys()]),
    readFile: (p) => Promise.resolve(files.get(p) ?? ""),
    writeFile: (p, c) => {
      files.set(p, c);
      return Promise.resolve();
    },
  };
}

describe("upgradeAll (pure-YAML v2 -> v3 upgrade)", () => {
  it("upgrades v2 files (md5 preserved), skips v3, and fails loud on v1", async () => {
    const files = new Map([
      [P_V2, v2(MD5_A)],
      [P_V3, v3(MD5_B)],
      [P_V1, v1(MD5_C)],
    ]);
    const result = await upgradeAll(makeDeps(files), REPO, SUB, { continueOnError: true });

    expect(result.upgraded).toBe(1);
    expect(result.alreadyV3).toBe(1);
    expect(result.errors).toBe(1);

    const byPath = new Map(result.entries.map((e) => [e.path, e]));
    expect(byPath.get(P_V2)?.status).toBe("upgraded");
    expect(byPath.get(P_V3)?.status).toBe("already-v3");
    expect(byPath.get(P_V1)?.status).toBe("error");
    expect(byPath.get(P_V1)?.error).toMatch(/Unsupported .dvc feature: md5/);

    const upgraded = parseDotDvc(files.get(P_V2)!);
    expect(upgraded.version).toBe(3);
    expect(upgraded.md5).toBe(MD5_A);
    expect(files.get(P_V2)).toMatch(/hash: md5/);
  });

  it("throws on a v1 file by default (continueOnError unset)", async () => {
    const files = new Map([[P_V1, v1(MD5_C)]]);
    await expect(upgradeAll(makeDeps(files), REPO, SUB)).rejects.toThrow(/Unsupported .dvc/);
  });

  it("dry-run reports the upgrade without writing the .dvc", async () => {
    const files = new Map([[P_V2, v2(MD5_A)]]);
    const before = files.get(P_V2);
    const result = await upgradeAll(makeDeps(files), REPO, SUB, { dryRun: true });
    expect(result.upgraded).toBe(1);
    expect(files.get(P_V2)).toBe(before);
  });
});
