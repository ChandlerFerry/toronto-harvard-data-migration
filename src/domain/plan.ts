import { tryKeyToMd5 } from "./dvcKey.js";

export interface PlanItem {
  sourceBucket: string;
  sourceKey: string;
  destBucket: string;
  destKey: string;
  md5: string;

  sourceSize?: number;
}

export interface MigrationPlan {
  items: PlanItem[];
}

export type DestResolver = (input: {
  md5: string;
  sourceKey: string;
}) => { destBucket: string; destKey: string };

export function buildPlan(
  sourceBucket: string,
  keys: readonly string[],
  resolve: DestResolver,
  sizeByKey?: ReadonlyMap<string, number>,
): MigrationPlan {
  const items: PlanItem[] = [];
  for (const sourceKey of keys) {
    const md5 = tryKeyToMd5(sourceKey);
    if (md5 === null) continue;
    const { destBucket, destKey } = resolve({ md5, sourceKey });
    const size = sizeByKey?.get(sourceKey);
    const item: PlanItem = { sourceBucket, sourceKey, destBucket, destKey, md5 };
    if (size !== undefined) item.sourceSize = size;
    items.push(item);
  }
  return { items };
}

export function identityResolver(destBucket: string): DestResolver {
  return ({ sourceKey }) => ({ destBucket, destKey: sourceKey });
}

export function planDestBuckets(plan: MigrationPlan): string[] {
  return [...new Set(plan.items.map((i) => i.destBucket))];
}
