import { type Region, bucketName } from "../config/sources.js";

export const UNMATCHED_SUFFIX = "public";

export interface ProviderMap {
  folderToSuffix(folder: string): string;

  isKnownFolder(folder: string): boolean;

  generateBucketName(folder: string, region: Region): string;
}

export function normalizeFolder(folder: string): string {
  return folder.trim().toLowerCase();
}

export function createProviderMap(folders: Readonly<Record<string, string>>): ProviderMap {
  const normalized: ReadonlyMap<string, string> = new Map(
    Object.entries(folders).map(([folder, suffix]) => [normalizeFolder(folder), suffix]),
  );
  const folderToSuffix = (folder: string): string =>
    normalized.get(normalizeFolder(folder)) ?? UNMATCHED_SUFFIX;
  return {
    folderToSuffix,
    isKnownFolder: (folder) => normalized.has(normalizeFolder(folder)),
    generateBucketName: (folder, region) => bucketName(folderToSuffix(folder), region),
  };
}
