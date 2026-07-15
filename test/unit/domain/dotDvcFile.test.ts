import { describe, expect, it } from "vitest";
import {
  InvalidDotDvcError,
  Md5ChangedError,
  UnsupportedDvcFeatureError,
  assertMd5Preserved,
  parseDotDvc,
  serializeDotDvc,
  setRemote,
  upgradeToV3,
} from "../../../src/domain/dotDvcFile.js";

const V2 = `outs:
- md5: aa11111111111111111111111111111a
  size: 1234
  path: data.csv
`;

const V3 = `outs:
- md5: aa11111111111111111111111111111a
  size: 1234
  hash: md5
  path: data.csv
`;

const V3_DIR = `outs:
- md5: dd44444444444444444444444444444d.dir
  size: 5678
  nfiles: 3
  hash: md5
  path: mydir
`;

describe("parseDotDvc — version detection", () => {
  it("detects v2 when no hash field", () => {
    const f = parseDotDvc(V2);
    expect(f.version).toBe(2);
    expect(f.md5).toBe("aa11111111111111111111111111111a");
    expect(f.path).toBe("data.csv");
    expect(f.size).toBe(1234);
    expect(f.isDir).toBe(false);
  });

  it("detects v3 when hash field present", () => {
    const f = parseDotDvc(V3);
    expect(f.version).toBe(3);
  });

  it("detects directory outs via .dir md5 + nfiles", () => {
    const f = parseDotDvc(V3_DIR);
    expect(f.isDir).toBe(true);
    expect(f.nfiles).toBe(3);
  });
});

describe("parseDotDvc — feature gate", () => {
  it("rejects wdir", () => {
    expect(() => parseDotDvc(`wdir: ..\n${V2}`)).toThrow(UnsupportedDvcFeatureError);
  });
  it("rejects deps", () => {
    expect(() => parseDotDvc(`deps:\n- path: x\n${V2}`)).toThrow(UnsupportedDvcFeatureError);
  });
  it("rejects top-level md5", () => {
    expect(() => parseDotDvc(`md5: abc\n${V2}`)).toThrow(UnsupportedDvcFeatureError);
  });
  it("rejects multiple outs", () => {
    const multi = `outs:
- md5: aa11111111111111111111111111111a
  path: a
- md5: bb22222222222222222222222222222b
  path: b
`;
    expect(() => parseDotDvc(multi)).toThrow(UnsupportedDvcFeatureError);
  });
  it("rejects missing outs", () => {
    expect(() => parseDotDvc("meta: hi\n")).toThrow(InvalidDotDvcError);
  });
  it("rejects non-object yaml", () => {
    expect(() => parseDotDvc("- 1\n- 2\n")).toThrow(InvalidDotDvcError);
  });
  it("rejects unparseable yaml", () => {
    expect(() => parseDotDvc("outs: [unclosed")).toThrow(InvalidDotDvcError);
  });
  it("rejects empty outs array", () => {
    expect(() => parseDotDvc("outs: []\n")).toThrow(InvalidDotDvcError);
  });
});

describe("parseDotDvc — optional fields", () => {
  it("parses an out with no size field", () => {
    const f = parseDotDvc("outs:\n- md5: aa11111111111111111111111111111a\n  path: data.csv\n");
    expect(f.size).toBeUndefined();
    expect(f.version).toBe(2);
  });
  it("flags isDir via nfiles even when md5 lacks the .dir suffix", () => {
    const f = parseDotDvc(
      "outs:\n- md5: aa11111111111111111111111111111a\n  path: mydir\n  hash: md5\n  nfiles: 2\n",
    );
    expect(f.isDir).toBe(true);
    expect(f.nfiles).toBe(2);
  });
});

describe("serializeDotDvc — round-trip", () => {
  it("parse -> serialize -> parse is stable for v3", () => {
    const f1 = parseDotDvc(V3);
    const out = serializeDotDvc(f1);
    const f2 = parseDotDvc(out);
    expect(f2.md5).toBe(f1.md5);
    expect(f2.version).toBe(3);
    expect(f2.path).toBe(f1.path);
  });
});

describe("setRemote", () => {
  it("injects a remote field on the single out", () => {
    const f = parseDotDvc(V3);
    const updated = setRemote(f, "ohio-coinout");
    expect(updated.remote).toBe("ohio-coinout");
    const reparsed = parseDotDvc(serializeDotDvc(updated));
    expect(reparsed.remote).toBe("ohio-coinout");

    expect(reparsed.md5).toBe(f.md5);
  });
});

describe("upgradeToV3", () => {
  it("adds `hash: md5` to a v2 out, preserving the md5/size/path", () => {
    const before = parseDotDvc(V2);
    const after = upgradeToV3(before);
    expect(after.version).toBe(3);
    expect(after.md5).toBe(before.md5);
    const reparsed = parseDotDvc(serializeDotDvc(after));
    expect(reparsed.version).toBe(3);
    expect(reparsed.md5).toBe(before.md5);
    expect(reparsed.size).toBe(before.size);
    expect(reparsed.path).toBe(before.path);
    expect(serializeDotDvc(after)).toMatch(/hash: md5/);
  });

  it("returns a v3 file unchanged", () => {
    const v3 = parseDotDvc(V3);
    expect(upgradeToV3(v3)).toBe(v3);
  });
});

describe("assertMd5Preserved", () => {
  it("passes when unchanged", () => {
    expect(() => assertMd5Preserved("abc", "abc")).not.toThrow();
  });
  it("throws Md5ChangedError when changed", () => {
    expect(() => assertMd5Preserved("abc", "def")).toThrow(Md5ChangedError);
  });
});
