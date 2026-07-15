import { describe, expect, it } from "vitest";
import { bucketName } from "../../../src/config/sources.js";
import {
  PROVIDER_FOLDER_SUFFIX,
  UNMATCHED_SUFFIX,
  folderToSuffix,
  generateBucketName,
  isKnownFolder,
} from "../../../src/domain/providerMap.js";

describe("folderToSuffix", () => {
  it.each([
    ["Affinity", "affinity"],
    ["Burning Glass", "lightcast"],
    ["Lightcast", "lightcast"],
    ["CoinOut", "coinout"],
    ["Earnin", "earnin"],
    ["Homebase", "homebase"],
    ["Intuit", "intuit"],
    ["Kronos", "kronos"],
    ["Paychex", "paychex"],
    ["Womply", "womply"],
    ["Zearn", "zearn"],
    ["JOLTS", "public"],
    ["public", "public"],
  ])("%s -> %s", (folder, suffix) => {
    expect(folderToSuffix(folder)).toBe(suffix);
  });

  it.each(["Unknown", "", "Not A Real Folder", "earnin-typo"])(
    "truly-unknown %s -> public (fallback)",
    (folder) => {
      expect(folderToSuffix(folder)).toBe(UNMATCHED_SUFFIX);
    },
  );

  it.each([
    ["affinity", "affinity"],
    ["AFFINITY", "affinity"],
    ["  Affinity  ", "affinity"],
    ["burning glass", "lightcast"],
    ["BURNING GLASS", "lightcast"],
    ["coinout", "coinout"],
    ["lightcast", "lightcast"],
    ["homebase", "homebase"],
  ])(
    "normalizes casing/whitespace of a KNOWN folder %s -> %s (not the public fallback)",
    (folder, suffix) => {
      expect(folderToSuffix(folder)).toBe(suffix);
    },
  );

  it("never emits the buggy cointout spelling", () => {
    expect(Object.values(PROVIDER_FOLDER_SUFFIX)).not.toContain("cointout");
  });
});

describe("isKnownFolder", () => {
  it.each(["Affinity", "Homebase", "CoinOut", "JOLTS", "  Earnin  ", "BURNING GLASS"])(
    "true for a known folder (a JSON key, after trim/case normalization): %s",
    (folder) => {
      expect(isKnownFolder(folder)).toBe(true);
    },
  );

  it.each(["CointOut", "Unknown", "", "public", "earnin-typo", "Burning  Glass"])(
    "false for a folder absent from the authoritative map: %s",
    (folder) => {
      expect(isKnownFolder(folder)).toBe(false);
    },
  );

  it("a folder can resolve to public by FALLBACK yet not be known", () => {
    expect(folderToSuffix("Unknown")).toBe("public");
    expect(isKnownFolder("Unknown")).toBe(false);
  });
});

describe("generateBucketName", () => {
  it.each([
    ["CoinOut", "us-east-1", "coinout"],
    ["CoinOut", "us-east-2", "coinout"],
    ["Burning Glass", "us-east-2", "lightcast"],
    ["Homebase", "us-east-2", "homebase"],
    ["Affinity", "us-east-1", "affinity"],
    ["Definitely Unknown", "us-east-2", "public"],
  ] as const)("(%s, %s) routes to %s", (folder, region, expectedSuffix) => {
    expect(generateBucketName(folder, region)).toBe(bucketName(expectedSuffix, region));
  });
});
