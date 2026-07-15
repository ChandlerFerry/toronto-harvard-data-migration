import { describe, expect, it } from "vitest";
import { dvcNotFoundError } from "../../../src/adapters/dvcCliChild.js";

describe("dvcNotFoundError", () => {
  it("maps a spawn ENOENT into an actionable install message", () => {
    const enoent = Object.assign(new Error("spawn dvc ENOENT"), { code: "ENOENT" });
    const mapped = dvcNotFoundError(enoent);
    expect(mapped).toBeInstanceOf(Error);
    expect(mapped?.message).toMatch(/DVC CLI not found/);
    expect(mapped?.message).toMatch(/dvc\.org\/doc\/install/);
  });

  it("returns null for non-ENOENT failures so the caller rethrows the original", () => {
    expect(dvcNotFoundError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBeNull();
    expect(dvcNotFoundError(new Error("plain error"))).toBeNull();
    expect(dvcNotFoundError(undefined)).toBeNull();
  });
});
