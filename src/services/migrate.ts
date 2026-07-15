import { isDvcObjectKey } from "../domain/dvcKey.js";
import {
  type DestResolver,
  type MigrationPlan,
  buildPlan,
  identityResolver,
} from "../domain/plan.js";
import type { ObjectStore } from "../ports/objectStore.js";
import { type TransferOptions, type TransferReport, transfer } from "./transfer.js";
import { type VerifyReport, verify } from "./verify.js";

export interface MigrateInput {
  store: ObjectStore;
  oldBucket: string;
  newBucket: string;

  resolve?: DestResolver;

  keys?: readonly string[];
  deep?: boolean;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface MigrateReport {
  plan: MigrationPlan;
  transfer: TransferReport;
  verify: VerifyReport;
}

export async function migrate(input: MigrateInput): Promise<MigrateReport> {
  let keys = input.keys;
  let sizeByKey: Map<string, number> | undefined;
  if (keys === undefined) {
    const listed = (await input.store.list(input.oldBucket)).filter((o) => isDvcObjectKey(o.key));
    keys = listed.map((o) => o.key);
    sizeByKey = new Map(listed.map((o) => [o.key, o.size]));
  }

  const resolve = input.resolve ?? identityResolver(input.newBucket);
  const plan = buildPlan(input.oldBucket, keys, resolve, sizeByKey);

  const transferOpts: TransferOptions = {};
  if (input.concurrency !== undefined) transferOpts.concurrency = input.concurrency;
  if (input.onProgress !== undefined) transferOpts.onProgress = input.onProgress;
  const transferReport = await transfer(input.store, plan, transferOpts);

  const verifyReport = await verify(input.store, input.oldBucket, input.store, input.newBucket, {
    plannedKeys: keys,
    deep: input.deep ?? true,
  });

  return { plan, transfer: transferReport, verify: verifyReport };
}
