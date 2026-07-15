import { createHash } from "node:crypto";
import type {
  CopySpec,
  ListedObject,
  ObjectHead,
  ObjectStore,
} from "../../src/ports/objectStore.js";

interface StoredObject {
  body: Uint8Array;
  etag: string;
}

function toBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

function md5hex(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

export class FakeObjectStore implements ObjectStore {
  private readonly buckets = new Map<string, Map<string, StoredObject>>();

  private bucket(name: string): Map<string, StoredObject> {
    const b = this.buckets.get(name);
    if (b === undefined) throw new Error(`NoSuchBucket: ${name}`);
    return b;
  }

  ensureBucket(bucket: string): Promise<void> {
    if (!this.buckets.has(bucket)) this.buckets.set(bucket, new Map());
    return Promise.resolve();
  }

  put(bucket: string, key: string, body: Uint8Array | string): Promise<void> {
    const bytes = toBytes(body);
    this.bucket(bucket).set(key, { body: bytes, etag: md5hex(bytes) });
    return Promise.resolve();
  }

  head(bucket: string, key: string): Promise<ObjectHead> {
    const obj = this.bucket(bucket).get(key);
    if (obj === undefined) return Promise.reject(new Error(`NoSuchKey: ${bucket}/${key}`));
    return Promise.resolve({ size: obj.body.byteLength, etag: obj.etag });
  }

  list(bucket: string, prefix?: string): Promise<ListedObject[]> {
    const out: ListedObject[] = [];
    for (const [key, obj] of this.bucket(bucket)) {
      if (prefix !== undefined && !key.startsWith(prefix)) continue;
      out.push({ key, size: obj.body.byteLength, etag: obj.etag });
    }
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return Promise.resolve(out);
  }

  getBytes(bucket: string, key: string): Promise<Uint8Array> {
    const obj = this.bucket(bucket).get(key);
    if (obj === undefined) return Promise.reject(new Error(`NoSuchKey: ${bucket}/${key}`));
    return Promise.resolve(obj.body);
  }

  copy(spec: CopySpec): Promise<void> {
    const src = this.bucket(spec.sourceBucket).get(spec.sourceKey);
    if (src === undefined) {
      return Promise.reject(new Error(`NoSuchKey: ${spec.sourceBucket}/${spec.sourceKey}`));
    }
    this.bucket(spec.destBucket).set(spec.destKey, { body: src.body, etag: src.etag });
    return Promise.resolve();
  }

  deleteBatch(bucket: string, keys: string[]): Promise<void> {
    const b = this.bucket(bucket);
    for (const k of keys) b.delete(k);
    return Promise.resolve();
  }
}
