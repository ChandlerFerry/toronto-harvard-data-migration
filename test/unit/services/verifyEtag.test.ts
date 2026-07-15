import { describe, expect, it } from "vitest";
import { md5ToKey } from "../../../src/domain/dvcKey.js";
import type { ListedObject, ObjectStore } from "../../../src/ports/objectStore.js";
import { verify } from "../../../src/services/verify.js";

const M = "aa11111111111111111111111111111a";
const PLAIN_MD5_A = "0123456789abcdef0123456789abcdef";
const PLAIN_MD5_B = "fedcba9876543210fedcba9876543210";
const COMPOSITE = "d41d8cd98f00b204e9800998ecf8427e-3";

function listStore(buckets: Record<string, ListedObject[]>): ObjectStore {
  const reject = () => Promise.reject(new Error("unsupported in listStore"));
  return {
    list: (b: string) => Promise.resolve(buckets[b] ?? []),
    ensureBucket: () => Promise.resolve(),
    put: reject,
    head: reject,
    getBytes: reject,
    copy: reject,
    deleteBatch: reject,
  } as unknown as ObjectStore;
}

describe("deep verify — multipart ETag tolerance (C2)", () => {
  it("does NOT flag a multipart-source object whose copy has a single-part ETag", async () => {
    const store = listStore({
      old: [{ key: md5ToKey(M, "v2"), size: 100, etag: COMPOSITE }],
      new: [{ key: md5ToKey(M, "v3"), size: 100, etag: PLAIN_MD5_A }],
    });
    const r = await verify(store, "old", store, "new", { deep: true });
    expect(r.ok).toBe(true);
    expect(r.matched.length).toBe(1);
    expect(r.deepEtagSkipped).toBe(1);
  });

  it("still flags a genuine single-part ETag mismatch", async () => {
    const store = listStore({
      old: [{ key: md5ToKey(M, "v2"), size: 100, etag: PLAIN_MD5_A }],
      new: [{ key: md5ToKey(M, "v2"), size: 100, etag: PLAIN_MD5_B }],
    });
    const r = await verify(store, "old", store, "new", { deep: true });
    expect(r.ok).toBe(false);
    expect(r.missing).toHaveLength(1);
  });

  it("labels a deep-verify corruption as etag-mismatch, not a fabricated size-mismatch", async () => {
    const store = listStore({
      old: [{ key: md5ToKey(M, "v2"), size: 100, etag: PLAIN_MD5_A }],
      new: [{ key: md5ToKey(M, "v2"), size: 100, etag: PLAIN_MD5_B }],
    });
    const r = await verify(store, "old", store, "new", { deep: true });
    expect(r.missing).toHaveLength(1);
    const m = r.missing[0]!;
    expect(m.reason).toBe("etag-mismatch");
    expect(m.oldSize).toBe(100);

    expect(m.newSize).toBeUndefined();
  });

  it("byte-verifies matching single-part ETags (deepEtagSkipped stays 0)", async () => {
    const store = listStore({
      old: [{ key: md5ToKey(M, "v2"), size: 100, etag: PLAIN_MD5_A }],
      new: [{ key: md5ToKey(M, "v3"), size: 100, etag: PLAIN_MD5_A }],
    });
    const r = await verify(store, "old", store, "new", { deep: true });
    expect(r.ok).toBe(true);
    expect(r.deepEtagSkipped).toBe(0);
  });

  it("does NOT silently trust a NEW copy whose listing omits the ETag (fails open otherwise)", async () => {
    const store = listStore({
      old: [{ key: md5ToKey(M, "v2"), size: 100, etag: PLAIN_MD5_A }],
      new: [{ key: md5ToKey(M, "v2"), size: 100, etag: "" }],
    });
    const r = await verify(store, "old", store, "new", { deep: true });
    expect(r.ok).toBe(false);
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]!.reason).toBe("etag-mismatch");
  });

  it("does NOT silently trust size when the OLD listing omits the ETag but NEW is verifiable", async () => {
    const store = listStore({
      old: [{ key: md5ToKey(M, "v2"), size: 100, etag: "" }],
      new: [{ key: md5ToKey(M, "v3"), size: 100, etag: PLAIN_MD5_A }],
    });
    const r = await verify(store, "old", store, "new", { deep: true });
    expect(r.ok).toBe(false);
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]!.reason).toBe("etag-mismatch");

    expect(r.deepEtagSkipped).toBe(0);
  });

  it("tolerates a missing OLD ETag when NEW carries only a composite (multipart) ETag", async () => {
    const store = listStore({
      old: [{ key: md5ToKey(M, "v2"), size: 100, etag: "" }],
      new: [{ key: md5ToKey(M, "v3"), size: 100, etag: COMPOSITE }],
    });
    const r = await verify(store, "old", store, "new", { deep: true });
    expect(r.ok).toBe(true);
    expect(r.matched).toHaveLength(1);
    expect(r.deepEtagSkipped).toBe(1);
  });
});
