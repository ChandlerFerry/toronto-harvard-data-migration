import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import type { CopySpec, ListedObject, ObjectHead, ObjectStore } from "../ports/objectStore.js";
import { planCopyParts } from "./multipartPlan.js";

const DELETE_CHUNK = 1000;

const SINGLE_COPY_LIMIT = 5 * 1024 ** 3;

const DEFAULT_PART_SIZE = 1024 ** 3;

function stripEtag(etag: string | undefined): string {
  if (etag === undefined) return "";
  return etag.replace(/^"|"$/g, "");
}

function isCopyTooLargeError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  const msg = (e?.message ?? "").toLowerCase();
  return (
    e?.name === "EntityTooLarge" ||
    msg.includes("maximum allowable size") ||
    msg.includes("larger than the maximum allowable")
  );
}

export interface S3ObjectStoreOptions {
  region?: string;

  multipartThresholdBytes?: number;

  multipartPartSizeBytes?: number;
}

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly opts: S3ObjectStoreOptions = {},
  ) {}

  async ensureBucket(bucket: string): Promise<void> {
    const region = this.opts.region;
    const input =
      region !== undefined && region !== "us-east-1"
        ? { Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: region as never } }
        : { Bucket: bucket };
    try {
      await this.client.send(new CreateBucketCommand(input));
    } catch (err) {
      const name = (err as { name?: string }).name ?? "";

      if (name === "BucketAlreadyOwnedByYou") return;
      throw err;
    }
  }

  async put(bucket: string, key: string, body: Uint8Array | string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  }

  async head(bucket: string, key: string): Promise<ObjectHead> {
    const res = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: res.ContentLength ?? 0, etag: stripEtag(res.ETag) };
  }

  async list(bucket: string, prefix?: string): Promise<ListedObject[]> {
    const out: ListedObject[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ...(prefix !== undefined ? { Prefix: prefix } : {}),
          ...(token !== undefined ? { ContinuationToken: token } : {}),
        }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key === undefined) continue;
        out.push({ key: o.Key, size: o.Size ?? 0, etag: stripEtag(o.ETag) });
      }

      if (res.IsTruncated && res.NextContinuationToken === undefined) {
        throw new Error("ListObjectsV2 reported IsTruncated but returned no NextContinuationToken");
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token !== undefined);
    return out;
  }

  async getBytes(bucket: string, key: string): Promise<Uint8Array> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (res.Body === undefined) {
      throw new Error(
        `GetObject returned no body for ${bucket}/${key} (object may be empty or deleted concurrently)`,
      );
    }
    return await res.Body.transformToByteArray();
  }

  async copy(spec: CopySpec): Promise<void> {
    const threshold = this.opts.multipartThresholdBytes ?? SINGLE_COPY_LIMIT;
    if (spec.sourceSize !== undefined && spec.sourceSize > threshold) {
      await this.multipartCopy(spec, spec.sourceSize);
      return;
    }
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: spec.destBucket,
          Key: spec.destKey,
          CopySource: `${spec.sourceBucket}/${spec.sourceKey}`,
        }),
      );
    } catch (err) {
      if (isCopyTooLargeError(err)) {
        const { size } = await this.head(spec.sourceBucket, spec.sourceKey);
        await this.multipartCopy(spec, size);
        return;
      }
      throw err;
    }
  }

  private async multipartCopy(spec: CopySpec, size: number): Promise<void> {
    const partSize = this.opts.multipartPartSizeBytes ?? DEFAULT_PART_SIZE;
    const parts = planCopyParts(size, partSize);

    if (parts.length === 0) {
      throw new Error(
        `multipartCopy: planned 0 parts (source size unknown/zero) for ${spec.destKey}`,
      );
    }
    const copySource = `${spec.sourceBucket}/${spec.sourceKey}`;

    const created = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: spec.destBucket, Key: spec.destKey }),
    );
    const uploadId = created.UploadId;
    if (uploadId === undefined) throw new Error("CreateMultipartUpload returned no UploadId");

    try {
      const completed: { ETag: string; PartNumber: number }[] = [];
      for (const p of parts) {
        const res = await this.client.send(
          new UploadPartCopyCommand({
            Bucket: spec.destBucket,
            Key: spec.destKey,
            UploadId: uploadId,
            PartNumber: p.partNumber,
            CopySource: copySource,
            CopySourceRange: `bytes=${p.start}-${p.end}`,
          }),
        );
        const etag = res.CopyPartResult?.ETag;
        if (etag === undefined)
          throw new Error(`UploadPartCopy part ${p.partNumber} returned no ETag`);
        completed.push({ ETag: etag, PartNumber: p.partNumber });
      }
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: spec.destBucket,
          Key: spec.destKey,
          UploadId: uploadId,
          MultipartUpload: { Parts: completed },
        }),
      );
    } catch (err) {
      try {
        await this.client.send(
          new AbortMultipartUploadCommand({
            Bucket: spec.destBucket,
            Key: spec.destKey,
            UploadId: uploadId,
          }),
        );
      } catch {}
      throw err;
    }
  }

  async deleteBatch(bucket: string, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
      const chunk = keys.slice(i, i + DELETE_CHUNK);
      if (chunk.length === 0) continue;

      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if (res.Errors && res.Errors.length > 0) {
        const detail = res.Errors.map((e) => `${e.Key}: ${e.Code} ${e.Message}`).join("; ");
        throw new Error(`DeleteObjects failed for ${res.Errors.length} key(s): ${detail}`);
      }
    }
  }
}
