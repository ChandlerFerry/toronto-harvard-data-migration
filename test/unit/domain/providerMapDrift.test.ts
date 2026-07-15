import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSource } from "../../../src/config/sources.js";
import { PROVIDER_FOLDER_SUFFIX } from "../../../src/domain/providerMap.js";

const JSON_PATH =
  process.env.DATA_DIR_MAP ?? join(process.cwd(), "..", "data-dir-to-s3-stub-mapping.json");
const HAS_JSON = existsSync(JSON_PATH);

if (!HAS_JSON) {
  console.warn(`[providerMapDrift] ${JSON_PATH} not found — provider-map drift check skipped.`);
}

function loadJson(): Record<string, string> {
  return JSON.parse(readFileSync(JSON_PATH, "utf8")) as Record<string, string>;
}

describe.skipIf(!HAS_JSON)("provider map matches the authoritative JSON", () => {
  it("PROVIDER_FOLDER_SUFFIX is exactly the JSON (no drift)", () => {
    expect(PROVIDER_FOLDER_SUFFIX).toEqual(loadJson());
  });

  it("every mapped suffix is a canonical SOURCE (no bucket that does not exist)", () => {
    for (const suffix of Object.values(PROVIDER_FOLDER_SUFFIX)) {
      expect(isSource(suffix), `suffix "${suffix}" is not a canonical source`).toBe(true);
    }
  });
});

describe("provider map adoption invariants", () => {
  it("homebase routes to its own bucket, not public (resolves runbook open-Q #2)", () => {
    expect(PROVIDER_FOLDER_SUFFIX.Homebase).toBe("homebase");
  });

  it("uses the authoritative CoinOut spelling, never the buggy cointout", () => {
    expect(PROVIDER_FOLDER_SUFFIX.CoinOut).toBe("coinout");
    expect(Object.keys(PROVIDER_FOLDER_SUFFIX)).not.toContain("CointOut");
    expect(Object.values(PROVIDER_FOLDER_SUFFIX)).not.toContain("cointout");
  });
});
