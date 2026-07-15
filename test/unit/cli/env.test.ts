import { describe, expect, it } from "vitest";
import { parseMaxAttempts } from "../../../src/cli/env.js";

describe("parseMaxAttempts", () => {
  it("returns a usable positive integer when valid", () => {
    expect(parseMaxAttempts("25")).toBe(25);
    expect(parseMaxAttempts("1")).toBe(1);
  });

  it("returns undefined when the env var is unset (so createS3Client default of 10 applies)", () => {
    expect(parseMaxAttempts(undefined)).toBeUndefined();
  });

  it.each(["foo", "", "   ", "-3", "abc"])(
    "returns undefined for malformed/non-positive value %j (never NaN/garbage)",
    (raw) => {
      expect(parseMaxAttempts(raw)).toBeUndefined();
    },
  );

  it("is lenient on trailing junk like the --concurrency parser (mirrors isPositiveInt + parseInt)", () => {
    expect(parseMaxAttempts("12abc")).toBe(12);
  });

  it("returns undefined for 0 so retries are not silently disabled", () => {
    expect(parseMaxAttempts("0")).toBeUndefined();
  });
});
