import { describe, expect, it } from "vitest";
import { type ObjectMeta, diffByMd5 } from "../../../src/domain/diff.js";
import { md5ToKey } from "../../../src/domain/dvcKey.js";

const A = "aa11111111111111111111111111111a";
const B = "bb22222222222222222222222222222b";
const C = "cc33333333333333333333333333333c";
const DIR = "dd44444444444444444444444444444d.dir";

const obj = (hash: string, size: number, layout: "v2" | "v3" = "v2"): ObjectMeta => ({
  key: md5ToKey(hash, layout),
  size,
});

describe("diffByMd5", () => {
  it("matches identical key sets with equal sizes", () => {
    const old = [obj(A, 10), obj(B, 20)];
    const neu = [obj(A, 10), obj(B, 20)];
    const r = diffByMd5(old, neu);
    expect(r.matched.sort()).toEqual([obj(A, 10).key, obj(B, 20).key].sort());
    expect(r.missing).toEqual([]);
    expect(r.extra).toEqual([]);
  });

  it("tolerates v2-old vs v3-new layout for the same md5", () => {
    const old = [obj(A, 10, "v2")];
    const neu = [obj(A, 10, "v3")];
    const r = diffByMd5(old, neu);
    expect(r.missing).toEqual([]);
    expect(r.matched).toEqual([obj(A, 10, "v2").key]);
  });

  it("reports an absent old object as missing", () => {
    const old = [obj(A, 10), obj(B, 20)];
    const neu = [obj(A, 10)];
    const r = diffByMd5(old, neu);
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]).toMatchObject({ md5: B, reason: "absent", oldSize: 20 });
  });

  it("reports a size mismatch as missing (not matched)", () => {
    const old = [obj(A, 10)];
    const neu = [obj(A, 999)];
    const r = diffByMd5(old, neu);
    expect(r.matched).toEqual([]);
    expect(r.missing[0]).toMatchObject({
      md5: A,
      reason: "size-mismatch",
      oldSize: 10,
      newSize: 999,
    });
  });

  it("lists new objects not referenced by old as extra", () => {
    const old = [obj(A, 10)];
    const neu = [obj(A, 10), obj(C, 30)];
    const r = diffByMd5(old, neu);
    expect(r.extra).toEqual([obj(C, 30).key]);
  });

  it("does not mask a corrupt same-md5 copy hidden under the other layout", () => {
    const old = [obj(A, 100, "v2")];

    const neu = [obj(A, 50, "v2"), obj(A, 100, "v3")];
    const r = diffByMd5(old, neu);
    expect(r.matched).toEqual([]);
    expect(r.missing[0]).toMatchObject({ md5: A, reason: "size-mismatch", oldSize: 100 });
  });

  it("flags the corrupt copy regardless of NEW listing order", () => {
    const old = [obj(A, 100, "v2")];
    const neu = [obj(A, 100, "v3"), obj(A, 50, "v2")];
    expect(diffByMd5(old, neu).matched).toEqual([]);
  });

  it("carries .dir directory objects like leaf objects", () => {
    const old = [obj(DIR, 5)];
    const neu = [obj(DIR, 5, "v3")];
    const r = diffByMd5(old, neu);
    expect(r.matched).toEqual([obj(DIR, 5).key]);
    expect(r.missing).toEqual([]);
  });
});
