import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3ObjectStore } from "../../src/adapters/s3ObjectStore.js";
import { type LocalStackHandle, startLocalStack } from "../localstack.js";

const md5 = (b: Uint8Array): string => createHash("md5").update(b).digest("hex");

describe("S3ObjectStore multipart copy (LocalStack)", () => {
  let ls: LocalStackHandle;
  let store: S3ObjectStore;

  beforeAll(async () => {
    ls = await startLocalStack();

    store = new S3ObjectStore(ls.client, {
      region: "us-east-2",
      multipartThresholdBytes: 5 * 1024 * 1024,
      multipartPartSizeBytes: 5 * 1024 * 1024,
    });
    await store.ensureBucket("mp-old");
    await store.ensureBucket("mp-new");
  });

  afterAll(async () => {
    await ls?.stop();
  });

  it("copies an over-threshold object via multipart, byte-for-byte", async () => {
    const size = 12 * 1024 * 1024;
    const body = new Uint8Array(size);
    for (let i = 0; i < size; i++) body[i] = (i * 31) & 0xff;
    const key = "ab/0123456789abcdef0123456789ab";

    await store.put("mp-old", key, body);
    await store.copy({
      sourceBucket: "mp-old",
      sourceKey: key,
      destBucket: "mp-new",
      destKey: key,
      sourceSize: size,
    });

    const got = await store.getBytes("mp-new", key);
    expect(got.byteLength).toBe(size);
    expect(md5(got)).toBe(md5(body));

    const head = await store.head("mp-new", key);
    expect(head.size).toBe(size);

    expect(head.etag).toMatch(/-\d+$/);
  });

  it("uses single-part copy for an under-threshold object (plain ETag)", async () => {
    const body = new Uint8Array(1024).fill(7);
    const key = "cd/0123456789abcdef0123456789ab";
    await store.put("mp-old", key, body);
    await store.copy({
      sourceBucket: "mp-old",
      sourceKey: key,
      destBucket: "mp-new",
      destKey: key,
      sourceSize: body.byteLength,
    });
    const head = await store.head("mp-new", key);
    expect(head.size).toBe(1024);
    expect(head.etag).toMatch(/^[0-9a-f]{32}$/);
  });
});
