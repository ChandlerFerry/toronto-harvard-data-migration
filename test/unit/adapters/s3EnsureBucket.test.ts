import type { S3Client } from "@aws-sdk/client-s3";
import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3ObjectStore } from "../../../src/adapters/s3ObjectStore.js";

function s3Error(name: string, httpStatusCode?: number): Error {
  const e = Object.assign(new Error(name), { $metadata: { httpStatusCode } });
  e.name = name;
  return e;
}

const NOT_FOUND = s3Error("NotFound", 404);

function fakeClient(head: Error | undefined, create?: Error): { client: S3Client; sent: string[] } {
  const sent: string[] = [];
  const client = {
    send(command: unknown): Promise<unknown> {
      if (command instanceof HeadBucketCommand) {
        sent.push("HeadBucket");
        return head ? Promise.reject(head) : Promise.resolve({});
      }
      if (command instanceof CreateBucketCommand) {
        sent.push("CreateBucket");
        return create ? Promise.reject(create) : Promise.resolve({});
      }
      return Promise.reject(new Error("unexpected command"));
    },
  } as unknown as S3Client;
  return { client, sent };
}

describe("S3ObjectStore.ensureBucket", () => {
  it("does NOT call CreateBucket when the bucket exists (cross-account bucket owned by another account)", async () => {
    const { client, sent } = fakeClient(undefined, s3Error("BucketAlreadyExists"));
    await expect(new S3ObjectStore(client).ensureBucket("b")).resolves.toBeUndefined();
    expect(sent).toEqual(["HeadBucket"]);
  });

  it("creates the bucket when HeadBucket reports 404", async () => {
    const { client, sent } = fakeClient(NOT_FOUND);
    await expect(new S3ObjectStore(client).ensureBucket("b")).resolves.toBeUndefined();
    expect(sent).toEqual(["HeadBucket", "CreateBucket"]);
  });

  it("swallows BucketAlreadyOwnedByYou (created concurrently by us)", async () => {
    const { client } = fakeClient(NOT_FOUND, s3Error("BucketAlreadyOwnedByYou"));
    await expect(new S3ObjectStore(client).ensureBucket("b")).resolves.toBeUndefined();
  });

  it("re-throws BucketAlreadyExists from CreateBucket (name taken by an account we cannot see)", async () => {
    const { client } = fakeClient(NOT_FOUND, s3Error("BucketAlreadyExists"));
    await expect(new S3ObjectStore(client).ensureBucket("b")).rejects.toThrow(
      /BucketAlreadyExists/,
    );
  });

  it("re-throws a non-404 HeadBucket failure (e.g. 403) without trying to create", async () => {
    const { client, sent } = fakeClient(s3Error("Forbidden", 403));
    await expect(new S3ObjectStore(client).ensureBucket("b")).rejects.toThrow(/Forbidden/);
    expect(sent).toEqual(["HeadBucket"]);
  });
});
