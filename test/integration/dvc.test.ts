import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DvcCliChild } from "../../src/adapters/dvcCliChild.js";

function dvcAvailable(): boolean {
  try {
    execFileSync("dvc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_DVC = dvcAvailable();

describe("dvc binary availability", () => {
  it("notes whether the real DVC integration can run", () => {
    if (!HAS_DVC) {
      console.warn("[dvc.test] dvc binary not installed — real DVC integration skipped.");
    }
    expect(typeof HAS_DVC).toBe("boolean");
  });
});

describe.skipIf(!HAS_DVC)("DvcCliChild against the real dvc binary", () => {
  it("ensureVersion3 succeeds on a v3+ install", async () => {
    await expect(new DvcCliChild().ensureVersion3()).resolves.toBeUndefined();
  });
});
