import {
  DEFAULT_DRY_RUN,
  type ProductionGuardOptions,
  ensureNotProduction,
} from "../config/guards.js";
import type { MissingEntry } from "../domain/diff.js";
import { V3_PREFIX, isDvcObjectKey, keyToMd5, tryKeyToMd5 } from "../domain/dvcKey.js";
import { type DestResolver, buildPlan, identityResolver, planDestBuckets } from "../domain/plan.js";
import type { ListedObject, ObjectStore } from "../ports/objectStore.js";
import { VerificationGapError } from "./deleteOld.js";
import { type TransferError, type TransferOptions, transfer } from "./transfer.js";
import { type VerifyReport, proveDeletable, verifyLists } from "./verify.js";

const HEX = "0123456789abcdef";
const MISSING_SAMPLE_CAP = 1000;

export function md5Prefixes(length: number): string[] {
  if (!Number.isInteger(length) || length < 1 || length > 4) {
    throw new Error(`shard prefix length must be an integer in 1..4 (got ${length})`);
  }
  let acc = [""];
  for (let i = 0; i < length; i += 1) {
    const next: string[] = [];
    for (const a of acc) for (const h of HEX) next.push(a + h);
    acc = next;
  }
  return acc;
}

function v2KeyPrefix(md5Prefix: string): string {
  return md5Prefix.length === 2
    ? `${md5Prefix}/`
    : `${md5Prefix.slice(0, 2)}/${md5Prefix.slice(2)}`;
}

function resolveShardLength(length: number | undefined): number {
  const n = length ?? 2;
  if (!Number.isInteger(n) || n < 2 || n > 4) {
    throw new Error(`shardLength must be an integer in 2..4 (got ${n})`);
  }
  return n;
}

export async function listShard(
  store: ObjectStore,
  bucket: string,
  prefix: string,
): Promise<ListedObject[]> {
  const v2pfx = v2KeyPrefix(prefix);
  const v2 = await store.list(bucket, v2pfx);
  const v3 = await store.list(bucket, `${V3_PREFIX}${v2pfx}`);
  return v2.length === 0 ? v3 : v2.concat(v3);
}

export interface ShardedVerifyOptions {
  deep?: boolean;

  shardLength?: number;
  onShard?: (prefix: string, oldCount: number, newCount: number) => void;

  newBuckets?: readonly string[];

  expectBucketByMd5?: (md5: string) => string;

  keepMd5?: (md5: string) => boolean;
}

function filterByMd5(list: ListedObject[], keep: (md5: string) => boolean): ListedObject[] {
  return list.filter((o) => {
    const md5 = tryKeyToMd5(o.key);
    return md5 !== null && keep(md5);
  });
}

function isMissingBucketError(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NoSuchBucket") return true;
  const msg = err instanceof Error ? err.message : String(err);

  return /^nosuchbucket\b/i.test(msg) || /the specified bucket does not exist/i.test(msg);
}

async function listShardMany(
  store: ObjectStore,
  buckets: readonly string[],
  prefix: string,
): Promise<ListedObject[]> {
  const out: ListedObject[] = [];
  for (const b of buckets) {
    try {
      out.push(...(await listShard(store, b, prefix)));
    } catch (err) {
      if (!isMissingBucketError(err)) throw err;
    }
  }
  return out;
}

async function listShardByBucket(
  store: ObjectStore,
  buckets: readonly string[],
  prefix: string,
): Promise<{ flat: ListedObject[]; bucketsByMd5: Map<string, Set<string>> }> {
  const flat: ListedObject[] = [];
  const bucketsByMd5 = new Map<string, Set<string>>();
  for (const b of buckets) {
    let objs: ListedObject[];
    try {
      objs = await listShard(store, b, prefix);
    } catch (err) {
      if (isMissingBucketError(err)) continue;
      throw err;
    }
    for (const o of objs) {
      flat.push(o);
      if (!isDvcObjectKey(o.key)) continue;
      const md5 = keyToMd5(o.key);
      const set = bucketsByMd5.get(md5);
      if (set === undefined) bucketsByMd5.set(md5, new Set([b]));
      else set.add(b);
    }
  }
  return { flat, bucketsByMd5 };
}

function applyDestinationAssertion(
  vr: Pick<VerifyReport, "matched" | "missing" | "ok">,
  oldList: ListedObject[],
  bucketsByMd5: Map<string, Set<string>>,
  expect: (md5: string) => string,
): void {
  const oldSizeByKey = new Map(oldList.map((o) => [o.key, o.size]));
  const stillMatched: string[] = [];
  for (const key of vr.matched) {
    const md5 = keyToMd5(key);
    const expected = expect(md5);
    const found = bucketsByMd5.get(md5);
    if (found?.has(expected) === true) {
      stillMatched.push(key);
    } else {
      vr.missing.push({
        key,
        md5,
        reason: "misrouted",
        oldSize: oldSizeByKey.get(key) ?? 0,
        expectedBucket: expected,
        foundBuckets: found ? [...found].sort() : [],
      });
    }
  }
  vr.matched = stillMatched;
  vr.ok = vr.missing.length === 0;
}

async function verifyShard(
  oldList: ListedObject[],
  newStore: ObjectStore,
  newBuckets: readonly string[],
  prefix: string,
  deep: boolean,
  expect: ((md5: string) => string) | undefined,
): Promise<VerifyReport> {
  if (expect === undefined) {
    const newList = await listShardMany(newStore, newBuckets, prefix);
    return verifyLists(oldList, newList, { deep });
  }
  const { flat, bucketsByMd5 } = await listShardByBucket(newStore, newBuckets, prefix);
  const vr = verifyLists(oldList, flat, { deep });
  applyDestinationAssertion(vr, oldList, bucketsByMd5, expect);
  return vr;
}

export interface ShardedVerifyReport {
  ok: boolean;
  oldCount: number;
  newCount: number;
  matchedCount: number;
  extraCount: number;
  deepChecked: number;
  deepEtagSkipped: number;
  shards: number;
  shardsWithGaps: string[];

  missing: MissingEntry[];
  missingTruncated: boolean;
}

export async function verifySharded(
  oldStore: ObjectStore,
  oldBucket: string,
  newStore: ObjectStore,
  newBucket: string,
  opts: ShardedVerifyOptions = {},
): Promise<ShardedVerifyReport> {
  const deep = opts.deep ?? false;
  const prefixes = md5Prefixes(resolveShardLength(opts.shardLength));

  const newBuckets =
    opts.newBuckets !== undefined && opts.newBuckets.length > 0 ? opts.newBuckets : [newBucket];

  const report: ShardedVerifyReport = {
    ok: true,
    oldCount: 0,
    newCount: 0,
    matchedCount: 0,
    extraCount: 0,
    deepChecked: 0,
    deepEtagSkipped: 0,
    shards: prefixes.length,
    shardsWithGaps: [],
    missing: [],
    missingTruncated: false,
  };

  for (const prefix of prefixes) {
    let oldList = await listShard(oldStore, oldBucket, prefix);
    if (opts.keepMd5 !== undefined) oldList = filterByMd5(oldList, opts.keepMd5);
    const vr = await verifyShard(
      oldList,
      newStore,
      newBuckets,
      prefix,
      deep,
      opts.expectBucketByMd5,
    );

    report.oldCount += vr.oldCount;
    report.newCount += vr.newCount;
    report.matchedCount += vr.matched.length;
    report.extraCount += vr.extra.length;
    report.deepChecked += vr.deepChecked;
    report.deepEtagSkipped += vr.deepEtagSkipped;
    if (vr.missing.length > 0) {
      report.shardsWithGaps.push(prefix);
      for (const m of vr.missing) {
        if (report.missing.length < MISSING_SAMPLE_CAP) report.missing.push(m);
        else report.missingTruncated = true;
      }
    }
    opts.onShard?.(prefix, vr.oldCount, vr.newCount);
  }

  report.ok = report.shardsWithGaps.length === 0;
  return report;
}

export interface ShardedDeleteOptions extends ShardedVerifyOptions {
  dryRun?: boolean;
  allowProduction?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface ShardedDeleteReport {
  dryRun: boolean;
  deleted: number;
  targetCount: number;
  shards: number;

  incompleteShards: string[];
}

export async function deleteOldSharded(
  store: ObjectStore,
  oldBucket: string,
  newBucket: string,
  opts: ShardedDeleteOptions = {},
): Promise<ShardedDeleteReport> {
  const dryRun = opts.dryRun ?? DEFAULT_DRY_RUN;

  const deep = opts.deep ?? true;
  const shardLength = resolveShardLength(opts.shardLength);

  const newBuckets = opts.newBuckets?.length ? [...opts.newBuckets] : [newBucket];

  const vr = await verifySharded(store, oldBucket, store, newBucket, {
    deep,
    shardLength,
    newBuckets,
    ...(opts.expectBucketByMd5 !== undefined ? { expectBucketByMd5: opts.expectBucketByMd5 } : {}),
    ...(opts.keepMd5 !== undefined ? { keepMd5: opts.keepMd5 } : {}),
  });
  if (!vr.ok) throw new VerificationGapError(vr);

  const guardOpts: ProductionGuardOptions = {};
  if (opts.allowProduction !== undefined) guardOpts.allowProduction = opts.allowProduction;
  if (opts.env !== undefined) guardOpts.env = opts.env;
  ensureNotProduction(oldBucket, guardOpts);

  if (dryRun) {
    return {
      dryRun: true,
      deleted: 0,
      targetCount: vr.matchedCount,
      shards: vr.shards,
      incompleteShards: [],
    };
  }

  let deleted = 0;
  const incompleteShards: string[] = [];
  for (const prefix of md5Prefixes(shardLength)) {
    let oldList = await listShard(store, oldBucket, prefix);
    if (opts.keepMd5 !== undefined) oldList = filterByMd5(oldList, opts.keepMd5);
    const r = await verifyShard(oldList, store, newBuckets, prefix, deep, opts.expectBucketByMd5);
    if (r.missing.length > 0) {
      incompleteShards.push(prefix);
      continue;
    }
    if (r.matched.length > 0) await store.deleteBatch(oldBucket, r.matched);
    deleted += r.matched.length;
  }

  return {
    dryRun: false,
    deleted,
    targetCount: vr.matchedCount,
    shards: vr.shards,
    incompleteShards,
  };
}

export interface DeleteAgainstOptions {
  dryRun?: boolean;
  allowProduction?: boolean;
  env?: NodeJS.ProcessEnv;

  deep?: boolean;
  shardLength?: number;

  expectBucketByMd5?: (md5: string) => string;
}

export interface DeleteAgainstReport {
  dryRun: boolean;
  deleted: number;

  targetCount: number;
  shards: number;

  corrupt: MissingEntry[];

  deepEtagSkipped: number;
}

export async function deleteOldAgainstBuckets(
  store: ObjectStore,
  oldBucket: string,
  providerBuckets: readonly string[],
  opts: DeleteAgainstOptions = {},
): Promise<DeleteAgainstReport> {
  const dryRun = opts.dryRun ?? DEFAULT_DRY_RUN;
  const deep = opts.deep ?? true;
  const shardLength = resolveShardLength(opts.shardLength);
  const prefixes = md5Prefixes(shardLength);

  const guardOpts: ProductionGuardOptions = {};
  if (opts.allowProduction !== undefined) guardOpts.allowProduction = opts.allowProduction;
  if (opts.env !== undefined) guardOpts.env = opts.env;
  if (!dryRun) ensureNotProduction(oldBucket, guardOpts);

  let deleted = 0;
  let targetCount = 0;
  let deepEtagSkipped = 0;
  const corrupt: MissingEntry[] = [];

  for (const prefix of prefixes) {
    const oldList = await listShard(store, oldBucket, prefix);
    if (oldList.length === 0) continue;

    const { flat, bucketsByMd5 } = await listShardByBucket(store, providerBuckets, prefix);
    // Union invariant: EVERY copy of an md5 across the targeted buckets must be
    // byte-identical, or the object is refused (left in OLD).
    const oldScoped = filterByMd5(oldList, (md5) => bucketsByMd5.has(md5));
    if (oldScoped.length === 0) continue;

    const proven = proveDeletable(oldScoped, flat, deep);
    const decision = { matched: proven.deletable, missing: proven.corrupt, ok: true };
    if (opts.expectBucketByMd5 !== undefined) {
      applyDestinationAssertion(decision, oldScoped, bucketsByMd5, opts.expectBucketByMd5);
    }

    targetCount += decision.matched.length;
    deepEtagSkipped += proven.deepEtagSkipped;
    for (const m of decision.missing) corrupt.push(m);
    if (!dryRun && decision.matched.length > 0) {
      await store.deleteBatch(oldBucket, decision.matched);
      deleted += decision.matched.length;
    }
  }

  return { dryRun, deleted, targetCount, shards: prefixes.length, corrupt, deepEtagSkipped };
}

export interface ShardedMigrateInput {
  store: ObjectStore;
  oldBucket: string;
  newBucket: string;
  resolve?: DestResolver;
  deep?: boolean;
  concurrency?: number;
  maxRetries?: number;
  shardLength?: number;

  keepMd5?: (md5: string) => boolean;
}

export interface ShardedMigrateReport {
  transfer: { total: number; copied: number; skipped: number; errors: TransferError[] };
  verify: ShardedVerifyReport;
  shards: number;
}

export async function migrateSharded(input: ShardedMigrateInput): Promise<ShardedMigrateReport> {
  const shardLength = resolveShardLength(input.shardLength);
  const resolve = input.resolve ?? identityResolver(input.newBucket);

  let total = 0;
  let copied = 0;
  let skipped = 0;
  const errors: TransferError[] = [];

  const destBuckets = new Set<string>();

  for (const prefix of md5Prefixes(shardLength)) {
    let oldList = await listShard(input.store, input.oldBucket, prefix);
    if (input.keepMd5 !== undefined) oldList = filterByMd5(oldList, input.keepMd5);
    if (oldList.length === 0) continue;
    const keys = oldList.map((o) => o.key);
    const sizeByKey = new Map(oldList.map((o) => [o.key, o.size]));
    const plan = buildPlan(input.oldBucket, keys, resolve, sizeByKey);
    for (const b of planDestBuckets(plan)) destBuckets.add(b);

    const transferOpts: TransferOptions = {};
    if (input.concurrency !== undefined) transferOpts.concurrency = input.concurrency;
    if (input.maxRetries !== undefined) transferOpts.maxRetries = input.maxRetries;
    const tr = await transfer(input.store, plan, transferOpts);

    total += tr.total;
    copied += tr.copied;
    skipped += tr.skipped;
    for (const e of tr.errors) errors.push(e);
  }

  const newBuckets = destBuckets.size > 0 ? [...destBuckets] : [input.newBucket];
  const verify = await verifySharded(input.store, input.oldBucket, input.store, input.newBucket, {
    deep: input.deep ?? true,
    shardLength,
    newBuckets,

    expectBucketByMd5: (md5) => resolve({ md5, sourceKey: "" }).destBucket,

    ...(input.keepMd5 !== undefined ? { keepMd5: input.keepMd5 } : {}),
  });

  return { transfer: { total, copied, skipped, errors }, verify, shards: 16 ** shardLength };
}
