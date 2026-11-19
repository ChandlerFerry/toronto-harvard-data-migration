import { describe, expect, it } from "vitest";
import { loadConfigFile } from "../../../src/config/configFile.js";
import { RETINA_CONFIG_PATH } from "../../support/config.js";

describe("config/retina-routing.json (the committed config file)", () => {
  it("loads, and reports its path and checksum", async () => {
    const loaded = await loadConfigFile(RETINA_CONFIG_PATH);

    expect(loaded.path).toBe(RETINA_CONFIG_PATH);
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("defines exactly the 11 TF-canonical providers", async () => {
    const { config } = await loadConfigFile(RETINA_CONFIG_PATH);

    expect([...config.providers].sort()).toEqual([
      "affinity",
      "coinout",
      "earnin",
      "homebase",
      "intuit",
      "kronos",
      "lightcast",
      "paychex",
      "public",
      "womply",
      "zearn",
    ]);
  });

  it("homebase routes to its own bucket, not public (resolves runbook open-Q #2)", async () => {
    const { config } = await loadConfigFile(RETINA_CONFIG_PATH);

    expect(config.folders.Homebase).toBe("homebase");
  });

  it("uses the authoritative CoinOut spelling, never the buggy cointout", async () => {
    const { config } = await loadConfigFile(RETINA_CONFIG_PATH);

    expect(config.folders.CoinOut).toBe("coinout");
    expect(Object.keys(config.folders)).not.toContain("CointOut");
    expect(Object.values(config.folders)).not.toContain("cointout");
    expect(config.isProvider("cointout")).toBe(false);
  });

  it("ignores the zero-byte file and the empty directory listing, and pins nothing", async () => {
    const { config } = await loadConfigFile(RETINA_CONFIG_PATH);

    expect([...config.ignoredMd5s]).toEqual([
      "d41d8cd98f00b204e9800998ecf8427e",
      "d751713988987e9331980363e24189ce.dir",
    ]);
    expect(config.conflictWinners.size).toBe(0);
  });
});

describe("loadConfigFile", () => {
  it("names the file when it cannot be read", async () => {
    await expect(loadConfigFile("no/such/config.json")).rejects.toThrow(/no.such.config\.json/);
  });
});
