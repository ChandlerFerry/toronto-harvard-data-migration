import { describe, expect, it } from "vitest";
import { Md5ChangedError, parseDotDvc } from "../../../src/domain/dotDvcFile.js";
import {
  DvcStatusNotCleanError,
  NotVersion3Error,
  type RepointDeps,
  repointDvcFile,
} from "../../../src/services/upgrade.js";

const MD5 = "aa11111111111111111111111111111a";
const OTHER = "bb22222222222222222222222222222b";
const DVC_PATH = "/repo/data/dvc/Affinity/data.csv.dvc";

const V2 = `outs:\n- md5: ${MD5}\n  size: 10\n  path: data.csv\n`;
const v3With = (md5: string) => `outs:\n- md5: ${md5}\n  size: 10\n  hash: md5\n  path: data.csv\n`;
const V2_AGAIN = V2;

interface Harness {
  deps: RepointDeps;
  files: Map<string, string>;
  addCalls: string[];
}

function makeHarness(afterAddContent: string, statusClean = true): Harness {
  const files = new Map<string, string>([[DVC_PATH, V2]]);
  const addCalls: string[] = [];
  const deps: RepointDeps = {
    dvc: {
      ensureVersion3: () => Promise.resolve(),
      status: (_target, _opts) =>
        Promise.resolve({ clean: statusClean, payload: statusClean ? {} : { x: 1 } }),
      add: (target) => {
        addCalls.push(target);
        files.set(DVC_PATH, afterAddContent);
        return Promise.resolve();
      },
    },
    readFile: (p) => Promise.resolve(files.get(p) ?? ""),
    writeFile: (p, c) => {
      files.set(p, c);
      return Promise.resolve();
    },
    unlink: (p) => {
      files.delete(p);
      return Promise.resolve();
    },
  };
  return { deps, files, addCalls };
}

describe("repointDvcFile", () => {
  it("upgrades v2 -> v3, preserves md5, and injects the remote", async () => {
    const h = makeHarness(v3With(MD5));
    const result = await repointDvcFile(h.deps, DVC_PATH, "ohio-affinity");
    expect(result).toEqual({ md5: MD5, version: 3, remote: "ohio-affinity" });

    expect(h.addCalls).toEqual(["/repo/data/dvc/Affinity/data.csv"]);

    const written = parseDotDvc(h.files.get(DVC_PATH)!);
    expect(written.remote).toBe("ohio-affinity");
    expect(written.version).toBe(3);
    expect(written.md5).toBe(MD5);
  });

  it("throws Md5ChangedError if the rewrite changes the hash", async () => {
    const h = makeHarness(v3With(OTHER));
    await expect(repointDvcFile(h.deps, DVC_PATH, "r")).rejects.toBeInstanceOf(Md5ChangedError);
  });

  it("throws NotVersion3Error if the rewrite stays v2", async () => {
    const h = makeHarness(V2_AGAIN);
    await expect(repointDvcFile(h.deps, DVC_PATH, "r")).rejects.toBeInstanceOf(NotVersion3Error);
  });

  it("aborts when dvc status is not clean", async () => {
    const h = makeHarness(v3With(MD5), false);
    await expect(repointDvcFile(h.deps, DVC_PATH, "r")).rejects.toBeInstanceOf(
      DvcStatusNotCleanError,
    );
  });

  it("can skip the status check", async () => {
    const h = makeHarness(v3With(MD5), false);
    const result = await repointDvcFile(h.deps, DVC_PATH, "r", { skipStatusCheck: true });
    expect(result.version).toBe(3);
  });
});
