import { describe, expect, it } from "vitest";
import {
  InvalidHashError,
  InvalidKeyError,
  V3_PREFIX,
  detectLayout,
  isDirHash,
  isDirKey,
  isDvcObjectKey,
  isValidHash,
  isValidMd5,
  keyToMd5,
  md5ToKey,
  parseKey,
  tryKeyToMd5,
} from "../../../src/domain/dvcKey.js";

const MD5 = "cf57cd0bb66208ae44482bab397e6c42";
const DIR = "a1b2c3d4e5f60718293a4b5c6d7e8f90.dir";

describe("isValidMd5", () => {
  it("accepts 32 lowercase hex", () => {
    expect(isValidMd5(MD5)).toBe(true);
  });
  it.each([
    ["", "empty"],
    ["CF57CD0BB66208AE44482BAB397E6C42", "uppercase"],
    ["cf57cd0bb66208ae44482bab397e6c4", "31 chars"],
    ["cf57cd0bb66208ae44482bab397e6c422", "33 chars"],
    ["zf57cd0bb66208ae44482bab397e6c42", "non-hex"],
    [DIR, "dir-suffixed"],
  ])("rejects %s (%s)", (value) => {
    expect(isValidMd5(value)).toBe(false);
  });
});

describe("dir hashes", () => {
  it("isDirHash true only for <32hex>.dir", () => {
    expect(isDirHash(DIR)).toBe(true);
    expect(isDirHash(MD5)).toBe(false);
    expect(isDirHash("nothex.dir")).toBe(false);
  });
  it("isValidHash accepts both plain and .dir", () => {
    expect(isValidHash(MD5)).toBe(true);
    expect(isValidHash(DIR)).toBe(true);
    expect(isValidHash("bad")).toBe(false);
  });
});

describe("md5ToKey", () => {
  it("v2 layout splits 2/30", () => {
    expect(md5ToKey(MD5, "v2")).toBe("cf/57cd0bb66208ae44482bab397e6c42");
  });
  it("v3 layout prefixes files/md5/", () => {
    expect(md5ToKey(MD5, "v3")).toBe(`${V3_PREFIX}cf/57cd0bb66208ae44482bab397e6c42`);
  });
  it("preserves .dir suffix in v2", () => {
    expect(md5ToKey(DIR, "v2")).toBe("a1/b2c3d4e5f60718293a4b5c6d7e8f90.dir");
  });
  it("preserves .dir suffix in v3", () => {
    expect(md5ToKey(DIR, "v3")).toBe(`${V3_PREFIX}a1/b2c3d4e5f60718293a4b5c6d7e8f90.dir`);
  });
  it("throws on invalid hash", () => {
    expect(() => md5ToKey("bad", "v2")).toThrow(InvalidHashError);
  });
});

describe("parseKey / keyToMd5 / detectLayout", () => {
  it("parses v2 key", () => {
    expect(parseKey("cf/57cd0bb66208ae44482bab397e6c42")).toEqual({
      hash: MD5,
      layout: "v2",
      isDir: false,
    });
  });
  it("parses v3 key", () => {
    expect(parseKey(`${V3_PREFIX}cf/57cd0bb66208ae44482bab397e6c42`)).toEqual({
      hash: MD5,
      layout: "v3",
      isDir: false,
    });
  });
  it("parses v2 .dir key", () => {
    expect(parseKey("a1/b2c3d4e5f60718293a4b5c6d7e8f90.dir")).toEqual({
      hash: DIR,
      layout: "v2",
      isDir: true,
    });
  });
  it("keyToMd5 + detectLayout + isDirKey helpers", () => {
    const v3 = `${V3_PREFIX}cf/57cd0bb66208ae44482bab397e6c42`;
    expect(keyToMd5(v3)).toBe(MD5);
    expect(detectLayout(v3)).toBe("v3");
    expect(isDirKey(v3)).toBe(false);
    expect(isDirKey("a1/b2c3d4e5f60718293a4b5c6d7e8f90.dir")).toBe(true);
  });
  it.each([
    ["c/57cd0bb66208ae44482bab397e6c42", "slash not at pos 2"],
    ["cf57cd0bb66208ae44482bab397e6c42", "no slash"],
    ["cf/57cd0bb66208ae44482bab397e6c4", "short remainder"],
    ["cf/57cd/0bb66208ae44482bab397e6c", "extra slash"],
    ["files/md5/cf/zz7cd0bb66208ae44482bab397e6c42", "non-hex v3"],
    ["", "empty"],
  ])("throws InvalidKeyError on %s (%s)", (key) => {
    expect(() => keyToMd5(key)).toThrow(InvalidKeyError);
  });
});

describe("layout normalization", () => {
  it("v2 and v3 keys for same md5 resolve equal", () => {
    expect(keyToMd5(md5ToKey(MD5, "v2"))).toBe(keyToMd5(md5ToKey(MD5, "v3")));
    expect(keyToMd5(md5ToKey(DIR, "v2"))).toBe(keyToMd5(md5ToKey(DIR, "v3")));
  });
});

describe("tolerant helpers", () => {
  it("isDvcObjectKey discriminates valid vs junk", () => {
    expect(isDvcObjectKey("cf/57cd0bb66208ae44482bab397e6c42")).toBe(true);
    expect(isDvcObjectKey("README.md")).toBe(false);
  });
  it("tryKeyToMd5 returns null for junk", () => {
    expect(tryKeyToMd5("README.md")).toBeNull();
    expect(tryKeyToMd5("cf/57cd0bb66208ae44482bab397e6c42")).toBe(MD5);
  });
});
