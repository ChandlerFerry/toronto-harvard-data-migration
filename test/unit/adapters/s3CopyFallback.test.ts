import type { S3Client } from "@aws-sdk/client-s3";
import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3ObjectStore } from "../../../src/adapters/s3ObjectStore.js";

function entityTooLarge(): Error {
  const e = new Error("The specified copy source is larger than the maximum allowable size");
  e.name = "EntityTooLarge";
  return e;
}

function fakeCopyClient(realSize: number): {
  client: S3Client;
  commands: string[];
} {
  const commands: string[] = [];
  const client = {
    send(command: unknown): Promise<unknown> {
      commands.push((command as { constructor: { name: string } }).constructor.name);
      if (command instanceof CopyObjectCommand) {
        return Promise.reject(entityTooLarge());
      }
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({ ContentLength: realSize, ETag: '"abc"' });
      }
      if (command instanceof CreateMultipartUploadCommand) {
        return Promise.resolve({ UploadId: "u1" });
      }
      if (command instanceof UploadPartCopyCommand) {
        return Promise.resolve({ CopyPartResult: { ETag: '"part"' } });
      }
      if (command instanceof CompleteMultipartUploadCommand) {
        return Promise.resolve({});
      }
      return Promise.reject(new Error("unexpected command"));
    },
  } as unknown as S3Client;
  return { client, commands };
}

describe("S3ObjectStore.copy too-large fallback", () => {
  it("falls back to multipart when a stale sourceSize understates an oversized object", async () => {
    const realSize = 6 * 1024 ** 3;
    const { client, commands } = fakeCopyClient(realSize);
    const store = new S3ObjectStore(client);

    await store.copy({
      sourceBucket: "old",
      sourceKey: "files/md5/aa/bb",
      destBucket: "new",
      destKey: "files/md5/aa/bb",
      sourceSize: 1024,
    });

    expect(commands).toContain("CopyObjectCommand");
    expect(commands).toContain("CreateMultipartUploadCommand");
    expect(commands).toContain("CompleteMultipartUploadCommand");
  });

  it("fails loudly when the too-large recovery HEAD reports size 0 (no silent empty copy)", async () => {
    const commands: string[] = [];
    const client = {
      send(command: unknown): Promise<unknown> {
        commands.push((command as { constructor: { name: string } }).constructor.name);
        if (command instanceof CopyObjectCommand) {
          return Promise.reject(entityTooLarge());
        }
        if (command instanceof HeadObjectCommand) {
          return Promise.resolve({ ETag: '"abc"' });
        }
        if (command instanceof CreateMultipartUploadCommand) {
          return Promise.resolve({ UploadId: "u1" });
        }
        if (command instanceof CompleteMultipartUploadCommand) {
          return Promise.resolve({});
        }
        return Promise.reject(new Error("unexpected command"));
      },
    } as unknown as S3Client;
    const store = new S3ObjectStore(client);

    await expect(
      store.copy({
        sourceBucket: "old",
        sourceKey: "files/md5/aa/bb",
        destBucket: "new",
        destKey: "files/md5/aa/bb",
      }),
    ).rejects.toThrow(/0 part|unknown\/zero|size/i);

    expect(commands).not.toContain("CompleteMultipartUploadCommand");
  });

  it("re-throws a non-too-large CopyObject error", async () => {
    const commands: string[] = [];
    const client = {
      send(command: unknown): Promise<unknown> {
        commands.push((command as { constructor: { name: string } }).constructor.name);
        if (command instanceof CopyObjectCommand) {
          return Promise.reject(new Error("AccessDenied"));
        }
        return Promise.reject(new Error("unexpected command"));
      },
    } as unknown as S3Client;
    const store = new S3ObjectStore(client);
    await expect(
      store.copy({
        sourceBucket: "old",
        sourceKey: "k",
        destBucket: "new",
        destKey: "k",
        sourceSize: 1024,
      }),
    ).rejects.toThrow(/AccessDenied/);
    expect(commands).toEqual(["CopyObjectCommand"]);
  });
});
