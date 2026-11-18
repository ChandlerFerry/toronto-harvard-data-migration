import type { Region } from "../config/sources.js";
import { tryKeyToMd5 } from "../domain/dvcKey.js";
import { folderToSuffix, generateBucketName, isKnownFolder } from "../domain/providerMap.js";
import type { GitDvcEntry } from "../ports/gitHistory.js";

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

export const IGNORED_MD5S: ReadonlySet<string> = new Set([
  "d41d8cd98f00b204e9800998ecf8427e",
  "d751713988987e9331980363e24189ce.dir",
]);

export const CONFLICT_WINNERS: ReadonlyMap<string, string> = new Map([
  // asec.dta, also under CPS
  ["71fbbbf071c852d8e27b37a5e4badf46", "ASEC"],
  // laucnty19.xlsx, also under BLS
  ["b2a19d3a0e7a537576524acaf53bd053", "Local Area Unemployment Statistics"],
  // unadjusted_multiple_job_holders_LNU02026619.csv, also under CPS
  ["4ffa1dad1c1eae6d10fb29963dd27932", "St Louis Fed"],
  // county_covars_atlas.dta, also under Opportunity Atlas
  ["a1a7d15fa800c69dd733cb147dde9b74", "County covariates Atlas"],
  // cps_00037.dta, also under Earnin
  ["703d59bedb4cd14056ade7d804697b93", "CPS"],
  // womply_subcategory_to_naics.dta, also under Crosswalks
  ["f23e9f911d736fdb84bf478fd5e80ab9", "Womply"],
  // womply subcategory x monthly 2020.dta, also under Industry Shares of Consumer Spending and Business Revenues
  ["17348cf575b18ba0de9a7acbd675a67e", "Womply"],
  // naics_2digit_bg_cw.dta, also under Industry Shares of Employment
  ["3b527609483aa593b63ef66ef7f0c1a6", "NAICS Crosswalk"],
]);

export function resolveProviderByMd5(
  gitEntries: readonly GitDvcEntry[],
  dirMembers: Readonly<Record<string, readonly string[]>> = {},
  winners: ReadonlyMap<string, string> = CONFLICT_WINNERS,
): { providerByMd5: Map<string, string>; conflicts: ProviderConflict[]; unknownDirs: string[] } {
  const providerByMd5 = new Map<string, string>();
  const conflictProviders = new Map<string, Set<string>>();
  const unknownDirSet = new Set<string>();

  const assign = (md5: string, provider: string): void => {
    if (IGNORED_MD5S.has(md5)) return;
    const winner = winners.get(md5);
    if (winner !== undefined) {
      providerByMd5.set(md5, winner);
      return;
    }
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
