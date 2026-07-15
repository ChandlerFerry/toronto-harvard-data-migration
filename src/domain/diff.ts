import { keyToMd5 } from "./dvcKey.js";

export interface ObjectMeta {
  key: string;
  size: number;
}

export type MissingReason = "absent" | "size-mismatch" | "etag-mismatch" | "misrouted";

export interface MissingEntry {
  key: string;
  md5: string;
  reason: MissingReason;
  oldSize: number;
  newSize?: number;

  expectedBucket?: string;

  foundBuckets?: string[];
}

export interface DiffReport {
  matched: string[];
  missing: MissingEntry[];
  extra: string[];
}

export function diffByMd5(oldObjs: ObjectMeta[], newObjs: ObjectMeta[]): DiffReport {
  const newByMd5 = new Map<string, ObjectMeta[]>();
  for (const o of newObjs) {
    const md5 = keyToMd5(o.key);
    const copies = newByMd5.get(md5);
    if (copies === undefined) newByMd5.set(md5, [o]);
    else copies.push(o);
  }

  const oldMd5s = new Set<string>();
  const matched: string[] = [];
  const missing: MissingEntry[] = [];

  for (const o of oldObjs) {
    const md5 = keyToMd5(o.key);
    oldMd5s.add(md5);
    const copies = newByMd5.get(md5);
    if (copies === undefined) {
      missing.push({ key: o.key, md5, reason: "absent", oldSize: o.size });
      continue;
    }
    const bad = copies.find((c) => c.size !== o.size);
    if (bad !== undefined) {
      missing.push({
        key: o.key,
        md5,
        reason: "size-mismatch",
        oldSize: o.size,
        newSize: bad.size,
      });
    } else {
      matched.push(o.key);
    }
  }

  const extra: string[] = [];
  for (const n of newObjs) {
    if (!oldMd5s.has(keyToMd5(n.key))) extra.push(n.key);
  }

  return { matched, missing, extra };
}
