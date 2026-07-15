import type { Region } from "../config/sources.js";
import { dirMemberMd5s } from "../domain/dirObject.js";
import { tryKeyToMd5 } from "../domain/dvcKey.js";
import { folderToSuffix, generateBucketName, isKnownFolder } from "../domain/providerMap.js";
import type { GitDvcEntry } from "../ports/gitHistory.js";
import type { ObjectStore } from "../ports/objectStore.js";

export interface MappedObject {
  md5: string;
  sourceKey: string;
  provider: string;
  destBucket: string;
}

export interface ProviderConflict {
  md5: string;
  providers: string[];
}

export interface DirReadError {
  dirMd5: string;
  error: string;
}

export interface MappingResult {
  mapped: MappedObject[];

  orphanMd5s: string[];

  unreferencedKeys: string[];

  providerCounts: Record<string, number>;

  conflicts: ProviderConflict[];

  unknownDirs: string[];

  dirReadErrors: DirReadError[];
}

export class MappingValidationError extends Error {
  constructor(public readonly result: MappingResult) {
    const orphans = result.orphanMd5s.length;
    const conflicts = result.conflicts.length;
    const dirErrors = result.dirReadErrors.length;
    super(
      `Mapping invalid: ${orphans} orphan md5(s), ${conflicts} provider conflict(s), ` +
        `${dirErrors} unreadable .dir object(s).`,
    );
    this.name = "MappingValidationError";
  }
}

export interface BuildMappingInput {
  gitEntries: readonly GitDvcEntry[];
  storeKeys: readonly string[];
  region: Region;

  dirMembers?: Readonly<Record<string, readonly string[]>>;

  dirReadErrors?: readonly DirReadError[];
}

const UNREFERENCED_PROVIDER = "public";

export function resolveProviderByMd5(
  gitEntries: readonly GitDvcEntry[],
  dirMembers: Readonly<Record<string, readonly string[]>> = {},
): { providerByMd5: Map<string, string>; conflicts: ProviderConflict[]; unknownDirs: string[] } {
  const providerByMd5 = new Map<string, string>();
  const conflictProviders = new Map<string, Set<string>>();
  const unknownDirSet = new Set<string>();

  const assign = (md5: string, provider: string): void => {
    const current = providerByMd5.get(md5);
    if (current === undefined) {
      providerByMd5.set(md5, provider);
    } else if (current !== provider) {
      const set = conflictProviders.get(md5) ?? new Set<string>([current]);
      set.add(provider);
      conflictProviders.set(md5, set);
    }
  };

  for (const e of gitEntries) {
    assign(e.md5, e.rootDir);
    if (!isKnownFolder(e.rootDir)) unknownDirSet.add(e.rootDir);
  }

  for (const [dirMd5, members] of Object.entries(dirMembers)) {
    const provider = providerByMd5.get(dirMd5);
    if (provider === undefined) continue;
    for (const member of members) assign(member, provider);
  }

  const conflicts: ProviderConflict[] = [...conflictProviders.entries()].map(([md5, set]) => ({
    md5,
    providers: [...set],
  }));
  return { providerByMd5, conflicts, unknownDirs: [...unknownDirSet].sort() };
}

export function buildMapping(input: BuildMappingInput): MappingResult {
  const { providerByMd5, conflicts, unknownDirs } = resolveProviderByMd5(
    input.gitEntries,
    input.dirMembers ?? {},
  );

  const storeMd5 = new Set<string>();
  for (const key of input.storeKeys) {
    const md5 = tryKeyToMd5(key);
    if (md5 !== null) storeMd5.add(md5);
  }

  const mapped: MappedObject[] = [];
  const unreferencedKeys: string[] = [];
  const providerCounts: Record<string, number> = {};

  for (const key of input.storeKeys) {
    const md5 = tryKeyToMd5(key);
    if (md5 === null) continue;
    const provider = providerByMd5.get(md5);
    let folder: string;
    if (provider === undefined) {
      unreferencedKeys.push(key);
      folder = UNREFERENCED_PROVIDER;
    } else {
      folder = provider;
    }
    const destBucket = generateBucketName(folder, input.region);
    mapped.push({ md5, sourceKey: key, provider: folderToSuffix(folder), destBucket });
    providerCounts[destBucket] = (providerCounts[destBucket] ?? 0) + 1;
  }

  const orphanMd5s: string[] = [];
  for (const md5 of providerByMd5.keys()) {
    if (!storeMd5.has(md5)) orphanMd5s.push(md5);
  }

  return {
    mapped,
    orphanMd5s,
    unreferencedKeys,
    providerCounts,
    conflicts,
    unknownDirs,
    dirReadErrors: [...(input.dirReadErrors ?? [])],
  };
}

export function assertMappingValid(result: MappingResult): void {
  if (
    result.orphanMd5s.length > 0 ||
    result.conflicts.length > 0 ||
    result.dirReadErrors.length > 0
  ) {
    throw new MappingValidationError(result);
  }
}

export interface ResolveDirMembersResult {
  members: Record<string, string[]>;

  dirReadErrors: DirReadError[];
}

export async function resolveDirMembers(
  store: ObjectStore,
  bucket: string,
  storeKeys: readonly string[],
  dirMd5s: readonly string[],
): Promise<ResolveDirMembersResult> {
  const keyByMd5 = new Map<string, string>();
  for (const key of storeKeys) {
    const md5 = tryKeyToMd5(key);
    if (md5 !== null) keyByMd5.set(md5, key);
  }

  const members: Record<string, string[]> = {};
  const dirReadErrors: DirReadError[] = [];
  for (const dirMd5 of dirMd5s) {
    const key = keyByMd5.get(dirMd5);
    if (key === undefined) continue;
    try {
      const bytes = await store.getBytes(bucket, key);
      members[dirMd5] = dirMemberMd5s(bytes);
    } catch (err) {
      dirReadErrors.push({ dirMd5, error: (err as Error).message });
    }
  }
  return { members, dirReadErrors };
}
