import type { S3Client } from "@aws-sdk/client-s3";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3ObjectStore } from "../../../src/adapters/s3ObjectStore.js";

function fakeDeleteClient(
  respond: (keys: string[]) => { Errors?: { Key?: string; Code?: string; Message?: string }[] },
): { client: S3Client; deletedRequests: string[][] } {
  const deletedRequests: string[][] = [];
  const client = {
    send(command: unknown): Promise<unknown> {
      if (command instanceof DeleteObjectsCommand) {
        const objects = command.input.Delete?.Objects ?? [];
        const keys = objects.map((o) => o.Key ?? "");
        deletedRequests.push(keys);
        return Promise.resolve(respond(keys));
      }
      return Promise.reject(new Error("unexpected command"));
    },
  } as unknown as S3Client;
  return { client, deletedRequests };
}

describe("S3ObjectStore.deleteBatch", () => {
  it("resolves on a clean DeleteObjects response (no Errors)", async () => {
    const { client, deletedRequests } = fakeDeleteClient(() => ({}));
    const store = new S3ObjectStore(client);
    await store.deleteBatch("old", ["a/1", "b/2"]);
    expect(deletedRequests).toEqual([["a/1", "b/2"]]);
  });

  it("throws when DeleteObjects reports per-key failures (HTTP 200 + Errors)", async () => {
    const { client } = fakeDeleteClient(() => ({
      Errors: [{ Key: "b/2", Code: "AccessDenied", Message: "Access Denied" }],
    }));
    const store = new S3ObjectStore(client);
    await expect(store.deleteBatch("old", ["a/1", "b/2"])).rejects.toThrow(/b\/2/);
  });

  it("surfaces the failing keys/codes when a later chunk reports errors", async () => {
    const keys = Array.from({ length: 1500 }, (_, i) => `k/${i}`);
    const { client } = fakeDeleteClient((chunk) =>
      chunk.includes("k/1200")
        ? { Errors: [{ Key: "k/1200", Code: "InternalError", Message: "boom" }] }
        : {},
    );
    const store = new S3ObjectStore(client);
    await expect(store.deleteBatch("old", keys)).rejects.toThrow(/k\/1200/);
  });
});
