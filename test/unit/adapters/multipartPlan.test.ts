import { describe, expect, it } from "vitest";
import { MAX_PARTS, MIN_PART_BYTES, planCopyParts } from "../../../src/adapters/multipartPlan.js";

describe("planCopyParts", () => {
  it("splits a 12 MiB object into contiguous parts (last one smaller)", () => {
    const partSize = 5 * 1024 * 1024;
    const parts = planCopyParts(12 * 1024 * 1024, partSize);
    expect(parts).toEqual([
      { partNumber: 1, start: 0, end: 5 * 1024 * 1024 - 1 },
      { partNumber: 2, start: 5 * 1024 * 1024, end: 10 * 1024 * 1024 - 1 },
      { partNumber: 3, start: 10 * 1024 * 1024, end: 12 * 1024 * 1024 - 1 },
    ]);
  });

  it("produces fully contiguous ranges that cover [0, size)", () => {
    const size = 7 * 1024 * 1024 + 123;
    const parts = planCopyParts(size, MIN_PART_BYTES);
    expect(parts[0]!.start).toBe(0);
    expect(parts.at(-1)!.end).toBe(size - 1);
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]!.start).toBe(parts[i - 1]!.end + 1);
    }
  });

  it("never exceeds the 10,000-part limit (bumps part size for huge objects)", () => {
    const size = 5 * 1024 ** 4;
    const parts = planCopyParts(size, MIN_PART_BYTES);
    expect(parts.length).toBeLessThanOrEqual(MAX_PARTS);
    expect(parts.at(-1)!.end).toBe(size - 1);
  });

  it("honors a configured part size larger than the minimum", () => {
    const partSize = 1024 ** 3;
    const parts = planCopyParts(3 * 1024 ** 3, partSize);
    expect(parts.length).toBe(3);
  });

  it("single part for a size at/under one part", () => {
    const parts = planCopyParts(1024, 5 * 1024 * 1024);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ partNumber: 1, start: 0, end: 1023 });
  });
});
