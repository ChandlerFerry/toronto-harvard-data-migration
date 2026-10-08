import { type DiffReport, type MissingEntry, type ObjectMeta, diffByMd5 } from "../domain/diff.js";
import { isDvcObjectKey, keyToMd5 } from "../domain/dvcKey.js";
import type { ListedObject } from "../ports/objectStore.js";

export interface VerifyOptions {
  plannedKeys?: readonly string[];

  deep?: boolean;
}

export interface VerifyReport extends DiffReport {
  ok: boolean;
  oldCount: number;
  newCount: number;
  deepChecked: number;

  deepEtagSkipped: number;

  sizeOnlyKeys: string[];
}

function toMeta(list: ListedObject[]): ObjectMeta[] {
  return list.filter((o) => isDvcObjectKey(o.key)).map((o) => ({ key: o.key, size: o.size }));
}

function isSinglePartEtag(etag: string): boolean {
  return /^[0-9a-f]{32}$/i.test(etag);
}

function isMissingEtag(etag: string): boolean {
  return etag === "";
}

interface EtagCorruptionResult {
  corrupted: MissingEntry[];

  deepChecked: number;

  sizeOnlyKeys: string[];
}

function findEtagCorruption(
  report: DiffReport,
  oldDvc: ListedObject[],
  newDvc: ListedObject[],
  oldObjs: ObjectMeta[],
): EtagCorruptionResult {
  const newEtagsByMd5 = new Map<string, string[]>();
  for (const o of newDvc) {
    const md5 = keyToMd5(o.key);
    const etags = newEtagsByMd5.get(md5);
    if (etags === undefined) newEtagsByMd5.set(md5, [o.etag]);
    else etags.push(o.etag);
  }
  const oldEtagByKey = new Map<string, string>();
  for (const o of oldDvc) oldEtagByKey.set(o.key, o.etag);
  const oldSizeByKey = new Map<string, number>();
  for (const o of oldObjs) oldSizeByKey.set(o.key, o.size);

  const corrupted: MissingEntry[] = [];
  let deepChecked = 0;
  const sizeOnlyKeys: string[] = [];

  for (const oldKey of report.matched) {
    const md5 = keyToMd5(oldKey);
    const newEtags = newEtagsByMd5.get(md5) ?? [];
    const oldEtag = oldEtagByKey.get(oldKey);
    deepChecked += 1;

    let definiteMismatch = false;
    let comparedAny = false;
    if (oldEtag !== undefined && isSinglePartEtag(oldEtag)) {
      for (const e of newEtags) {
        if (isMissingEtag(e)) {
          definiteMismatch = true;
          continue;
        }
        if (!isSinglePartEtag(e)) continue;
        comparedAny = true;
        if (e !== oldEtag) definiteMismatch = true;
      }
    } else if (isMissingEtag(oldEtag ?? "")) {
      if (newEtags.some((e) => isSinglePartEtag(e))) definiteMismatch = true;
    }

    if (definiteMismatch) {
      const size = oldSizeByKey.get(oldKey) ?? 0;

      corrupted.push({
        key: oldKey,
        md5,
        reason: "etag-mismatch",
        oldSize: size,
      });
    } else if (!comparedAny) {
      sizeOnlyKeys.push(oldKey);
    }
  }

  return { corrupted, deepChecked, sizeOnlyKeys };
}

export function verifyLists(
  oldList: ListedObject[],
  newList: ListedObject[],
  opts: VerifyOptions = {},
): VerifyReport {
  const oldDvc = oldList.filter((o) => isDvcObjectKey(o.key));
  const newDvc = newList.filter((o) => isDvcObjectKey(o.key));

  let oldObjs = toMeta(oldDvc);
  const newObjs = toMeta(newDvc);

  if (opts.plannedKeys !== undefined) {
    const planned = new Set(opts.plannedKeys);
    oldObjs = oldObjs.filter((o) => planned.has(o.key));
  }

  const report = diffByMd5(oldObjs, newObjs);
  let deepChecked = 0;
  let sizeOnlyKeys: string[] = [];

  if (opts.deep === true && report.missing.length === 0) {
    const etagResult = findEtagCorruption(report, oldDvc, newDvc, oldObjs);
    deepChecked = etagResult.deepChecked;
    sizeOnlyKeys = etagResult.sizeOnlyKeys;
    if (etagResult.corrupted.length > 0) {
      report.missing.push(...etagResult.corrupted);
      const bad = new Set(etagResult.corrupted.map((e) => e.key));
      report.matched = report.matched.filter((k) => !bad.has(k));
    }
  }

  return {
    ...report,
    ok: report.missing.length === 0,
    oldCount: oldObjs.length,
    newCount: newObjs.length,
    deepChecked,
    deepEtagSkipped: sizeOnlyKeys.length,
    sizeOnlyKeys,
  };
}

export function proveDeletable(
  oldList: ListedObject[],
  newList: ListedObject[],
  deep: boolean,
): { deletable: string[]; corrupt: MissingEntry[]; sizeOnlyKeys: string[] } {
  const sized = verifyLists(oldList, newList, { deep: false });
  if (!deep) {
    return { deletable: sized.matched, corrupt: sized.missing, sizeOnlyKeys: sized.matched };
  }
  const sizeMatched = new Set(sized.matched);
  const candidates = oldList.filter((o) => sizeMatched.has(o.key));
  const proven = verifyLists(candidates, newList, { deep: true });
  return {
    deletable: proven.matched,
    corrupt: [...sized.missing, ...proven.missing],
    sizeOnlyKeys: proven.sizeOnlyKeys,
  };
}
