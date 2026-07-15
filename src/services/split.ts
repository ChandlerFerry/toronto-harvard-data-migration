import type { Region } from "../config/sources.js";
import { dirMemberMd5s } from "../domain/dirObject.js";
import { md5ToKey } from "../domain/dvcKey.js";
import type { DestResolver } from "../domain/plan.js";
import { UNMATCHED_SUFFIX, generateBucketName } from "../domain/providerMap.js";
import type { GitDvcEntry } from "../ports/gitHistory.js";
import type { ObjectStore } from "../ports/objectStore.js";
import { type DirReadError, type ProviderConflict, resolveProviderByMd5 } from "./mapping.js";

export interface SplitMapping {
  resolve: DestResolver;

  predictBucket: (md5: string) => string;

  destBuckets: string[];

  conflicts: ProviderConflict[];

  unknownDirs: string[];

  providerByMd5: Map<string, string>;
}

export interface BuildSplitMappingInput {
  gitEntries: readonly GitDvcEntry[];

  dirMembers?: Readonly<Record<string, readonly string[]>>;
  region: Region;
}

export function buildSplitMapping(input: BuildSplitMappingInput): SplitMapping {
  const { providerByMd5, conflicts, unknownDirs } = resolveProviderByMd5(
    input.gitEntries,
    input.dirMembers ?? {},
  );
  const { region } = input;

  const predictBucket = (md5: string): string =>
    generateBucketName(providerByMd5.get(md5) ?? UNMATCHED_SUFFIX, region);

  const resolve: DestResolver = ({ md5, sourceKey }) => ({
    destBucket: predictBucket(md5),
    destKey: sourceKey,
  });

  const buckets = new Set<string>();
  for (const folder of providerByMd5.values()) buckets.add(generateBucketName(folder, region));

  buckets.add(generateBucketName(UNMATCHED_SUFFIX, region));

  return {
    resolve,
    predictBucket,
    destBuckets: [...buckets].sort(),
    conflicts,
    unknownDirs,
    providerByMd5,
  };
}

export interface ExpandDirResult {
  members: Record<string, string[]>;

  dirReadErrors: DirReadError[];
}

export async function expandDirMembers(
  store: ObjectStore,
  bucket: string,
  dirMd5s: readonly string[],
): Promise<ExpandDirResult> {
  const members: Record<string, string[]> = {};
  const dirReadErrors: DirReadError[] = [];

  for (const dirMd5 of dirMd5s) {
    let bytes: Uint8Array | undefined;
    for (const layout of ["v3", "v2"] as const) {
      try {
        bytes = await store.getBytes(bucket, md5ToKey(dirMd5, layout));
        break;
      } catch {}
    }
    if (bytes === undefined) {
      dirReadErrors.push({ dirMd5, error: "not found under v2 or v3 layout" });
      continue;
    }
    try {
      members[dirMd5] = dirMemberMd5s(bytes);
    } catch (err) {
      dirReadErrors.push({ dirMd5, error: (err as Error).message });
    }
  }

  return { members, dirReadErrors };
}
