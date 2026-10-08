import os from "node:os";
import pLimit from "p-limit";
import { type MigrationPlan, type PlanItem, planDestBuckets } from "../domain/plan.js";
import type { ObjectStore } from "../ports/objectStore.js";
import { type RetryOptions, withRetry } from "./retry.js";

export interface TransferOptions {
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;

  maxRetries?: number;

  retry?: Partial<RetryOptions>;
}

export interface TransferError {
  item: PlanItem;
  error: string;
}

export interface TransferReport {
  total: number;
  copied: number;
  skipped: number;
  errors: TransferError[];
}

const SINGLE_PART_ETAG = /^[0-9a-f]{32}$/i;

async function destMatchesSource(store: ObjectStore, item: PlanItem): Promise<boolean> {
  let dst: { size: number; etag: string };
  try {
    dst = await store.head(item.destBucket, item.destKey);
  } catch {
    return false;
  }
  try {
    const src = await store.head(item.sourceBucket, item.sourceKey);
    if (src.etag === "" || src.size !== dst.size) return false;
    // ponytail: multipart ETags depend on part size, so they never match across a copy;
    // size is the resume check there, and delete refuses size-only proofs by default.
    return (
      !SINGLE_PART_ETAG.test(src.etag) || !SINGLE_PART_ETAG.test(dst.etag) || src.etag === dst.etag
    );
  } catch {
    return false;
  }
}

export async function transfer(
  store: ObjectStore,
  plan: MigrationPlan,
  opts: TransferOptions = {},
): Promise<TransferReport> {
  const concurrency = opts.concurrency ?? Math.max(4, os.cpus().length * 4);
  const retryOpts: RetryOptions = { maxRetries: opts.maxRetries ?? 5, ...opts.retry };
  for (const b of planDestBuckets(plan)) await store.ensureBucket(b);

  const limit = pLimit(concurrency);
  let copied = 0;
  let skipped = 0;
  const errors: TransferError[] = [];
  const total = plan.items.length;
  let done = 0;

  await Promise.all(
    plan.items.map((item) =>
      limit(async () => {
        try {
          if (await destMatchesSource(store, item)) {
            skipped += 1;
          } else {
            await withRetry(
              () =>
                store.copy({
                  sourceBucket: item.sourceBucket,
                  sourceKey: item.sourceKey,
                  destBucket: item.destBucket,
                  destKey: item.destKey,
                  ...(item.sourceSize !== undefined ? { sourceSize: item.sourceSize } : {}),
                }),
              retryOpts,
            );
            copied += 1;
          }
        } catch (err) {
          errors.push({ item, error: (err as Error).message });
        } finally {
          done += 1;
          opts.onProgress?.(done, total);
        }
      }),
    ),
  );

  return { total, copied, skipped, errors };
}
