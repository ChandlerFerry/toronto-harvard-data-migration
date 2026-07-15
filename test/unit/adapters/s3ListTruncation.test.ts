import type { S3Client } from "@aws-sdk/client-s3";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3ObjectStore } from "../../../src/adapters/s3ObjectStore.js";

function fakeListClient(
  responses: {
    Contents?: { Key?: string; Size?: number; ETag?: string }[];
    IsTruncated?: boolean;
    NextContinuationToken?: string;
  }[],
): { client: S3Client; calls: number } {
  const state = { calls: 0 };
  const client = {
    send(command: unknown): Promise<unknown> {
      if (command instanceof ListObjectsV2Command) {
        const res = responses[state.calls] ?? {};
        state.calls += 1;
        return Promise.resolve(res);
      }
      return Promise.reject(new Error("unexpected command"));
    },
  } as unknown as S3Client;
  return {
    client,
    get calls() {
      return state.calls;
    },
  };
}

describe("S3ObjectStore.list pagination", () => {
  it("paginates through every page using the continuation token", async () => {
    const { client } = fakeListClient([
      {
        Contents: [{ Key: "aa/1", Size: 1, ETag: '"x"' }],
        IsTruncated: true,
        NextContinuationToken: "tok1",
      },
      { Contents: [{ Key: "bb/2", Size: 2, ETag: '"y"' }], IsTruncated: false },
    ]);
    const store = new S3ObjectStore(client);
    const out = await store.list("b");
    expect(out.map((o) => o.key)).toEqual(["aa/1", "bb/2"]);
  });

  it("throws instead of silently truncating when IsTruncated is true but no token is returned", async () => {
    const { client } = fakeListClient([
      {
        Contents: [{ Key: "aa/1", Size: 1, ETag: '"x"' }],
        IsTruncated: true,
      },
    ]);
    const store = new S3ObjectStore(client);
    await expect(store.list("b")).rejects.toThrow(/IsTruncated.*NextContinuationToken/i);
  });
});
