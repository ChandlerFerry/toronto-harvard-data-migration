import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { retinaConfig } from "../../support/config.js";

const JSON_PATH =
  process.env.DATA_DIR_MAP ?? join(process.cwd(), "..", "data-dir-to-s3-stub-mapping.json");
const HAS_JSON = existsSync(JSON_PATH);

if (!HAS_JSON) {
  console.warn(`[providerMapDrift] ${JSON_PATH} not found — provider-map drift check skipped.`);
}

function loadJson(): Record<string, string> {
  return JSON.parse(readFileSync(JSON_PATH, "utf8")) as Record<string, string>;
}

describe.skipIf(!HAS_JSON)("config/retina-routing.json matches the authoritative JSON", () => {
  it("its folder table is exactly the JSON (no drift)", () => {
    expect(retinaConfig().folders).toEqual(loadJson());
  });
});
