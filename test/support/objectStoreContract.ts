import pLimit from "p-limit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ObjectStore } from "../../src/ports/objectStore.js";

export interface ContractContext {
  store: ObjectStore;
  teardown?: () => Promise<void>;
}

export function objectStoreContract(
  label: string,
  makeContext: () => Promise<ContractContext>,
): void {
  describe(`ObjectStore contract: ${label}`, () => {
    let store: ObjectStore;
    let teardown: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      const ctx = await makeContext();
      store = ctx.store;
      teardown = ctx.teardown;
    });

    afterAll(async () => {
      await teardown?.();
    });

    it("put then head returns size and md5-hex etag", async () => {
      await store.ensureBucket("c-basic");
      const body = "hello dvc world";
      await store.put("c-basic", "ab/cdef", body);
      const head = await store.head("c-basic", "ab/cdef");
      expect(head.size).toBe(new TextEncoder().encode(body).byteLength);
      expect(head.etag).toMatch(/^[0-9a-f]{32}$/);
    });

    it("list returns objects and honors a prefix", async () => {
      await store.ensureBucket("c-list");
      await store.put("c-list", "files/md5/aa/1", "1");
      await store.put("c-list", "files/md5/bb/2", "22");
      await store.put("c-list", "other/zz", "333");
      const all = await store.list("c-list");
      expect(all.map((o) => o.key).sort()).toEqual([
        "files/md5/aa/1",
        "files/md5/bb/2",
        "other/zz",
      ]);
      const pref = await store.list("c-list", "files/md5/");
      expect(pref.map((o) => o.key).sort()).toEqual(["files/md5/aa/1", "files/md5/bb/2"]);
    });

    it("server-side copy preserves bytes and etag", async () => {
      await store.ensureBucket("c-old");
      await store.ensureBucket("c-new");
      const body = "content-addressed-bytes";
      await store.put("c-old", "cf/57", body);
      await store.copy({
        sourceBucket: "c-old",
        sourceKey: "cf/57",
        destBucket: "c-new",
        destKey: "files/md5/cf/57",
      });
      const srcHead = await store.head("c-old", "cf/57");
      const dstHead = await store.head("c-new", "files/md5/cf/57");
      expect(dstHead.size).toBe(srcHead.size);
      expect(dstHead.etag).toBe(srcHead.etag);
      const bytes = await store.getBytes("c-new", "files/md5/cf/57");
      expect(new TextDecoder().decode(bytes)).toBe(body);
    });

    it("deleteBatch removes the targeted keys", async () => {
      await store.ensureBucket("c-del");
      await store.put("c-del", "k1", "a");
      await store.put("c-del", "k2", "b");
      await store.put("c-del", "k3", "c");
      await store.deleteBatch("c-del", ["k1", "k3"]);
      const remaining = (await store.list("c-del")).map((o) => o.key);
      expect(remaining).toEqual(["k2"]);
    });

    it("deleteBatch is a no-op on empty input", async () => {
      await store.ensureBucket("c-empty");
      await store.put("c-empty", "keep", "x");
      await store.deleteBatch("c-empty", []);
      expect((await store.list("c-empty")).map((o) => o.key)).toEqual(["keep"]);
    });

    it("paginates a listing beyond 1000 keys", async () => {
      await store.ensureBucket("c-page");
      const limit = pLimit(64);
      const n = 1001;
      await Promise.all(
        Array.from({ length: n }, (_, i) =>
          limit(() => store.put("c-page", `files/md5/${String(i).padStart(6, "0")}`, "x")),
        ),
      );
      const all = await store.list("c-page", "files/md5/");
      expect(all.length).toBe(n);
    });
  });
}
