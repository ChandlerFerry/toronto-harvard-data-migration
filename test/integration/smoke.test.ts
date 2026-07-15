import { CreateBucketCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LocalStackHandle, startLocalStack } from "../localstack.js";

describe("LocalStack smoke", () => {
  let ls: LocalStackHandle;

  beforeAll(async () => {
    ls = await startLocalStack();
  });

  afterAll(async () => {
    await ls?.stop();
  });

  it("creates a bucket and round-trips one object", async () => {
    const bucket = "smoke-bucket";
    const key = "ab/cdef0123456789";
    const body = "hello dvc";

    await ls.client.send(new CreateBucketCommand({ Bucket: bucket }));
    await ls.client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));

    const got = await ls.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await got.Body?.transformToString();

    expect(text).toBe(body);
  });
});
