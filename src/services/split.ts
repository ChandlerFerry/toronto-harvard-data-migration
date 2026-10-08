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

  missingDirs: string[];

  dirReadErrors: DirReadError[];
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NoSuchKey" || name === "NotFound") return true;
  return /^NoSuchKey\b/.test(err instanceof Error ? err.message : String(err));
}

// A .dir absent under both layouts was never pushed: its members stay unrouted and
// the unreferenced gate keeps them in OLD. Any other failure is fatal (dirReadErrors).
export async function expandDirMembers(
  store: ObjectStore,
  bucket: string,
  dirMd5s: readonly string[],
): Promise<ExpandDirResult> {
  const members: Record<string, string[]> = {};
  const missingDirs: string[] = [];
  const dirReadErrors: DirReadError[] = [];

  for (const dirMd5 of new Set(dirMd5s)) {
    let bytes: Uint8Array | undefined;
    let error: string | undefined;
    for (const layout of ["v3", "v2"] as const) {
      try {
        bytes = await store.getBytes(bucket, md5ToKey(dirMd5, layout));
        break;
      } catch (err) {
        if (!isNotFound(err)) {
          error = (err as Error).message;
          break;
        }
      }
    }
    if (error !== undefined) {
      dirReadErrors.push({ dirMd5, error });
      continue;
    }
    if (bytes === undefined) {
      missingDirs.push(dirMd5);
      continue;
    }
    try {
      members[dirMd5] = dirMemberMd5s(bytes);
    } catch (err) {
      dirReadErrors.push({ dirMd5, error: (err as Error).message });
    }
  }

  return { members, missingDirs, dirReadErrors };
}
