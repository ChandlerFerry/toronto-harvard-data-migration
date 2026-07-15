import type { S3Client } from "@aws-sdk/client-s3";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3ObjectStore } from "../../../src/adapters/s3ObjectStore.js";

function s3Error(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

function fakeCreateClient(rejectWith?: Error): S3Client {
  return {
    send(command: unknown): Promise<unknown> {
      if (command instanceof CreateBucketCommand) {
        return rejectWith ? Promise.reject(rejectWith) : Promise.resolve({});
      }
      return Promise.reject(new Error("unexpected command"));
    },
  } as unknown as S3Client;
}

describe("S3ObjectStore.ensureBucket", () => {
  it("resolves when CreateBucket succeeds", async () => {
    const store = new S3ObjectStore(fakeCreateClient());
    await expect(store.ensureBucket("b")).resolves.toBeUndefined();
  });

  it("swallows BucketAlreadyOwnedByYou (idempotent re-create of our own bucket)", async () => {
    const store = new S3ObjectStore(fakeCreateClient(s3Error("BucketAlreadyOwnedByYou")));
    await expect(store.ensureBucket("b")).resolves.toBeUndefined();
  });

  it("re-throws BucketAlreadyExists (name owned by a DIFFERENT account)", async () => {
    const store = new S3ObjectStore(fakeCreateClient(s3Error("BucketAlreadyExists")));
    await expect(store.ensureBucket("b")).rejects.toThrow(/BucketAlreadyExists/);
  });

  it("re-throws any other CreateBucket error", async () => {
    const store = new S3ObjectStore(fakeCreateClient(s3Error("AccessDenied")));
    await expect(store.ensureBucket("b")).rejects.toThrow(/AccessDenied/);
  });
});
