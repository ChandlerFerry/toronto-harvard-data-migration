import { describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  BUCKET_PREFIX,
  SOURCES,
  bucketForSource,
  isSource,
} from "../../../src/config/sources.js";

describe("config/sources canonical naming", () => {
  it("defines exactly the 11 TF-canonical sources", () => {
    expect(SOURCES).toHaveLength(11);
    expect(new Set(SOURCES).size).toBe(11);
  });

  it("uses corrected source names (coinout, not cointout)", () => {
    expect(SOURCES).toContain("coinout");
    expect(SOURCES as readonly string[]).not.toContain("cointout");
  });

  it("includes homebase and public as sources", () => {
    expect(SOURCES).toContain("homebase");
    expect(SOURCES).toContain("public");
  });

  it("carries the correct old/new account IDs", () => {
    expect(ACCOUNTS.old).toBe("290048929476");
    expect(ACCOUNTS.new).toBe("305901448049");
  });

  it("uses the region-independent `dvc` prefix (both regions, per tracker-infra)", () => {
    expect(BUCKET_PREFIX).toBe("dvc");
  });

  it.each([
    ["coinout", "us-east-1", "dvc-coinout-305901448049-us-east-1-an"],
    ["coinout", "us-east-2", "dvc-coinout-305901448049-us-east-2-an"],
    ["lightcast", "us-east-2", "dvc-lightcast-305901448049-us-east-2-an"],
    ["public", "us-east-1", "dvc-public-305901448049-us-east-1-an"],
  ] as const)("bucketForSource(%s, %s) -> %s", (source, region, expected) => {
    expect(bucketForSource(source, region)).toBe(expected);
  });

  it("account-regional names end with the mandatory -<accountId>-<region>-an marker", () => {
    expect(bucketForSource("affinity", "us-east-2")).toMatch(
      /^dvc-affinity-305901448049-us-east-2-an$/,
    );
  });

  it("isSource narrows valid and rejects invalid names", () => {
    expect(isSource("coinout")).toBe(true);
    expect(isSource("cointout")).toBe(false);
    expect(isSource("nope")).toBe(false);
  });
});
