import { describe, expect, it } from "vitest";
import {
  InvalidDirObjectError,
  dirMemberMd5s,
  parseDirObject,
} from "../../../src/domain/dirObject.js";

const M1 = "a16306e9fb74844af7af74fba2d606b9";
const M2 = "bb22222222222222222222222222222b";
const CONTENT = `[{"md5": "${M1}", "relpath": "covid_hosp.csv"}, {"md5": "${M2}", "relpath": "sub/x.csv"}]`;

describe("parseDirObject", () => {
  it("parses entries from a .dir object's JSON", () => {
    expect(parseDirObject(CONTENT)).toEqual([
      { md5: M1, relpath: "covid_hosp.csv" },
      { md5: M2, relpath: "sub/x.csv" },
    ]);
  });

  it("accepts Uint8Array input", () => {
    const bytes = new TextEncoder().encode(CONTENT);
    expect(dirMemberMd5s(bytes)).toEqual([M1, M2]);
  });

  it("dirMemberMd5s returns just the member hashes", () => {
    expect(dirMemberMd5s(CONTENT)).toEqual([M1, M2]);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseDirObject("{not json")).toThrow(InvalidDirObjectError);
  });

  it("rejects a non-array document", () => {
    expect(() => parseDirObject('{"md5":"x"}')).toThrow(InvalidDirObjectError);
  });

  it("rejects an entry whose md5 is not 32-hex", () => {
    expect(() => parseDirObject('[{"md5":"nothex","relpath":"a"}]')).toThrow(InvalidDirObjectError);
  });

  it("rejects an empty .dir array (truncated/corrupt object)", () => {
    expect(() => parseDirObject("[]")).toThrow(InvalidDirObjectError);
    expect(() => dirMemberMd5s("[]")).toThrow(InvalidDirObjectError);
  });
});
