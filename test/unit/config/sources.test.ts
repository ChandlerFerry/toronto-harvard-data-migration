import { describe, expect, it } from "vitest";
import { ACCOUNTS, BUCKET_PREFIX, bucketName } from "../../../src/config/sources.js";

describe("config/sources canonical naming", () => {
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
  ] as const)("bucketName(%s, %s) -> %s", (source, region, expected) => {
    expect(bucketName(source, region)).toBe(expected);
  });

  it("account-regional names end with the mandatory -<accountId>-<region>-an marker", () => {
    expect(bucketName("affinity", "us-east-2")).toMatch(/^dvc-affinity-305901448049-us-east-2-an$/);
  });
});
